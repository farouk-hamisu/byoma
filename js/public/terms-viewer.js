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
      document: null,
      opened: false,
      aborted: false,
      usingFallback: false,
      // One entry per document page. All pages live in the scroll container so
      // users can scroll straight through the document; only the pages near the
      // viewport are rasterised, and their bitmaps are released again when far
      // away so long documents stay memory-safe.
      pages: [],
      renderQueue: Promise.resolve(),
      renderObserver: null,
      evictObserver: null,
      scrollRaf: 0,
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
      onClick: () => goToPage(state.pageNum - 1),
    });
    const nextButton = el('button', {
      type: 'button',
      class: 'btn btn--secondary btn--sm',
      text: 'Next',
      'aria-label': 'Next page',
      onClick: () => goToPage(state.pageNum + 1),
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
      teardownPages();
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

    /* --------------------------------------------------- scrollable pages */

    function prefersReducedMotion() {
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function pageEntryFor(node) {
      const index = Number(node?.dataset?.page);
      return Number.isInteger(index) ? state.pages[index - 1] || null : null;
    }

    function cancelEntryRender(entry) {
      if (!entry.renderTask) return;
      try {
        entry.renderTask.cancel();
      } catch {
        /* ignore */
      }
      entry.renderTask = null;
    }

    // Release a page's bitmap while keeping its placeholder box, so the layout
    // (and therefore scroll position) never shifts as pages load.
    function resetEntry(entry) {
      cancelEntryRender(entry);
      entry.canvas.width = 0;
      entry.canvas.height = 0;
      entry.rendered = false;
      entry.wrapper.classList.add('pdf-viewer__page--pending');
    }

    function applyEntrySize(entry, scale) {
      const viewport = entry.page.getViewport({ scale });
      const cssWidth = Math.max(1, Math.floor(viewport.width));
      const cssHeight = Math.max(1, Math.floor(viewport.height));
      entry.canvas.style.width = `${cssWidth}px`;
      // aspect-ratio (instead of a fixed inline height) keeps the page from
      // distorting when `max-width: 100%` clamps it on narrow screens.
      entry.canvas.style.aspectRatio = `${cssWidth} / ${cssHeight}`;
    }

    async function renderEntry(entry) {
      if (state.aborted || entry.rendered || !state.pdf) return;
      cancelEntryRender(entry);
      const viewport = entry.page.getViewport({ scale: state.scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = entry.canvas;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      const task = entry.page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      entry.renderTask = task;
      try {
        await task.promise;
        if (state.aborted) return;
        entry.rendered = true;
        entry.wrapper.classList.remove('pdf-viewer__page--pending');
      } catch (error) {
        if (error?.name !== 'RenderingCancelledException') {
          console.error('page render failed', error);
        }
      } finally {
        entry.renderTask = null;
      }
    }

    // Renders are serialised so a fast scroll cannot fan out dozens of
    // concurrent raster jobs; entries that scrolled out of range are skipped.
    function scheduleRender(entry) {
      if (entry.queued || entry.rendered || state.aborted) return;
      entry.queued = true;
      state.renderQueue = state.renderQueue.catch(() => {}).then(async () => {
        entry.queued = false;
        if (state.aborted || entry.rendered || !entry.visible) return;
        await renderEntry(entry);
      });
    }

    function teardownPages() {
      state.renderObserver?.disconnect();
      state.evictObserver?.disconnect();
      state.renderObserver = null;
      state.evictObserver = null;
      canvasWrap.removeEventListener('scroll', onWrapScroll);
      if (state.scrollRaf) cancelAnimationFrame(state.scrollRaf);
      state.scrollRaf = 0;
      for (const entry of state.pages) {
        entry.visible = false;
        entry.queued = false;
        resetEntry(entry);
      }
      state.pages = [];
    }

    function observePages() {
      if (!('IntersectionObserver' in window)) {
        // Without observers, render everything once rather than showing blanks.
        state.pages.forEach((entry) => {
          entry.visible = true;
          scheduleRender(entry);
        });
        return;
      }
      // Two bands with a gap between them (600px to render, 1600px to release)
      // so a page resting near a boundary is neither re-rendered nor released on
      // every small scroll — no flicker, no render loops.
      state.renderObserver = new IntersectionObserver(
        (observed) => {
          for (const item of observed) {
            const entry = pageEntryFor(item.target);
            if (!entry) continue;
            entry.visible = item.isIntersecting;
            if (item.isIntersecting) scheduleRender(entry);
          }
        },
        { root: canvasWrap, rootMargin: '600px 0px', threshold: 0 },
      );
      state.evictObserver = new IntersectionObserver(
        (observed) => {
          for (const item of observed) {
            if (item.isIntersecting) continue;
            const entry = pageEntryFor(item.target);
            if (entry && entry.rendered) resetEntry(entry);
          }
        },
        { root: canvasWrap, rootMargin: '1600px 0px', threshold: 0 },
      );
      for (const entry of state.pages) {
        state.renderObserver.observe(entry.wrapper);
        state.evictObserver.observe(entry.wrapper);
      }
    }

    // The toolbar's page indicator follows the page nearest the top of the
    // viewport, so it always matches what the user is looking at.
    function syncCurrentPage() {
      if (!state.pages.length) return;
      const wrapRect = canvasWrap.getBoundingClientRect();
      const line = wrapRect.top + Math.min(wrapRect.height * 0.3, 140);
      let current = null;
      let bestDistance = Infinity;
      for (const entry of state.pages) {
        const rect = entry.wrapper.getBoundingClientRect();
        if (rect.top <= line && rect.bottom > line) {
          current = entry.index;
          break;
        }
        const distance = Math.abs(rect.top - line);
        if (distance < bestDistance) {
          bestDistance = distance;
          current = entry.index;
        }
      }
      if (current === null) current = state.pages[0].index;
      if (current !== state.pageNum) {
        state.pageNum = current;
        markCurrentPage();
        updateControls();
      }
    }

    function onWrapScroll() {
      if (state.scrollRaf) return;
      state.scrollRaf = requestAnimationFrame(() => {
        state.scrollRaf = 0;
        syncCurrentPage();
      });
    }

    function markCurrentPage() {
      for (const entry of state.pages) {
        const isCurrent = entry.index === state.pageNum;
        if (isCurrent) {
          entry.wrapper.setAttribute('data-current', '');
          entry.wrapper.setAttribute('aria-current', 'page');
        } else {
          entry.wrapper.removeAttribute('data-current');
          entry.wrapper.removeAttribute('aria-current');
        }
      }
    }

    // Previous / Next (and arrow keys) scroll to a page instead of swapping a
    // single canvas — scrolling and buttons address the same document.
    function goToPage(index) {
      if (!state.pages.length) return;
      const target = Math.min(Math.max(1, index), state.pages.length);
      const entry = state.pages[target - 1];
      if (!entry) return;
      state.pageNum = target;
      markCurrentPage();
      updateControls();
      const wrapRect = canvasWrap.getBoundingClientRect();
      const rect = entry.wrapper.getBoundingClientRect();
      const paddingTop = parseFloat(getComputedStyle(canvasWrap).paddingTop) || 0;
      const top = canvasWrap.scrollTop + (rect.top - wrapRect.top) - paddingTop;
      canvasWrap.scrollTo({
        top: Math.max(0, top),
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }

    async function buildPages() {
      teardownPages();
      clearNode(canvasWrap);
      const layer = el('div', { class: 'pdf-viewer__pages' });
      canvasWrap.append(layer);
      const total = state.pdf.numPages;
      for (let index = 1; index <= total; index += 1) {
        const page = await state.pdf.getPage(index);
        if (state.aborted) return;
        const wrapper = el('div', {
          class: 'pdf-viewer__page pdf-viewer__page--pending',
          'data-page': String(index),
        });
        const canvas = el('canvas', {
          class: 'pdf-viewer__page-canvas',
          'aria-label': `Terms and Conditions — page ${index} of ${total}`,
        });
        const entry = {
          index,
          wrapper,
          canvas,
          page,
          visible: false,
          queued: false,
          rendered: false,
          renderTask: null,
        };
        applyEntrySize(entry, state.scale);
        wrapper.append(canvas);
        layer.append(wrapper);
        state.pages.push(entry);
      }
      state.pageNum = 1;
      markCurrentPage();
      canvasWrap.scrollTop = 0;
      observePages();
      canvasWrap.addEventListener('scroll', onWrapScroll, { passive: true });
      syncCurrentPage();
    }

    async function changeZoom(delta) {
      if (!state.pdf) return;
      state.scale = Math.min(4, Math.max(0.5, Math.round((state.scale + delta) * 10) / 10));
      updateControls();
      for (const entry of state.pages) {
        applyEntrySize(entry, state.scale);
        const wasVisible = entry.visible;
        resetEntry(entry);
        if (wasVisible) scheduleRender(entry);
      }
      syncCurrentPage();
    }

    function useFallback(reason) {
      state.usingFallback = true;
      teardownPages();
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
      teardownPages();
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
        await buildPages();
        updateControls();
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
      teardownPages();
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
        goToPage(state.pageNum + 1);
      } else if (event.key === 'ArrowLeft' && state.pdf && !state.usingFallback) {
        goToPage(state.pageNum - 1);
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
