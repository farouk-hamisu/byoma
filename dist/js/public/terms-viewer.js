// Professional Terms & Conditions PDF viewer (modal).
// Uses a pinned pdf.js build when available and falls back to the browser's native
// PDF rendering inside the modal. Viewing never implies consent — the caller decides.

import { el, clearNode, trapFocus } from '../utils/dom.js';
import { getTermsDocumentUrl } from './api.js';
import { proxiedUrl } from '../supabase.js';

const PDFJS_MODULE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

let pdfjsPromise = null;

async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_MODULE)
      .then((module) => {
        const lib = module.default || module;
        if (lib?.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        if (!lib?.getDocument) throw new Error('pdfjs_unavailable');
        return lib;
      })
      .catch((error) => {
        pdfjsPromise = null;
        throw error;
      });
  }
  return pdfjsPromise;
}

/**
 * Opens the Terms & Conditions viewer.
 * Resolves when the modal closes with:
 *   { opened: boolean, document: {id, version, sha256, title, url} | null, openedAt: string|null }
 */
export function openTermsViewer({ title = 'Terms & Conditions', fetchDocument = null } = {}) {
  return new Promise((resolvePromise) => {
    const previousFocus = document.activeElement;
    const state = {
      pdf: null,
      pageNum: 1,
      scale: 1.15,
      renderTask: null,
      document: null,
      opened: false,
      aborted: false,
      usingFallback: false,
    };

    const titleId = `terms-viewer-title-${Math.random().toString(36).slice(2, 8)}`;

    const closeButton = el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm',
      'aria-label': 'Close Terms and Conditions viewer',
      text: 'Close',
      onClick: () => close(),
    });

    const prevButton = el('button', {
      type: 'button',
      class: 'btn btn--secondary btn--sm',
      text: 'Previous',
      'aria-label': 'Previous page',
      onClick: () => changePage(-1),
    });
    const nextButton = el('button', {
      type: 'button',
      class: 'btn btn--secondary btn--sm',
      text: 'Next',
      'aria-label': 'Next page',
      onClick: () => changePage(1),
    });
    const pageIndicator = el('span', { class: 'pdf-viewer__page-indicator', text: '—', 'aria-live': 'polite' });
    const zoomOut = el('button', {
      type: 'button',
      class: 'btn btn--secondary btn--sm',
      text: '−',
      'aria-label': 'Zoom out',
      onClick: () => changeZoom(-0.2),
    });
    const zoomIn = el('button', {
      type: 'button',
      class: 'btn btn--secondary btn--sm',
      text: '+',
      'aria-label': 'Zoom in',
      onClick: () => changeZoom(0.2),
    });
    const zoomLabel = el('span', { class: 'pdf-viewer__page-indicator', text: '100%' });

    const downloadLink = el('a', {
      class: 'btn btn--secondary btn--sm',
      text: 'Download',
      download: 'terms-and-conditions.pdf',
      target: '_blank',
      rel: 'noopener noreferrer',
      hidden: true,
    });
    const openLink = el('a', {
      class: 'btn btn--ghost btn--sm',
      text: 'Open in new tab',
      target: '_blank',
      rel: 'noopener noreferrer',
      hidden: true,
    });

    let statusRegion = el('div', {
      class: 'pdf-viewer__status',
      role: 'status',
      'aria-live': 'polite',
      text: 'Loading…',
    });

    const canvasWrap = el('div', { class: 'pdf-viewer__canvas-wrap' }, [statusRegion]);
    const canvas = el('canvas', { hidden: true, 'aria-label': 'Terms and Conditions document' });

    const toolbar = el('div', { class: 'pdf-viewer__toolbar' }, [
      closeButton,
      el('span', { class: 'spacer' }),
      prevButton,
      pageIndicator,
      nextButton,
      el('span', { class: 'spacer' }),
      zoomOut,
      zoomLabel,
      zoomIn,
      downloadLink,
      openLink,
    ]);

    const viewerBody = el('div', { class: 'pdf-viewer' }, [toolbar, canvasWrap]);

    const dialog = el(
      'div',
      {
        class: 'modal modal--wide',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
      },
      [
        el('div', { class: 'modal__header' }, [
          el('h2', { class: 'modal__title', id: titleId, text: title }),
          el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--sm',
            text: 'Close',
            'aria-label': 'Close dialog',
            onClick: () => close(),
          }),
        ]),
        viewerBody,
      ],
    );

    const backdrop = el('div', { class: 'modal-backdrop' }, [dialog]);
    let releaseTrap = null;

    function setControlsEnabled(enabled) {
      [prevButton, nextButton, zoomOut, zoomIn].forEach((button) => {
        button.disabled = !enabled;
      });
    }

    function showError(message, { retry = true } = {}) {
      clearNode(canvasWrap);
      const block = el('div', { class: 'pdf-viewer__status' }, [
        el('p', { text: message }),
      ]);
      if (retry) {
        block.append(
          el('button', {
            type: 'button',
            class: 'btn btn--secondary btn--sm',
            text: 'Try again',
            onClick: () => load(),
          }),
        );
      }
      canvasWrap.append(block);
      setControlsEnabled(false);
      downloadLink.hidden = true;
      openLink.hidden = true;
    }

    function updateControls() {
      const pages = state.pdf?.numPages || 0;
      pageIndicator.textContent = pages ? `Page ${state.pageNum} of ${pages}` : '—';
      zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
      prevButton.disabled = !pages || state.pageNum <= 1;
      nextButton.disabled = !pages || state.pageNum >= pages;
      zoomOut.disabled = !pages || state.scale <= 0.5;
      zoomIn.disabled = !pages || state.scale >= 4;
    }

    async function renderPage() {
      if (!state.pdf || state.aborted) return;
      if (state.renderTask) {
        try {
          state.renderTask.cancel();
        } catch {
          /* ignore */
        }
        state.renderTask = null;
      }

      const page = await state.pdf.getPage(state.pageNum);
      if (state.aborted) return;
      const viewport = page.getViewport({ scale: state.scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      canvas.hidden = false;
      const context = canvas.getContext('2d');
      state.renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      try {
        await state.renderTask.promise;
      } catch (error) {
        if (error?.name !== 'RenderingCancelledException') throw error;
      } finally {
        state.renderTask = null;
      }
      updateControls();
    }

    async function changePage(delta) {
      if (!state.pdf) return;
      const next = state.pageNum + delta;
      if (next < 1 || next > state.pdf.numPages) return;
      state.pageNum = next;
      updateControls();
      canvasWrap.scrollTop = 0;
      try {
        await renderPage();
      } catch (error) {
        console.error('page render failed', error);
        showError('This page could not be displayed.');
      }
    }

    async function changeZoom(delta) {
      if (!state.pdf) return;
      state.scale = Math.min(4, Math.max(0.5, Math.round((state.scale + delta) * 10) / 10));
      updateControls();
      try {
        await renderPage();
      } catch (error) {
        console.error('zoom render failed', error);
        showError('This page could not be displayed.');
      }
    }

    function useFallback(reason) {
      state.usingFallback = true;
      state.usingFallback = state.usingFallback;
      clearNode(canvasWrap);
      const iframe = el('iframe', {
        class: 'pdf-viewer__fallback',
        title: title,
        src: `${proxiedUrl(state.document.url)}#toolbar=1&view=FitH`,
      });
      canvasWrap.append(iframe);
      setControlsEnabled(false);
      pageIndicator.textContent = 'Document';
      zoomLabel.textContent = '—';
      if (reason) console.warn('PDF viewer fallback:', reason);
    }

    async function load() {
      setControlsEnabled(false);
      downloadLink.hidden = true;
      openLink.hidden = true;
      state.opened = false;
      clearNode(canvasWrap);
      statusRegion = el('div', {
        class: 'pdf-viewer__status',
        role: 'status',
        'aria-live': 'polite',
        text: 'Loading…',
      });
      canvasWrap.append(statusRegion);

      try {
        const documentInfo = fetchDocument ? await fetchDocument() : await getTermsDocumentUrl();
        if (state.aborted) return;
        if (!documentInfo?.url || !documentInfo?.available) {
          showError(
            'The Terms and Conditions document is not available right now. Please try again later.',
            { retry: true },
          );
          return;
        }
        state.document = documentInfo;
        const docUrl = proxiedUrl(documentInfo.url);
        downloadLink.href = docUrl;
        downloadLink.hidden = false;
        openLink.href = docUrl;
        openLink.hidden = false;

        state.opened = true;

        let pdfjs;
        try {
          pdfjs = await loadPdfJs();
        } catch (error) {
          useFallback(error);
          return;
        }

        const controller = new AbortController();
        state.abortController = controller;
        const response = await fetch(docUrl, { signal: controller.signal });
        if (!response.ok) throw new Error(`document_fetch_${response.status}`);
        const bytes = await response.arrayBuffer();
        if (state.aborted) return;

        const task = pdfjs.getDocument({ data: bytes });
        state.pdf = await task.promise;
        if (state.aborted) return;

        state.pageNum = 1;
        clearNode(canvasWrap);
        canvasWrap.append(canvas);
        updateControls();
        await renderPage();
      } catch (error) {
        if (state.aborted) return;
        if (state.document?.url && (error?.name === 'TypeError' || String(error?.message || '').includes('document_fetch'))) {
          // Network/CORS issues: native rendering still works in an iframe.
          useFallback(error?.message || error);
          return;
        }
        console.error('terms viewer load failed', error);
        showError('We could not load the document. Please check your connection and try again.');
      }
    }

    function close() {
      if (state.aborted) return;
      state.aborted = true;
      state.abortController?.abort();
      if (state.renderTask) {
        try {
          state.renderTask.cancel();
        } catch {
          /* ignore */
        }
      }
      state.pdf?.destroy?.();
      backdrop.remove();
      document.body.style.removeProperty('overflow');
      releaseTrap?.();
      document.removeEventListener('keydown', onKeydown);

      resolvePromise({
        opened: state.opened,
        document: state.document
          ? {
              id: state.document.id,
              version: state.document.version,
              sha256: state.document.sha256 || null,
              title: state.document.title || title,
            }
          : null,
        openedAt: state.opened ? new Date().toISOString() : null,
        fallback: state.usingFallback,
      });

      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    }

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'ArrowRight' && state.pdf && !state.usingFallback) {
        changePage(1);
      } else if (event.key === 'ArrowLeft' && state.pdf && !state.usingFallback) {
        changePage(-1);
      }
    }

    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) close();
    });
    document.addEventListener('keydown', onKeydown);
    document.body.style.overflow = 'hidden';
    document.body.append(backdrop);
    releaseTrap = trapFocus(dialog);
    closeButton.focus();

    setControlsEnabled(false);
    load();
  });
}
