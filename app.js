// app.js
// Modes: CUT (PDF view + cutting overlays) and SCROLL (strip view).
//
// Gestures (all 1-finger, browser-safe):
// - LONG PRESS in center (CUT only):
//     -> If press is INSIDE an existing region: remove that region (visual + haptic)
//     -> Else: capture current viewport as a new region (red overlay + haptic)
// - LONG PRESS in TOP-LEFT corner (any):
//     -> open file chooser (with visual hold feedback)
// - LONG PRESS in TOP-RIGHT corner (any):
//     -> toggle mode CUT <-> SCROLL (with visual hold feedback)
//
// Persistence:
// - Regions are saved per PDF in localStorage when switching CUT -> SCROLL.
// - When the same PDF is opened again, regions are loaded and SCROLL is shown immediately.

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("pdfInput");
  const pickBtn = document.getElementById("pickPdfBtn");
  const pdfContainer = document.getElementById("pdfContainer");

  // ----------------------------
  // Mode names
  // ----------------------------
  const MODE = { CUT: "cut", SCROLL: "scroll" };
  let mode = MODE.CUT;

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

  // Optional custom button
  pickBtn?.addEventListener("click", () => openFileChooser());

  function openFileChooser() {
    showUI();
    // Reset so selecting the same file again still triggers "change"
    input.value = "";
    input.click();
  }

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
  function hapticAction() {
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
  // PDF rendering + layout
  // ----------------------------
  let pdfContent = null; // wrapper inside pdfContainer (CUT mode)
  let currentScale = 1.0;
  let pageLayouts = []; // for SCROLL extraction (from CUT canvases)

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
  // Regions + overlays (CUT mode)
  // ----------------------------
  const regions = []; // unscaled content coords: {x,y,w,h}
  const overlays = []; // overlay divs (same indices as regions)

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
    if (mode !== MODE.CUT) return;
    for (const r of regions) addOverlayForRegion(r);
  }

  function addRegion(region, withOverlay = true) {
    regions.push(region);
    if (withOverlay && mode === MODE.CUT) addOverlayForRegion(region);
  }

  function setRegionsFromSaved(saved) {
    clearRegions();
    for (const r of saved) regions.push({ x: r.x, y: r.y, w: r.w, h: r.h });
  }

  function captureCurrentViewportAsRegion() {
    const x = pdfContainer.scrollLeft / currentScale;
    const y = pdfContainer.scrollTop / currentScale;
    const w = pdfContainer.clientWidth / currentScale;
    const h = pdfContainer.clientHeight / currentScale;
    addRegion({ x, y, w, h }, true);
  }

  function clientToContentPoint(clientX, clientY) {
    const rect = pdfContainer.getBoundingClientRect();
    const xInContainer = clientX - rect.left;
    const yInContainer = clientY - rect.top;

    return {
      x: pdfContainer.scrollLeft / currentScale + xInContainer / currentScale,
      y: pdfContainer.scrollTop / currentScale + yInContainer / currentScale,
    };
  }

  function removeRegionAtContentPoint(px, py) {
    // Remove "topmost" (most recently created) region containing point
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i];
      const inside =
        px >= r.x &&
        px <= r.x + r.w &&
        py >= r.y &&
        py <= r.y + r.h;

      if (inside) {
        regions.splice(i, 1);
        if (overlays[i]) overlays[i].remove();
        overlays.splice(i, 1);
        updateOverlays();
        return true;
      }
    }
    return false;
  }

  // ----------------------------
  // Visual feedback for long-press (progress ring + pulse)
  // ----------------------------
  const feedback = (() => {
    const el = document.createElement("div");
    el.id = "holdFeedback";
    el.style.position = "fixed";
    el.style.width = "64px";
    el.style.height = "64px";
    el.style.left = "0";
    el.style.top = "0";
    el.style.transform = "translate(-9999px, -9999px)";
    el.style.borderRadius = "50%";
    el.style.pointerEvents = "none";
    el.style.zIndex = "99999";
    el.style.opacity = "0";
    el.style.transition = "opacity 80ms linear, transform 120ms ease-out";

    const inner = document.createElement("div");
    inner.style.position = "absolute";
    inner.style.inset = "10px";
    inner.style.borderRadius = "50%";
    inner.style.background = "rgba(0,0,0,0.55)";
    inner.style.border = "1px solid rgba(255,255,255,0.25)";
    el.appendChild(inner);

    document.body.appendChild(el);

    function setProgress(p) {
      const pct = Math.max(0, Math.min(1, p));
      el.style.background = `conic-gradient(rgba(255,255,255,0.85) ${
        pct * 360
      }deg, rgba(255,255,255,0.18) 0deg)`;
    }

    function showAt(x, y) {
      el.style.transform = `translate(${Math.round(x - 32)}px, ${Math.round(
        y - 32
      )}px)`;
      el.style.opacity = "1";
      setProgress(0);
    }

    function hide() {
      el.style.opacity = "0";
      setTimeout(() => {
        el.style.transform = "translate(-9999px, -9999px)";
      }, 140);
    }

    // quick pulse feedback (for delete vs normal action)
    function pulse(color) {
      // color can be 'red' or 'white' etc
      const base = el.style.background;
      if (color === "red") {
        el.style.background =
          "conic-gradient(rgba(255,80,80,0.95) 360deg, rgba(255,80,80,0.35) 0deg)";
      } else if (color === "green") {
        el.style.background =
          "conic-gradient(rgba(90,255,140,0.95) 360deg, rgba(90,255,140,0.35) 0deg)";
      } else {
        el.style.background =
          "conic-gradient(rgba(255,255,255,0.95) 360deg, rgba(255,255,255,0.35) 0deg)";
      }

      // small scale bump
      const m = el.style.transform;
      el.style.transform = m + " scale(1.06)";
      setTimeout(() => {
        el.style.transform = m;
        el.style.background = base;
      }, 140);
    }

    return { showAt, hide, setProgress, pulse };
  })();

  // ----------------------------
  // Long-press gesture router (single-finger only)
  // ----------------------------
  const MOVE_TOLERANCE_PX = 14;

  // Zones
  const CORNER_SIZE = 90; // px
  const TOP_MARGIN = 100; // px
  const CENTER_RADIUS = 90; // px

  function zoneForPoint(x, y) {
    if (x <= CORNER_SIZE && y <= TOP_MARGIN) return "file";
    if (x >= window.innerWidth - CORNER_SIZE && y <= TOP_MARGIN) return "toggle";

    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    if (Math.hypot(x - cx, y - cy) <= CENTER_RADIUS) return "capture";

    return null;
  }

  const HOLD_MS = {
    file: 650,
    toggle: 650,
    capture: 550,
  };

  let holdActive = false;
  let holdZone = null;
  let holdStart = null; // {x,y,time}
  let holdTimer = null;
  let rafId = null;

  function cancelHold() {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    holdActive = false;
    holdZone = null;
    holdStart = null;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    feedback.hide();
  }

  async function executeHoldAction(z, touch) {
    if (z === "file") {
      feedback.pulse("white");
      hapticAction();
      openFileChooser();
      return;
    }

    if (z === "toggle") {
      feedback.pulse("white");
      hapticAction();
      if (mode === MODE.CUT) {
        await switchToScrollMode(true /*save*/);
      } else {
        await switchToCutModeWithOverlays();
      }
      return;
    }

    if (z === "capture") {
      if (mode !== MODE.CUT) return;

      // If long-press happens INSIDE an existing region: delete it.
      const p = clientToContentPoint(touch.clientX, touch.clientY);
      const removed = removeRegionAtContentPoint(p.x, p.y);

      if (removed) {
        feedback.pulse("red"); // visual delete confirmation
        hapticAction(); // stronger feedback for delete
      } else {
        feedback.pulse("green"); // visual add confirmation
        captureCurrentViewportAsRegion();
        hapticSave();
      }
      return;
    }
  }

  function startHoldIfApplicable(touch) {
    const z = zoneForPoint(touch.clientX, touch.clientY);
    if (!z) return;

    // capture only in CUT
    if (z === "capture" && mode !== MODE.CUT) return;

    holdActive = true;
    holdZone = z;
    holdStart = { x: touch.clientX, y: touch.clientY, time: performance.now() };

    // stable feedback positions
    let fx = touch.clientX,
      fy = touch.clientY;
    if (z === "file") {
      fx = 28;
      fy = 28;
    }
    if (z === "toggle") {
      fx = window.innerWidth - 28;
      fy = 28;
    }
    if (z === "capture") {
      fx = window.innerWidth / 2;
      fy = window.innerHeight / 2;
    }

    feedback.showAt(fx, fy);

    const duration = HOLD_MS[z];

    const tick = () => {
      if (!holdActive) return;
      const elapsed = performance.now() - holdStart.time;
      feedback.setProgress(elapsed / duration);
      rafId = requestAnimationFrame(tick);
    };
    tick();

    holdTimer = setTimeout(async () => {
      if (!holdActive) return;
      const zExec = holdZone;
      const touchExec = { clientX: holdStart.x, clientY: holdStart.y };
      cancelHold(); // hide ring immediately
      await executeHoldAction(zExec, touchExec);
    }, duration);
  }

  document.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) {
        cancelHold();
        return;
      }
      const t = e.touches[0];
      startHoldIfApplicable(t);
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!holdActive) return;
      if (e.touches.length !== 1) {
        cancelHold();
        return;
      }
      const t = e.touches[0];
      const d = Math.hypot(t.clientX - holdStart.x, t.clientY - holdStart.y);
      if (d > MOVE_TOLERANCE_PX) cancelHold();
    },
    { passive: true }
  );

  document.addEventListener("touchend", () => cancelHold(), { passive: true });
  document.addEventListener("touchcancel", () => cancelHold(), { passive: true });

  // ----------------------------
  // Pinch zoom in CUT mode (2 fingers)
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
      if (mode !== MODE.CUT) return;
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
      if (mode !== MODE.CUT) return;
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
  // File input handling
  // ----------------------------
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
  // Load / render PDF (all pages) into CUT mode
  // If savedRegions provided: go directly to SCROLL.
  // ----------------------------
  async function loadPdf(file, savedRegions) {
    mode = MODE.CUT;
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

    if (Array.isArray(savedRegions) && savedRegions.length > 0) {
      setRegionsFromSaved(savedRegions);
      await switchToScrollMode(false /*save*/);
    } else {
      refreshOverlaysFromRegions();
    }
  }

  // ----------------------------
  // CUT -> SCROLL (optionally save)
  // ----------------------------
  async function switchToScrollMode(shouldSave) {
    if (mode !== MODE.CUT) return;

    if (shouldSave && currentFileKey) {
      saveCuts(currentFileKey, regions);
    }

    // Build scroll canvases before we swap DOM
    const scrollCanvases = buildScrollCanvasesFromRegions();

    mode = MODE.SCROLL;
    hideUI();

    overlays.forEach((el) => el.remove());
    overlays.length = 0;

    pdfContainer.innerHTML = "";

    const scroll = document.createElement("div");
    scroll.id = "scrollContainer";
    scroll.style.position = "fixed";
    scroll.style.inset = "0";
    scroll.style.overflowX = "auto";
    scroll.style.overflowY = "hidden";
    scroll.style.whiteSpace = "nowrap";
    scroll.style.background = "#000";
    scroll.style.padding = "0";
    scroll.style.margin = "0";
    scroll.style.fontSize = "0";
    scroll.style.lineHeight = "0";
    scroll.style.webkitOverflowScrolling = "touch";

    for (const c of scrollCanvases) {
      c.style.display = "inline-block";
      c.style.verticalAlign = "top";
      c.style.background = "#000";
      c.style.marginRight = "0px";
      scroll.appendChild(c);
    }

    pdfContainer.appendChild(scroll);
  }

  function buildScrollCanvasesFromRegions() {
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
  // SCROLL -> CUT (reload + overlays)
  // ----------------------------
  async function switchToCutModeWithOverlays() {
    if (!lastFile) return;

    const saved = currentFileKey ? loadCuts(currentFileKey) : null;

    // Load PDF but do NOT auto-switch to scroll
    await loadPdf(lastFile, null);

    // Restore regions + overlays
    if (Array.isArray(saved) && saved.length > 0) {
      setRegionsFromSaved(saved);
      refreshOverlaysFromRegions();
    }
  }
});