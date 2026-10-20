// Screenshot fields for the application form: up to 30 upload fields, each holding
// one screenshot of a product selected from the shop (JPEG, PNG or WebP), with
// local previews from IndexedDB and per-file progress states.
//
// Applicants do not enter product names, descriptions, or links — the screenshots
// are the submission. Structural changes (add/remove field, add/remove photo)
// re-render the affected nodes immediately; upload status changes refresh the
// individual chip in place so focus is preserved. Every action gives visible
// feedback (chip status, count labels, notice toasts).

import { el, clearNode } from '../utils/dom.js';
import { formatBytes } from '../utils/format.js';
import { putImage, getImage, deleteImage } from '../utils/idb.js';

const MAX_PRODUCTS_DEFAULT = 30;
const MAX_FILES_PER_PRODUCT = 1; // one screenshot per upload field (30 fields = 30 images)
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

let localIdCounter = 0;
function nextLocalId(prefix) {
  localIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${localIdCounter}`;
}

// Some browsers report "image/jpg" or an empty type — normalise to the real MIME
// so validation, previews, and the server pipeline all agree.
function normalizeImageType(file) {
  let type = String(file?.type || '').toLowerCase().trim();
  if (!type) {
    const ext = String(file?.name || '').split('.').pop()?.toLowerCase() || '';
    if (ext === 'jpg' || ext === 'jpeg') type = 'image/jpeg';
    else if (ext === 'png') type = 'image/png';
    else if (ext === 'webp') type = 'image/webp';
  }
  if (type === 'image/jpg') type = 'image/jpeg';
  return type;
}

function acceptAttr(acceptedTypes) {
  const exts = [];
  if (acceptedTypes.includes('image/jpeg')) exts.push('.jpg', '.jpeg');
  if (acceptedTypes.includes('image/png')) exts.push('.png');
  if (acceptedTypes.includes('image/webp')) exts.push('.webp');
  return [...acceptedTypes, ...exts].join(',');
}

// A field the applicant never filled in — harmless placeholder, skipped by
// validation and left out of the submission payload.
export function isEmptySlot(product) {
  const files = product?.files || [];
  return (
    files.length === 0 &&
    !(product?.name || '').trim() &&
    !(product?.url || '').trim() &&
    !(product?.variant || '').trim() &&
    !(product?.notes || '').trim()
  );
}

// Screenshots that were uploaded successfully (and therefore get submitted).
export function hasReadyScreenshot(product) {
  return (product?.files || []).some((file) => file.status === 'ready' && file.path);
}

export function createEmptyProduct() {
  return {
    localId: nextLocalId('p'),
    name: '',
    url: '',
    variant: '',
    notes: '',
    files: [],
  };
}

export function createEmptyFile() {
  return {
    localId: nextLocalId('f'),
    file: null,
    path: '',
    token: '',
    mime: '',
    size: 0,
    sha256: '',
    originalName: '',
    status: 'idle', // idle | hashing | uploading | ready | error
    error: '',
    previewUrl: '',
  };
}

export function validateProduct(product, { imagesEnabled = true } = {}) {
  const errors = [];
  const files = product.files || [];
  const readyFiles = files.filter((f) => f.status === 'ready');

  if (imagesEnabled !== false && readyFiles.length === 0) {
    errors.push('Upload a screenshot for this field, or remove the field.');
  }
  for (const file of files) {
    if (file.status === 'error') {
      errors.push(`Screenshot "${file.originalName || 'upload'}" did not upload — ${file.error || 'please try again.'}`);
    }
    if (file.status === 'uploading' || file.status === 'hashing') {
      errors.push('Please wait for the screenshot upload to finish.');
      break;
    }
  }
  return errors;
}

export function validateProductList(products, settings = {}) {
  const min = Number(settings.min_products) || 0;
  const max = Math.min(Number(settings.max_products) || MAX_PRODUCTS_DEFAULT, MAX_PRODUCTS_DEFAULT);
  const imagesEnabled = settings.product_image_enabled !== false;
  const filled = (products || []).filter((product) => !isEmptySlot(product));
  const errors = [];
  if (filled.length > max) errors.push(`You can upload at most ${max} screenshots.`);
  if (filled.length < min) errors.push(`Please add at least ${min} screenshot${min === 1 ? '' : 's'}.`);
  filled.forEach((product, index) => {
    for (const message of validateProduct(product, { imagesEnabled })) {
      errors.push(`Screenshot ${index + 1}: ${message}`);
    }
  });
  return errors;
}

async function computeSha256(file) {
  try {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return '';
  }
}

/**
 * Creates the screenshot field grid bound to wizard state.
 *
 * options:
 *   state        – wizard state ({ products: [], settings: {} })
 *   onChange     – () => void, called after any mutation (for draft saving)
 *   uploadFile   – async ({file, contentType, uploadToken}) =>
 *                    ({path, token, mime, size, uploadToken})
 *   maxProducts  – number of upload fields (max 30)
 *   acceptedTypes – string[] of MIME types
 */
export function createProductGrid({ state, onChange, uploadFile, maxProducts = MAX_PRODUCTS_DEFAULT, acceptedTypes = ACCEPTED }) {
  const grid = el('div', { class: 'product-grid', role: 'group', 'aria-label': 'Screenshot uploads' });
  const notice = el('div', { class: 'product-grid__notice', hidden: true });

  // Live node maps so status changes can swap one chip without re-rendering the
  // card (keeps focus while uploads finish).
  const sectionNodes = new Map(); // product.localId -> files section element
  const chipNodes = new Map(); // file.localId -> { node, rebuild }

  const imagesEnabled = () => state.settings?.product_image_enabled !== false;
  const blobKey = (fileState) => `${state.uploadToken || 'anon'}:${fileState.localId}`;
  const filledCount = () => state.products.filter((product) => !isEmptySlot(product)).length;

  let countNode = null;
  function refreshCount() {
    if (countNode) countNode.textContent = `${filledCount()} of ${maxProducts} screenshots`;
  }

  function setStatus(product, fileState, status, error = '') {
    fileState.status = status;
    fileState.error = error;
    refreshChip(fileState);
    onChange();
  }

  function refreshChip(fileState) {
    const entry = chipNodes.get(fileState.localId);
    if (!entry || !entry.node.parentNode) return;
    const fresh = entry.rebuild();
    entry.node.replaceWith(fresh);
    entry.node = fresh;
  }

  function rebuildFiles(product) {
    const current = sectionNodes.get(product.localId);
    const index = state.products.indexOf(product);
    if (!current || !current.parentNode || index < 0) return;
    const fresh = buildFilesSection(product, index);
    current.replaceWith(fresh);
  }

  function pushToastLike(message, kind = '') {
    notice.textContent = message;
    notice.className = `product-grid__notice${kind ? ` product-grid__notice--${kind}` : ''}`;
    notice.hidden = false;
    window.clearTimeout(pushToastLike.timer);
    pushToastLike.timer = window.setTimeout(() => {
      notice.hidden = true;
    }, 6000);
  }

  async function startUpload(product, fileState) {
    const raw = fileState.file;
    if (!raw) return;
    try {
      setStatus(product, fileState, 'hashing');
      fileState.sha256 = await computeSha256(raw);
      setStatus(product, fileState, 'uploading');
      const result = await uploadFile({
        file: raw,
        contentType: fileState.mime,
        uploadToken: state.uploadToken,
      });
      fileState.path = result.path;
      fileState.token = result.token;
      fileState.mime = result.mime || fileState.mime;
      fileState.size = result.size || fileState.size;
      state.uploadToken = result.uploadToken || state.uploadToken;
      setStatus(product, fileState, 'ready');
      pushToastLike(`Screenshot "${fileState.originalName || 'image'}" uploaded.`, 'success');
    } catch (error) {
      console.error('upload failed', error);
      setStatus(product, fileState, 'error', error?.message || 'Upload failed. Please try again.');
      pushToastLike(`Upload failed for "${fileState.originalName || 'screenshot'}" — ${error?.message || 'please try again.'}`, 'error');
    }
  }

  async function handleFiles(product, fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let added = 0;
    for (const raw of files) {
      const type = normalizeImageType(raw);
      if (!acceptedTypes.includes(type)) {
        pushToastLike(`"${raw.name}" is not a supported image type. Use JPEG, PNG, or WebP.`, 'error');
        continue;
      }
      if (product.files.length >= MAX_FILES_PER_PRODUCT) {
        pushToastLike('Each field holds one screenshot — add another screenshot field below.', 'error');
        break;
      }
      const fileState = createEmptyFile();
      fileState.file = raw;
      fileState.mime = type;
      fileState.size = raw.size;
      fileState.originalName = raw.name;
      fileState.previewUrl = URL.createObjectURL(raw);
      product.files.push(fileState);
      added += 1;

      // persist the blob for draft restore
      putImage(blobKey(fileState), raw).catch(() => {});

      startUpload(product, fileState);
    }
    if (added) {
      rebuildFiles(product);
      refreshCount();
      onChange();
    }
  }

  function replaceFile(product, fileState, raw) {
    const type = normalizeImageType(raw);
    if (!acceptedTypes.includes(type)) {
      pushToastLike(`"${raw.name}" is not a supported image type. Use JPEG, PNG, or WebP.`, 'error');
      return;
    }
    if (fileState.previewUrl) URL.revokeObjectURL(fileState.previewUrl);
    deleteImage(blobKey(fileState)).catch(() => {});
    fileState.file = raw;
    fileState.mime = type;
    fileState.size = raw.size;
    fileState.originalName = raw.name;
    fileState.previewUrl = URL.createObjectURL(raw);
    fileState.path = '';
    fileState.token = '';
    fileState.sha256 = '';
    fileState.status = 'idle';
    fileState.error = '';
    putImage(blobKey(fileState), raw).catch(() => {});
    refreshChip(fileState);
    onChange();
    startUpload(product, fileState);
  }

  function removeFile(product, fileState) {
    const index = product.files.indexOf(fileState);
    if (index >= 0) product.files.splice(index, 1);
    if (fileState.previewUrl) URL.revokeObjectURL(fileState.previewUrl);
    deleteImage(blobKey(fileState)).catch(() => {});
    chipNodes.delete(fileState.localId);
    rebuildFiles(product);
    refreshCount();
    onChange();
    pushToastLike('Screenshot removed.');
  }

  function renderFileChip(product, fileState, productIndex) {
    const chip = el('div', {
      class: `file-chip file-chip--${fileState.status}`,
      'data-status': fileState.status,
      'data-file': fileState.localId,
    });

    const thumbWrap = el('div', { class: 'file-chip__thumb' });
    if (fileState.previewUrl) {
      thumbWrap.append(el('img', { src: fileState.previewUrl, alt: '', class: 'file-chip__img' }));
    } else {
      thumbWrap.append(el('span', { class: 'file-chip__placeholder', text: 'IMG' }));
    }
    chip.append(thumbWrap);

    const meta = el('div', { class: 'file-chip__meta' });
    meta.append(el('span', { class: 'file-chip__name', text: fileState.originalName || 'image' }));
    const statusText =
      fileState.status === 'ready' ? 'Uploaded' :
      fileState.status === 'uploading' ? 'Uploading…' :
      fileState.status === 'hashing' ? 'Preparing…' :
      fileState.status === 'error' ? (fileState.error || 'Failed') : 'Pending';
    meta.append(el('span', { class: 'file-chip__status', text: `${statusText} · ${formatBytes(fileState.size)}` }));
    if (fileState.status === 'uploading' || fileState.status === 'hashing') {
      meta.append(el('div', { class: 'upload-bar upload-bar--indeterminate', role: 'progressbar', 'aria-label': 'Upload progress' }, [
        el('div', { class: 'upload-bar__fill' }),
      ]));
    }
    chip.append(meta);

    const actions = el('div', { class: 'file-chip__actions' });
    if (fileState.status === 'error' && fileState.file) {
      actions.append(
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm',
          text: 'Try again',
          'aria-label': `Try uploading ${fileState.originalName || 'screenshot'} again`,
          onClick: () => startUpload(product, fileState),
        }),
      );
    }
    if (fileState.file) {
      const replaceId = `replace-${fileState.localId}`;
      const replaceInput = el('input', {
        id: replaceId,
        type: 'file',
        accept: acceptAttr(acceptedTypes),
        class: 'visually-hidden',
      });
      replaceInput.addEventListener('change', () => {
        const raw = replaceInput.files && replaceInput.files[0];
        replaceInput.value = '';
        if (raw) replaceFile(product, fileState, raw);
      });
      actions.append(
        el('label', {
          class: 'btn btn--ghost btn--sm file-chip__replace',
          for: replaceId,
          text: 'Replace',
          'aria-label': `Replace ${fileState.originalName || 'screenshot'}`,
        }),
        replaceInput,
      );
    }
    actions.append(
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm file-chip__remove',
        text: 'Remove',
        'aria-label': `Remove ${fileState.originalName || 'screenshot'} from screenshot ${productIndex + 1}`,
        onClick: () => removeFile(product, fileState),
      }),
    );
    chip.append(actions);
    return chip;
  }

  function buildFilesSection(product, productIndex) {
    const wrap = el('div', { class: 'product-card__files', 'data-files-for': product.localId });
    wrap.append(el('span', { class: 'field__label', text: 'Screenshot' }));

    const chips = el('div', { class: 'file-chips' });
    product.files.forEach((fileState) => {
      const chip = renderFileChip(product, fileState, productIndex);
      chipNodes.set(fileState.localId, {
        node: chip,
        rebuild: () => renderFileChip(product, fileState, productIndex),
      });
      chips.append(chip);
    });
    wrap.append(chips);

    if (product.files.length < MAX_FILES_PER_PRODUCT) {
      const inputId = `product-${product.localId}-files`;
      const fileInput = el('input', {
        id: inputId,
        type: 'file',
        accept: acceptAttr(acceptedTypes),
        class: 'visually-hidden',
      });
      if (MAX_FILES_PER_PRODUCT > 1) fileInput.setAttribute('multiple', '');
      fileInput.addEventListener('change', () => {
        handleFiles(product, fileInput.files);
        fileInput.value = '';
      });
      wrap.append(
        el('label', {
          class: 'btn btn--secondary btn--sm file-upload-label',
          for: inputId,
          text: 'Upload screenshot',
        }),
        fileInput,
        el('p', {
          class: 'field__help',
          text: 'Upload a clear screenshot taken directly from the shop product page — JPEG, PNG or WebP.',
        }),
      );
    }

    sectionNodes.set(product.localId, wrap);
    return wrap;
  }

  function renderProductCard(product, index) {
    const card = el('article', { class: 'product-card', 'data-product': product.localId });

    const header = el('header', { class: 'product-card__header' }, [
      el('span', { class: 'product-card__number', text: String(index + 1) }),
      el('h3', { class: 'product-card__title', tabindex: '-1', text: `Screenshot ${index + 1}` }),
    ]);
    if (state.products.length > (Number(state.settings?.min_products) || 0)) {
      header.append(
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm',
          text: 'Remove',
          'aria-label': `Remove screenshot field ${index + 1}`,
          onClick: () => {
            const at = state.products.indexOf(product);
            if (at >= 0) state.products.splice(at, 1);
            product.files.forEach((f) => {
              if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
              deleteImage(blobKey(f)).catch(() => {});
            });
            render();
            onChange();
          },
        }),
      );
    }
    card.append(header);

    const body = el('div', { class: 'product-card__body' });
    if (imagesEnabled()) body.append(buildFilesSection(product, index));
    card.append(body);
    return card;
  }

  function render() {
    clearNode(grid);
    chipNodes.clear();
    sectionNodes.clear();
    grid.append(notice);

    const canAdd = state.products.length < maxProducts;
    const addRow = el('div', { class: 'product-grid__add' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--secondary',
        text: '+ Add screenshot',
        disabled: !canAdd,
        onClick: () => {
          const product = createEmptyProduct();
          state.products.push(product);
          render();
          onChange();
          const card = grid.querySelector(`[data-product="${product.localId}"]`);
          const heading = card && card.querySelector('.product-card__title');
          if (heading) heading.focus();
        },
      }),
      el('p', {
        class: 'product-grid__count',
        text: `${filledCount()} of ${maxProducts} screenshots`,
      }),
    ]);
    countNode = addRow.querySelector('.product-grid__count');
    grid.append(addRow);

    if (state.products.length === 0) {
      grid.append(
        el('div', { class: 'empty-state' }, [
          el('p', { class: 'empty-state__title', text: 'No screenshots yet' }),
          el('p', {
            class: 'empty-state__text',
            text: 'Add a screenshot field, then upload a clear screenshot of a product you have selected directly from the shop product page.',
          }),
        ]),
      );
    } else {
      state.products.forEach((product, index) => {
        grid.append(renderProductCard(product, index));
      });
    }
  }

  return {
    element: grid,
    render,
    validate() {
      return validateProductList(state.products, state.settings || {});
    },
    showErrors(errors) {
      if (!errors.length) {
        notice.hidden = true;
        return;
      }
      notice.textContent = errors[0];
      notice.className = 'product-grid__notice product-grid__notice--error';
      notice.hidden = false;
    },
    async restoreBlobs() {
      // Reload previously staged blobs from IndexedDB for draft restore.
      const token = state.uploadToken;
      if (!token) return;
      for (const product of state.products) {
        for (const fileState of product.files) {
          if (fileState.previewUrl) continue;
          const blob = await getImage(`${token}:${fileState.localId}`);
          if (blob) {
            fileState.file = blob;
            fileState.previewUrl = URL.createObjectURL(blob);
          }
        }
      }
      render();
    },
    destroy() {
      state.products.forEach((product) => {
        product.files.forEach((fileState) => {
          if (fileState.previewUrl) URL.revokeObjectURL(fileState.previewUrl);
        });
      });
    },
  };
}

export { MAX_FILES_PER_PRODUCT, ACCEPTED as ACCEPTED_IMAGE_TYPES };
