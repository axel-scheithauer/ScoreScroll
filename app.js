// app.js
// PDF.js: render all pages, then "cut mode":
// - pinch to zoom (scale inner content)
// - pan by normal scrolling in #pdfContainer
// - 1-finger long-press near screen center: capture current viewport as a region, overlay it light transparent red
// - regions may overlap
// - 2-finger long-press near screen center: finish cut mode -> render all captured regions as a horizontal strip
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
  // UI show/hide (optional)
  // ----------------------------
  function showUI() {
    document.body.classList.remove("viewer-mode");
    document.body.classList.add("ui-visible");
  }
  function hideUI() {
    document.body.classList.remove("ui-visible");
    document.body.classList.add("viewer-mode");
  }
  showUI();

  pickBtn?.addEventListener("click", () => input.click());

  // ----------------------------
  // Modes
  // ----------------------------
  const MODE = { PDF: "pdf", STRIP: "strip" };
  let mode = MODE.PDF;

  // ----------------------------
  // Haptics (best-effort)
  // ----------------------------
  function haptic(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch {
      // ignore
    }
  }
  function hapticSave() {
    haptic(20); // single tick
  }
  function hapticFinish() {
    haptic([15, 40, 15]); // double tick
  }

  // ----------------------------
  // Zoom infrastructure
  // ----------------------------
  let pdfContent = null;
  let currentScale = 1.0;

  function ensurePdfContentWrapper() {
    pdfContainer.innerHTML = "";
    pdfContent = document.createElement("div");
    pdfContent.id = "pdfContent";
    pdfContent.style.position = "relative";
    pdfContent.style.transformOrigin = "0 0";
    pdfContent.style.willChange = "transform";
    pdfContent.style.background = "#000";
    pdfContainer.appendChild(pdfContent);
  }

  function setScale(newScale) {
    const clamped = Math.max(0.6, Math.min(3.0, newScale));
    const oldScale = currentScale;
    currentScale = clamped;

    if (!pdfContent) return;

    pdfContent.style.transform = `scale(${currentScale})`;

    const baseW = Number(pdfContent.dataset.baseWidth || "0");
    const baseH = Number(pdfContent.dataset.baseHeight || "0");

    if (baseW && baseH) {
      pdfContent.style.width = `${baseW}px`;
      pdfContent.style.height = `${baseH}px`;

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

    // Keep overlays correct (they are in unscaled coords)
    updateOverlays();

    return oldScale;
  }

  // ----------------------------
  // Page layout tracking
  // ----------------------------
  let pageLayouts = []; // { pageNumber, top, left, width, height, canvas, dpr }

  function buildPageLayouts() {
    pageLayouts = [];
    const canvases = pdfContent.querySelectorAll("canvas[data-page-number]");
    canvases.forEach((canvas) => {
      pageLayouts.push({
        pageNumber: Number(canvas.dataset.pageNumber),
        top: Number(canvas.dataset.top),
        left: Number(canvas.dataset.left),
        width: Number(canvas.dataset.cssWidth),
        height: Number(canvas.dataset.cssHeight),
        canvas,
        dpr: Number(canvas.dataset.dpr),
      });
    });
  }

  // ----------------------------
  // Cut regions (unscaled content coords)
  // ----------------------------
  const regions = [];
  const overlays = [];

  function clearRegions() {
    regions.length = 0;
    overlays.forEach((el) => el.remove());
    overlays.length = 0;
  }

  function positionOverlay(overlayEl, region) {
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

  function addRegion(region) {
    regions.push(region);

    const ov = document.createElement("div");
    ov.className = "cutOverlay";
    ov.style.position = "absolute";
    ov.style.background = "rgba(255, 80, 80, 0.22)";
    ov.style.border = "1px solid rgba(255, 120, 120, 0.55)";
    ov.style.boxSizing = "border-box";
    ov.style.pointerEvents = "none";

    pdfContent.appendChild(ov);
    overlays.push(ov);

    positionOverlay(ov, region);
  }

  function captureCurrentViewportAsRegion() {
    const x = pdfContainer.scrollLeft / currentScale;
    const y = pdfContainer.scrollTop / currentScale;
    const w = pdfContainer.clientWidth / currentScale;
    const h = pdfContainer.clientHeight / currentScale;
    addRegion({ x, y, w, h });
  }

  // ----------------------------
  // Center detection
  // ----------------------------
  function isNearCenter(clientX, clientY) {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    return Math.sqrt(dx * dx + dy * dy) < 90; // radius
  }

  // ----------------------------
  // Long-press gestures
  // 1 finger long-press => save region
  // 2 finger long-press => finish to strip
  // Cancel if movement exceeds tolerance or finger count changes
  // ----------------------------
  const SAVE_LONG_MS = 550;
  const FINISH_LONG_MS = 800;
  const MOVE_TOLERANCE_PX = 14;

  let lpTimer = null;
  let lpKind = null; // "save" | "finish"
  let lpActive = false;
  let lpStartPts = []; // [{x,y},...]

  function cancelLongPress() {
    if (lpTimer) clearTimeout(lpTimer);
    lpTimer = null;
    lpKind = null;
    lpActive = false;
    lpStartPts = [];
  }

  function startLongPress(kind) {
    cancelLongPress();
    lpActive = true;
    lpKind = kind;

    const ms = kind === "finish" ? FINISH_LONG_MS : SAVE_LONG_MS;

    lpTimer = setTimeout(async () => {
      if (!lpActive) return;

      // Fire!
      if (mode !== MODE.PDF) return;
      if (kind === "save") {
        captureCurrentViewportAsRegion();
        hapticSave();
      } else if (kind === "finish") {
        hapticFinish();
        await finishCutModeToStrip();
      }

      cancelLongPress();
    }, ms);
  }

  function movedTooMuch(touches) {
    // Compare each touch to its start point (by index; stable enough for our use)
    for (let i = 0; i < touches.length; i++) {
      const t = touches[i];
      const s = lpStartPts[i];
      if (!s) return true;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_TOLERANCE_PX) return true;
    }
    return false;
  }

  // We'll attach the long-press detection to the whole document (works anywhere),
  // but only triggers when touches start near center.
  document.addEventListener(
    "touchstart",
    (e) => {
      if (mode !== MODE.PDF) return;

      const n = e.touches.length;
      if (n !== 1 && n !== 2) {
        cancelLongPress();
        return;
      }

      // Must start near center (use first touch as reference)
      const t0 = e.touches[0];
      if (!isNearCenter(t0.clientX, t0.clientY)) {
        cancelLongPress();
        return;
      }

      // Record start points
      lpStartPts = [];
      for (let i = 0; i < n; i++) {
        lpStartPts.push({ x: e.touches[i].clientX, y: e.touches[i].clientY });
      }

      // Start appropriate long-press
      if (n === 1) startLongPress("save");
      if (n === 2) startLongPress("finish");
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!lpActive) return;
      if (mode !== MODE.PDF) return;

      // If finger count changes, cancel
      if (e.touches.length !== lpStartPts.length) {
        cancelLongPress();
        return;
      }

      // If moved too much -> cancel (this also makes pinch zoom cancel finish gesture)
      if (movedTooMuch(e.touches)) {
        cancelLongPress();
      }
    },
    { passive: true }
  );

  document.addEventListener(
    "touchend",
    () => {
      // Release cancels (unless it already fired)
      cancelLongPress();
    },
    { passive: true }
  );

  document.addEventListener(
    "touchcancel",
    () => cancelLongPress(),
    { passive: true }
  );

  // ----------------------------
  // Pinch zoom (two fingers) on pdfContainer
  // (Note: our long-press finish uses 2 fingers but requires "still holding".
  // Pinch movement cancels long-press via MOVE_TOLERANCE.)
  // ----------------------------
  let pinchActive = false;
  let pinchStartDist = 0;
  let pinchStartScale = 1;

  function dist(t1, t2) {
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
        pinchStartDist = dist(e.touches[0], e.touches[1]);
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

      // prevent browser zoom
      e.preventDefault();

      const dNow = dist(e.touches[0], e.touches[1]);
      const factor = dNow / pinchStartDist;
      const newScale = pinchStartScale * factor;

      const oldScale = currentScale;
      const oldSL = pdfContainer.scrollLeft;
      const oldST = pdfContainer.scrollTop;

      setScale(newScale);

      const ratio = currentScale / oldScale;
      pdfContainer.scrollLeft = oldSL * ratio;
      pdfContainer.scrollTop = oldST * ratio;
    },
    { passive: false }
  );

  pdfContainer.addEventListener(
    "touchend",
    (e) => {
      if (e.touches.length < 2) pinchActive = false;
    },
    { passive: true }
  );

  // ----------------------------
  // Rendering PDF (all pages)
  // ----------------------------
  async function loadPdf(file) {
    mode = MODE.PDF;
    clearRegions();
    ensurePdfContentWrapper();

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const numPages = pdf.numPages;
    const dpr = window.devicePixelRatio || 1;

    // Render quality: tune if needed
    const renderScale = 1.5;

    let contentWidth = 0;
    let yOffset = 0;
    const gap = 0;

    for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: renderScale });

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);

      const cssW = Math.floor(viewport.width);
      const cssH = Math.floor(viewport.height);

      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.style.display = "block";
      canvas.style.position = "absolute";
      canvas.style.left = "0px";
      canvas.style.top = `${yOffset}px`;
      canvas.style.background = "#fff";

      canvas.dataset.pageNumber = String(pageNumber);
      canvas.dataset.top = String(yOffset);
      canvas.dataset.left = "0";
      canvas.dataset.cssWidth = String(cssW);
      canvas.dataset.cssHeight = String(cssH);
      canvas.dataset.dpr = String(dpr);

      pdfContent.appendChild(canvas);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await page.render({ canvasContext: ctx, viewport }).promise;

      contentWidth = Math.max(contentWidth, cssW);
      yOffset += cssH + gap;
    }

    const contentHeight = Math.max(0, yOffset - gap);
    pdfContent.dataset.baseWidth = String(contentWidth);
    pdfContent.dataset.baseHeight = String(contentHeight);

    pdfContent.style.width = `${contentWidth}px`;
    pdfContent.style.height = `${contentHeight}px`;

    setScale(1.0);
    buildPageLayouts();

    hideUI();
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
  // Finish cut mode => horizontal strip
  // ----------------------------
  async function finishCutModeToStrip() {
    mode = MODE.STRIP;
    hideUI();

    // remove overlays
    overlays.forEach((el) => el.remove());
    overlays.length = 0;

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

    // eliminate any inline-block whitespace gaps
    strip.style.fontSize = "0";
    strip.style.lineHeight = "0";

    strip.style.webkitOverflowScrolling = "touch";

    const targetCssHeight = window.innerHeight;
    const targetDpr = window.devicePixelRatio || 1;

    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];
      const snippetCanvas = renderRegionToCanvas(r, targetCssHeight, targetDpr);

      snippetCanvas.style.display = "inline-block";
      snippetCanvas.style.verticalAlign = "top";
      snippetCanvas.style.background = "#000";
      snippetCanvas.style.marginRight = "0px";

      strip.appendChild(snippetCanvas);
    }

    pdfContainer.appendChild(strip);
  }

  function renderRegionToCanvas(region, targetCssHeight, targetDpr) {
    const scaleToTarget = targetCssHeight / region.h;
    const outCssW = Math.max(1, Math.floor(region.w * scaleToTarget));
    const outCssH = Math.max(1, Math.floor(targetCssHeight));

    const out = document.createElement("canvas");
    out.width = Math.floor(outCssW * targetDpr);
    out.height = Math.floor(outCssH * targetDpr);
    out.style.width = `${outCssW}px`;
    out.style.height = `${outCssH}px`;

    const ctx = out.getContext("2d");
    ctx.setTransform(targetDpr, 0, 0, targetDpr, 0, 0);
    ctx.imageSmoothingEnabled = true;

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, outCssW, outCssH);

    const rx = region.x;
    const ry = region.y;
    const rw = region.w;
    const rh = region.h;

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

      const srcX = Math.floor((ix0 - px) * p.dpr);
      const srcY = Math.floor((iy0 - py) * p.dpr);
      const srcW = Math.floor(iW * p.dpr);
      const srcH = Math.floor(iH * p.dpr);

      const dstX = (ix0 - rx) * scaleToTarget;
      const dstY = (iy0 - ry) * scaleToTarget;
      const dstW = iW * scaleToTarget;
      const dstH = iH * scaleToTarget;

      ctx.drawImage(p.canvas, srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH);
    }

    return out;
  }
});