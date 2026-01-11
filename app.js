// app.js
// PDF.js: render all pages, then "cut mode":
// - pinch to zoom (we scale inner content)
// - scroll/pan with normal scrolling
// - single tap near screen center: capture current viewport as a region, overlay it in light transparent red
// - regions may overlap
// - double tap near screen center: finish cut mode, render all captured regions as a horizontal strip (left->right)
//
// Assumes in HTML:
//   <button id="pickPdfBtn" type="button">...</button>
//   <input type="file" id="pdfInput" accept="application/pdf">
//   <div id="pdfContainer"></div>
// And pdf.js loaded (pdfjsLib available)

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("pdfInput");
  const pickBtn = document.getElementById("pickPdfBtn");
  const pdfContainer = document.getElementById("pdfContainer");

  // ----------------------------
  // UI show/hide with classes (optional, keep your existing logic if you want)
  // ----------------------------
  let uiVisible = true;

  function showUI() {
    uiVisible = true;
    document.body.classList.remove("viewer-mode");
    document.body.classList.add("ui-visible");
  }
  function hideUI() {
    uiVisible = false;
    document.body.classList.remove("ui-visible");
    document.body.classList.add("viewer-mode");
  }

  // Start: UI visible
  showUI();

  // Custom button triggers file input
  pickBtn?.addEventListener("click", () => input.click());

  // ----------------------------
  // App modes
  // ----------------------------
  const MODE = {
    PDF: "pdf", // normal PDF view (with cut mode enabled after load)
    STRIP: "strip", // horizontal strip view
  };
  let mode = MODE.PDF;

  // ----------------------------
  // Zoom infrastructure
  // We wrap all page canvases in a "pdfContent" div and scale it.
  // We also adjust pdfContent size so scrolling works correctly.
  // ----------------------------
  let pdfContent = null;
  let currentScale = 1.0;

  function ensurePdfContentWrapper() {
    // Clear container and rebuild wrapper
    pdfContainer.innerHTML = "";

    pdfContent = document.createElement("div");
    pdfContent.id = "pdfContent";
    pdfContent.style.position = "relative";
    pdfContent.style.transformOrigin = "0 0";
    pdfContent.style.willChange = "transform";
    pdfContent.style.background = "#000";

    // We'll set width/height after pages are rendered.
    pdfContainer.appendChild(pdfContent);
  }

  function setScale(newScale) {
    // Clamp a bit
    const clamped = Math.max(0.6, Math.min(3.0, newScale));
    currentScale = clamped;

    if (!pdfContent) return;

    // Scale visual
    pdfContent.style.transform = `scale(${currentScale})`;

    // IMPORTANT: make scrollbars reflect the scaled size.
    // We track base size of pdfContent (unscaled) and multiply.
    const baseW = Number(pdfContent.dataset.baseWidth || "0");
    const baseH = Number(pdfContent.dataset.baseHeight || "0");
    if (baseW && baseH) {
      pdfContent.style.width = `${baseW}px`;
      pdfContent.style.height = `${baseH}px`;

      // Create a "sizer" element that has scaled dimensions for scrolling.
      // We do it by setting padding-bottom/right on container? Easiest:
      // add an invisible absolutely positioned sizer inside container.
      let sizer = document.getElementById("pdfSizer");
      if (!sizer) {
        sizer = document.createElement("div");
        sizer.id = "pdfSizer";
        sizer.style.position = "absolute";
        sizer.style.left = "0";
        sizer.style.top = "0";
        sizer.style.opacity = "0";
        sizer.style.pointerEvents = "none";
        pdfContent.appendChild(sizer);
      }
      sizer.style.width = `${baseW * currentScale}px`;
      sizer.style.height = `${baseH * currentScale}px`;
    }

    // Update overlay boxes to match new scale (they are positioned in unscaled coords)
    updateOverlays();
  }

  // ----------------------------
  // Page layout tracking for slicing
  // ----------------------------
  // Each entry: { pageNumber, top, left, width, height, canvas, dpr }
  let pageLayouts = [];

  function buildPageLayouts() {
    pageLayouts = [];
    const canvases = pdfContent.querySelectorAll("canvas[data-page-number]");
    canvases.forEach((canvas) => {
      const pageNumber = Number(canvas.dataset.pageNumber);
      const top = Number(canvas.dataset.top);
      const left = Number(canvas.dataset.left);
      const width = Number(canvas.dataset.cssWidth);
      const height = Number(canvas.dataset.cssHeight);
      const dpr = Number(canvas.dataset.dpr);

      pageLayouts.push({ pageNumber, top, left, width, height, canvas, dpr });
    });
  }

  // ----------------------------
  // Cut regions
  // Stored in unscaled "content coordinates" (CSS px at scale=1):
  // { x, y, w, h }
  // ----------------------------
  const regions = [];
  const overlays = []; // corresponding overlay divs

  function clearRegions() {
    regions.length = 0;
    overlays.forEach((el) => el.remove());
    overlays.length = 0;
  }

  function addRegion(region) {
    regions.push(region);

    // overlay div on top of pdfContent
    const ov = document.createElement("div");
    ov.className = "cutOverlay";
    ov.style.position = "absolute";
    ov.style.background = "rgba(255, 80, 80, 0.22)"; // light red transparent
    ov.style.border = "1px solid rgba(255, 120, 120, 0.55)";
    ov.style.boxSizing = "border-box";
    ov.style.pointerEvents = "none";
    pdfContent.appendChild(ov);
    overlays.push(ov);

    positionOverlay(ov, region);
  }

  function positionOverlay(overlayEl, region) {
    // Overlay lives in unscaled coords; since parent is scaled, we set unscaled values.
    overlayEl.style.left = `${region.x}px`;
    overlayEl.style.top = `${region.y}px`;
    overlayEl.style.width = `${region.w}px`;
    overlayEl.style.height = `${region.h}px`;
  }

  function updateOverlays() {
    overlays.forEach((ov, idx) => {
      const r = regions[idx];
      if (r) positionOverlay(ov, r);
    });
  }

  function captureCurrentViewportAsRegion() {
    // Visible viewport in container coords:
    // scrollLeft/Top are in "scaled scroll space" because we created a scaled sizer.
    // So unscaled coords = scroll / scale, size = client / scale.
    const x = pdfContainer.scrollLeft / currentScale;
    const y = pdfContainer.scrollTop / currentScale;
    const w = pdfContainer.clientWidth / currentScale;
    const h = pdfContainer.clientHeight / currentScale;

    addRegion({ x, y, w, h });
  }

  // ----------------------------
  // Tap handling: single vs double tap in CENTER
  // Single tap center => capture region
  // Double tap center => finish -> strip view
  // ----------------------------
  let lastTapTime = 0;
  let singleTapTimer = null;

  function isNearCenter(clientX, clientY) {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return dist < 90; // radius around center
  }

  function onCenterSingleTap() {
    if (mode !== MODE.PDF) return;
    captureCurrentViewportAsRegion();
  }

  async function onCenterDoubleTap() {
    if (mode !== MODE.PDF) return;
    await finishCutModeToStrip();
  }

  function handleTapAt(clientX, clientY) {
    if (!isNearCenter(clientX, clientY)) return;

    const now = Date.now();
    const DOUBLE_TAP_MS = 320;

    if (now - lastTapTime < DOUBLE_TAP_MS) {
      // double tap
      lastTapTime = 0;
      if (singleTapTimer) {
        clearTimeout(singleTapTimer);
        singleTapTimer = null;
      }
      onCenterDoubleTap();
      return;
    }

    // potential single tap, wait if second tap comes
    lastTapTime = now;
    singleTapTimer = setTimeout(() => {
      singleTapTimer = null;
      onCenterSingleTap();
    }, DOUBLE_TAP_MS + 10);
  }

  // Use touchend so it works on iPhone
  document.addEventListener(
    "touchend",
    (e) => {
      if (mode !== MODE.PDF) return;
      // Only consider taps with one finger and without significant movement.
      // We'll keep it simple: if exactly one changed touch, treat as tap candidate.
      if (e.changedTouches.length !== 1) return;
      const t = e.changedTouches[0];
      handleTapAt(t.clientX, t.clientY);
    },
    { passive: true }
  );

  // ----------------------------
  // Pinch zoom (two-finger) on pdfContainer
  // ----------------------------
  let pinchActive = false;
  let pinchStartDist = 0;
  let pinchStartScale = 1;

  function distance(t1, t2) {
    const dx = t2.clientX - t1.clientX;
    const dy = t2.clientY - t1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  pdfContainer.addEventListener(
    "touchstart",
    (e) => {
      if (mode !== MODE.PDF) return;
      if (e.touches.length === 2) {
        pinchActive = true;
        pinchStartDist = distance(e.touches[0], e.touches[1]);
        pinchStartScale = currentScale;
      }
    },
    { passive: true }
  );

  pdfContainer.addEventListener(
    "touchmove",
    (e) => {
      if (mode !== MODE.PDF) return;
      if (!pinchActive) return;
      if (e.touches.length !== 2) return;

      // Prevent iOS browser zoom/scroll during pinch
      e.preventDefault();

      const distNow = distance(e.touches[0], e.touches[1]);
      const factor = distNow / pinchStartDist;
      const newScale = pinchStartScale * factor;

      // Keep the viewport roughly centered while zooming:
      // We'll scale and keep scroll position proportional.
      const oldScale = currentScale;
      const oldScrollLeft = pdfContainer.scrollLeft;
      const oldScrollTop = pdfContainer.scrollTop;

      setScale(newScale);

      const ratio = currentScale / oldScale;
      pdfContainer.scrollLeft = oldScrollLeft * ratio;
      pdfContainer.scrollTop = oldScrollTop * ratio;
    },
    { passive: false }
  );

  pdfContainer.addEventListener(
    "touchend",
    (e) => {
      if (e.touches.length < 2) {
        pinchActive = false;
      }
    },
    { passive: true }
  );

  // ----------------------------
  // Rendering PDF
  // ----------------------------
  async function loadPdf(file) {
    mode = MODE.PDF;
    clearRegions();

    ensurePdfContentWrapper();

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const numPages = pdf.numPages;

    // Render parameters (crisp)
    const dpr = window.devicePixelRatio || 1;
    const baseScaleForRender = 1.5; // internal render quality; zoom is handled by our pinch scaling

    // Layout accumulators (unscaled content coords)
    let contentWidth = 0;
    let yOffset = 0;
    const gap = 16; // gap between pages in unscaled coords

    for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);

      const viewport = page.getViewport({ scale: baseScaleForRender });

      // Create canvas
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      // Internal pixels
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);

      // Display size in CSS px (unscaled content coords)
      const cssW = Math.floor(viewport.width);
      const cssH = Math.floor(viewport.height);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.style.display = "block";
      canvas.style.margin = "0 auto";
      canvas.style.background = "#fff";

      // Position within pdfContent (unscaled)
      canvas.style.position = "absolute";
      canvas.style.left = "0px";
      canvas.style.top = `${yOffset}px`;

      // Data for slicing later
      canvas.dataset.pageNumber = String(pageNumber);
      canvas.dataset.top = String(yOffset);
      canvas.dataset.left = "0";
      canvas.dataset.cssWidth = String(cssW);
      canvas.dataset.cssHeight = String(cssH);
      canvas.dataset.dpr = String(dpr);

      pdfContent.appendChild(canvas);

      // Draw at dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      await page.render({ canvasContext: ctx, viewport }).promise;

      contentWidth = Math.max(contentWidth, cssW);
      yOffset += cssH + gap;
    }

    // Set base (unscaled) content size
    const contentHeight = Math.max(0, yOffset - gap);
    pdfContent.dataset.baseWidth = String(contentWidth);
    pdfContent.dataset.baseHeight = String(contentHeight);

    // Ensure the wrapper has the base size (transform scale handles zoom)
    pdfContent.style.width = `${contentWidth}px`;
    pdfContent.style.height = `${contentHeight}px`;

    // Add/Update sizer with current scale
    setScale(1.0);

    // Build layouts for slicing
    buildPageLayouts();

    // Switch to viewer after load (UI hidden)
    hideUI();

    // Reset scroll to top
    pdfContainer.scrollTop = 0;
    pdfContainer.scrollLeft = 0;
  }

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;

    loadPdf(file).catch((err) => {
      console.error(err);
      showUI();
    });
  });

  // ----------------------------
  // Finish cut mode => render strip
  // ----------------------------
  async function finishCutModeToStrip() {
    mode = MODE.STRIP;
    // UI stays hidden
    hideUI();

    // Remove overlays in strip mode
    overlays.forEach((el) => el.remove());
    overlays.length = 0;

    // Build a strip container
    pdfContainer.innerHTML = "";
 
		const strip = document.createElement("div");
		strip.id = "stripContainer";
		strip.style.position = "fixed";
		strip.style.inset = "0";
		strip.style.overflowX = "auto";
		strip.style.overflowY = "hidden";
		strip.style.whiteSpace = "nowrap";
		strip.style.background = "#000";
		strip.style.padding = "0";
		strip.style.margin = "0";
		
		// wichtig: keine Inline-Whitespace-Lücken
		strip.style.fontSize = "0";
		strip.style.lineHeight = "0";
		
		// Smooth scrolling on iOS
		strip.style.webkitOverflowScrolling = "touch";
		
		
    // For each region, render a snippet canvas
    const targetCssHeight = window.innerHeight; // show full screen height
    const targetDpr = window.devicePixelRatio || 1;

    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];

      const snippetCanvas = renderRegionToCanvas(r, targetCssHeight, targetDpr);
      snippetCanvas.style.display = "inline-block";
      snippetCanvas.style.verticalAlign = "top";
      snippetCanvas.style.background = "#000";
      snippetCanvas.style.marginRight = "0px"; // no gap, can add if you want

      strip.appendChild(snippetCanvas);
    }

    pdfContainer.appendChild(strip);
  }

  function renderRegionToCanvas(region, targetCssHeight, targetDpr) {
    // Keep aspect ratio of the region
    const scaleToTarget = targetCssHeight / region.h;
    const outCssW = Math.max(1, Math.floor(region.w * scaleToTarget));
    const outCssH = Math.max(1, Math.floor(targetCssHeight));

    const out = document.createElement("canvas");
    out.width = Math.floor(outCssW * targetDpr);
    out.height = Math.floor(outCssH * targetDpr);
    out.style.width = `${outCssW}px`;
    out.style.height = `${outCssH}px`;

    const ctx = out.getContext("2d");
    // draw in CSS px coordinates, but mapped to device px
    ctx.setTransform(targetDpr, 0, 0, targetDpr, 0, 0);
    ctx.imageSmoothingEnabled = true;

    // Fill background black
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, outCssW, outCssH);

    // We need to copy pixels from the page canvases that intersect the region.
    const rx = region.x;
    const ry = region.y;
    const rw = region.w;
    const rh = region.h;

    // Destination is (0,0,outCssW,outCssH). We map region->dest by scaleToTarget.
    // For each page canvas, compute intersection in "unscaled content coords".
    for (const p of pageLayouts) {
      const px = p.left;
      const py = p.top;
      const pw = p.width;
      const ph = p.height;

      const ix0 = Math.max(rx, px);
      const iy0 = Math.max(ry, py);
      const ix1 = Math.min(rx + rw, px + pw);
      const iy1 = Math.min(ry + rh, py + ph);

      if (ix1 <= ix0 || iy1 <= iy0) continue;

      const iW = ix1 - ix0;
      const iH = iy1 - iy0;

      // Source coords in the page canvas internal pixel space
      // page canvas internal pixels correspond to CSS px * dpr
      const srcX = Math.floor((ix0 - px) * p.dpr);
      const srcY = Math.floor((iy0 - py) * p.dpr);
      const srcW = Math.floor(iW * p.dpr);
      const srcH = Math.floor(iH * p.dpr);

      // Destination coords in output canvas (CSS px space)
      const dstX = (ix0 - rx) * scaleToTarget;
      const dstY = (iy0 - ry) * scaleToTarget;
      const dstW = iW * scaleToTarget;
      const dstH = iH * scaleToTarget;

      ctx.drawImage(p.canvas, srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH);
    }

    return out;
  }

  // ----------------------------
  // Convenience: If you want to return from strip to PDF view,
  // you could wire a gesture here later. For now: strip is final.
  // ----------------------------
});