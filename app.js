// app.js
// PDF.js score viewer with cut-regions persistence + gesture controls.
//
// Gestures:
// - 1-finger LONG PRESS near screen center (still) in PDF mode:
//     -> save current viewport as a region + light red overlay + haptic (best-effort)
// - 3-finger LONG PRESS near screen center (still) in ANY mode:
//     -> toggle mode
//        PDF  -> STRIP (save regions first)
//        STRIP-> PDF   (reload PDF, show saved overlays)
// - 3-finger SWIPE (move) in ANY mode:
//     DOWN -> show UI bar
//     UP   -> hide UI bar
// Pinch-zoom:
// - 2-finger pinch works in PDF mode (scale inner content).
//
// Persistence:
// - Regions are saved per PDF in localStorage on PDF->STRIP toggle.
// - When the same PDF is opened again, regions are loaded and STRIP is shown immediately.
//
// Identity of a PDF is approximated by SHA-256 of first 256KB + size + lastModified.

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("pdfInput");
  const pickBtn = document.getElementById("pickPdfBtn");
  const pdfContainer = document.getElementById("pdfContainer");

  // ----------------------------
  // UI show/hide
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
    haptic(20);
  }
  function hapticToggle() {
    haptic([15, 40, 15]);
  }

  // ----------------------------
  // Persistence
  // ----------------------------
  const STORAGE_PREFIX = "scrollscore.cuts.v1:";
  let currentFileKey = null;
  let lastFile = null;

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return hex;
  }

  async function computeFileKey(file) {
    const N = 256 * 1024; // 256 KB
    const slice = file.slice(0, Math.min(N, file.size));
    const buf = await slice.arrayBuffer();
    const headHash = await sha256Hex(buf);
    return `${STORAGE_PREFIX}${headHash}:${file.size}:${file.lastModified || 0}`;
  }

  function saveCuts(fileKey, regionsToSave) {
    try {
      localStorage.setItem(fileKey, JSON.stringify({ regions: regionsToSave }));
    } catch (e) {
      console.warn("Could not save cuts:", e);
    }
  }

  function loadCuts(fileKey) {
    try {
      const raw = localStorage.getItem(fileKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.regions)) return null;

      const ok = parsed.regions.every(
        (r) =>
          r &&
          typeof r.x === "number" &&
          typeof r.y === "number" &&
          typeof r.w === "number" &&
          typeof r.h === "number"
      );
      return ok ? parsed.regions : null;
    } catch {
      return null;
    }
  }

  // ----------------------------
  // Zoom infrastructure (PDF mode)
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

    updateOverlays();
  }

  // ----------------------------
  // Page layout tracking (for strip extraction)
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

  function addOverlayForRegion(region) {
    if (!pdfContent) return;
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

  function refreshOverlaysFromRegions() {
    overlays.forEach((el) => el.remove());
    overlays.length = 0;
    if (mode !== MODE.PDF) return;
    for (const r of regions) addOverlayForRegion(r);
  }

  function addRegion(region, withOverlay = true) {
    regions.push(region);
    if (withOverlay && mode === MODE.PDF) addOverlayForRegion(region);
  }

  function captureCurrentViewportAsRegion() {
    const x = pdfContainer.scrollLeft / currentScale;
    const y = pdfContainer.scrollTop / currentScale;
    const w = pdfContainer.clientWidth / currentScale;
    const h = pdfContainer.clientHeight / currentScale;
    addRegion({ x, y, w, h }, true);
  }

  function setRegionsFromSaved(saved) {
    clearRegions();
    for (const r of saved) regions.push({ x: r.x, y: r.y, w: r.w, h: r.h });
  }

  // ----------------------------
  // Center detection
  // ----------------------------
  function isNearCenter(clientX, clientY) {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    return Math.sqrt(dx * dx + dy * dy) < 90;
  }

  // ----------------------------
  // 1-finger LONG PRESS in PDF mode -> save region
  // ----------------------------
  const SAVE_LONG_MS = 550;
  const MOVE_TOLERANCE_PX = 14;

  let saveTimer = null;
  let saveActive = false;
  let saveStartPt = null;

  function cancelSaveLongPress() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    saveActive = false;
    saveStartPt = null;
  }

  document.addEventListener(
    "touchstart",
    (e) => {
      if (mode !== MODE.PDF) return;
      if (e.touches.length !== 1) return;

      const t = e.touches[0];
      if (!isNearCenter(t.clientX, t.clientY)) return;

      saveActive = true;
      saveStartPt = { x: t.clientX, y: t.clientY };

      cancelSaveLongPress();
      saveTimer = setTimeout(() => {
        if (!saveActive) return;
        if (mode !== MODE.PDF) return;

        captureCurrentViewportAsRegion();
        hapticSave();

        cancelSaveLongPress();
      }, SAVE_LONG_MS);
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!saveActive) return;
      if (mode !== MODE.PDF) return;
      if (e.touches.length !== 1) {
        cancelSaveLongPress();
        return;
      }

      const t = e.touches[0];
      const d = Math.hypot(t.clientX - saveStartPt.x, t.clientY - saveStartPt.y);
      if (d > MOVE_TOLERANCE_PX) cancelSaveLongPress();
    },
    { passive: true }
  );

  document.addEventListener("touchend", () => cancelSaveLongPress(), { passive: true });
  document.addEventListener("touchcancel", () => cancelSaveLongPress(), { passive: true });

  // ----------------------------
  // Pinch zoom in PDF mode (2 fingers)
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

      e.preventDefault(); // prevent browser zoom

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
  // 3-finger SWIPE to show/hide UI (ANY mode)
  // ----------------------------
  let threeSwipeStartY = null;
  let threeSwipeStartTime = 0;
  let threeSwipeActive = false;

  document.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 3) {
        threeSwipeActive = true;
        threeSwipeStartY = e.touches[0].clientY;
        threeSwipeStartTime = Date.now();
      }
    },
    { passive: true }
  );

  document.addEventListener(
    "touchend",
    (e) => {
      if (!threeSwipeActive || threeSwipeStartY == null) return;
      if (e.touches && e.touches.length > 0) return;

      const endY = e.changedTouches?.[0]?.clientY;
      if (typeof endY !== "number") {
        threeSwipeActive = false;
        threeSwipeStartY = null;
        return;
      }

      const dy = endY - threeSwipeStartY; // down:+ up:-
      const dt = Date.now() - threeSwipeStartTime;

      // If it was a swipe, cancel the 3-finger long-press toggle (defined below)
      cancelThreeToggle();

      if (dt < 700) {
        if (dy > 80) showUI();
        else if (dy < -80) hideUI();
      }

      threeSwipeActive = false;
      threeSwipeStartY = null;
    },
    { passive: true }
  );

  document.addEventListener(
    "touchcancel",
    () => {
      threeSwipeActive = false;
      threeSwipeStartY = null;
    },
    { passive: true }
  );

  // ----------------------------
  // 3-finger LONG PRESS (still) in center: toggle PDF <-> STRIP (ANY mode)
  // ----------------------------
  const THREE_TOGGLE_MS = 750;
  const THREE_TOGGLE_MOVE_TOLERANCE_PX = 14;

  let threeToggleTimer = null;
  let threeToggleActive = false;
  let threeToggleStartPts = null;

  function cancelThreeToggle() {
    if (threeToggleTimer) clearTimeout(threeToggleTimer);
    threeToggleTimer = null;
    threeToggleActive = false;
    threeToggleStartPts = null;
  }

  function threeMovedTooMuch(touches) {
    for (let i = 0; i < 3; i++) {
      const t = touches[i];
      const s = threeToggleStartPts[i];
      const d = Math.hypot(t.clientX - s.x, t.clientY - s.y);
      if (d > THREE_TOGGLE_MOVE_TOLERANCE_PX) return true;
    }
    return false;
  }

  document.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 3) return;

      const t0 = e.touches[0];
      if (!isNearCenter(t0.clientX, t0.clientY)) return;

      threeToggleStartPts = [
        { x: e.touches[0].clientX, y: e.touches[0].clientY },
        { x: e.touches[1].clientX, y: e.touches[1].clientY },
        { x: e.touches[2].clientX, y: e.touches[2].clientY },
      ];
      threeToggleActive = true;

      cancelThreeToggle();
      threeToggleTimer = setTimeout(async () => {
        if (!threeToggleActive) return;

        hapticToggle();

        if (mode === MODE.PDF) {
          await finishCutModeToStrip(true /*save*/);
        } else if (mode === MODE.STRIP) {
          await returnToPdfModeWithOverlays();
        }

        cancelThreeToggle();
      }, THREE_TOGGLE_MS);
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!threeToggleActive) return;
      if (e.touches.length !== 3) {
        cancelThreeToggle();
        return;
      }
      if (threeMovedTooMuch(e.touches)) cancelThreeToggle();
    },
    { passive: true }
  );

  document.addEventListener("touchend", () => cancelThreeToggle(), { passive: true });
  document.addEventListener("touchcancel", () => cancelThreeToggle(), { passive: true });

  // ----------------------------
  // Load / render PDF (all pages)
  // ----------------------------
  async function loadPdf(file, savedRegions) {
    mode = MODE.PDF;
    clearRegions();
    ensurePdfContentWrapper();

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const numPages = pdf.numPages;
    const dpr = window.devicePixelRatio || 1;
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
      canvas.style.margin = "0";

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

    // If saved regions are provided: jump directly to STRIP
    if (Array.isArray(savedRegions) && savedRegions.length > 0) {
      setRegionsFromSaved(savedRegions);
      await finishCutModeToStrip(false /*save*/);
    } else {
      // Otherwise show overlays for existing regions (usually none)
      refreshOverlaysFromRegions();
    }
  }

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;

    try {
      lastFile = file;
      currentFileKey = await computeFileKey(file);

      const saved = loadCuts(currentFileKey);
      await loadPdf(file, saved);
    } catch (err) {
      console.error(err);
      showUI();
    }
  });

  // ----------------------------
  // PDF -> STRIP (optionally save)
  // ----------------------------
  async function finishCutModeToStrip(shouldSave) {
    mode = MODE.STRIP;
    hideUI();

    if (shouldSave && currentFileKey) {
      saveCuts(currentFileKey, regions);
    }

    // Remove overlays (strip doesn't show them)
    overlays.forEach((el) => el.remove());
    overlays.length = 0;

    // Keep pageLayouts + original canvases alive? We replace DOM, but we need pixel sources.
    // We can still render strip from current page canvases before wiping. So:
    // 1) Build strip canvases now
    const stripCanvases = buildStripCanvasesFromRegions();

    // 2) Replace UI with strip
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
    strip.style.fontSize = "0";
    strip.style.lineHeight = "0";
    strip.style.webkitOverflowScrolling = "touch";

    for (const c of stripCanvases) {
      c.style.display = "inline-block";
      c.style.verticalAlign = "top";
      c.style.background = "#000";
      c.style.marginRight = "0px";
      strip.appendChild(c);
    }

    pdfContainer.appendChild(strip);
  }

  function buildStripCanvasesFromRegions() {
    const targetCssHeight = window.innerHeight;
    const targetDpr = window.devicePixelRatio || 1;
    const canvases = [];

    for (const r of regions) {
      canvases.push(renderRegionToCanvas(r, targetCssHeight, targetDpr));
    }
    return canvases;
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

  // ----------------------------
  // STRIP -> PDF (reload + overlays)
  // ----------------------------
  async function returnToPdfModeWithOverlays() {
    if (!lastFile) return;

    const saved = currentFileKey ? loadCuts(currentFileKey) : null;

    // Load PDF but do NOT auto-strip
    await loadPdf(lastFile, null);

    // Restore regions + overlays
    if (Array.isArray(saved) && saved.length > 0) {
      setRegionsFromSaved(saved);
      refreshOverlaysFromRegions();
    }
  }
});