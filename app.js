// app.js
// Renders all PDF pages (pdf.js) and toggles the UI with 3-finger gestures:
// - 3 fingers swipe DOWN  => show UI
// - 3 fingers swipe UP    => hide UI
//
// Assumptions in index.html:
// - <input type="file" id="pdfInput" accept="application/pdf">
// - <div id="uiBar"> ... contains the input ... </div>
// - <div id="pdfContainer"></div>
// - pdf.js is loaded and workerSrc is set, so `pdfjsLib` exists.

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("pdfInput");
  const pdfContainer = document.getElementById("pdfContainer");
  const pickBtn = document.getElementById("pickPdfBtn");

   pickBtn.addEventListener("click", () => {
  input.click();
});
  // ---- UI mode helpers ----
  let viewerMode = true; // true => UI hidden ("viewer-mode"), false => UI visible ("ui-visible")

  function showUI() {
    viewerMode = false;
    document.body.classList.remove("viewer-mode");
    document.body.classList.add("ui-visible");
  }

  function hideUI() {
    viewerMode = true;
    document.body.classList.remove("ui-visible");
    document.body.classList.add("viewer-mode");
  }

  // Start state: show UI until a PDF is chosen
  showUI();

  // ---- PDF rendering ----
  async function loadPdf(file) {
    pdfContainer.innerHTML = "";

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const numPages = pdf.numPages;

    // Tune these two for readability/performance
    const baseScale = 1.6; // increase (e.g., 2.0) for larger notation
    const dpr = window.devicePixelRatio || 1;

    for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);

      // Width-fitting scale
      const unscaled = page.getViewport({ scale: 1 });
      const containerWidth = pdfContainer.clientWidth || window.innerWidth;

      const scale = (containerWidth / unscaled.width) * baseScale;
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      // High-DPI / Retina rendering
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      pdfContainer.appendChild(canvas);

      // Ensure 1 CSS pixel maps to dpr device pixels
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      await page.render({ canvasContext: ctx, viewport }).promise;
    }

    // After selecting and rendering a PDF, switch to viewer mode (UI hidden)
    hideUI();
  }

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;

    loadPdf(file).catch((err) => {
      console.error(err);
      // If something goes wrong, keep UI visible so user can retry
      showUI();
    });
  });

  // ---- 3-finger swipe gestures ----
  // Down  => show UI
  // Up    => hide UI
  let touchStartY = null;
  let touchStartTime = 0;
  let touchFingerCount = 0;

  document.addEventListener(
    "touchstart",
    (e) => {
      touchFingerCount = e.touches.length;

      if (touchFingerCount === 3) {
        touchStartY = e.touches[0].clientY;
        touchStartTime = Date.now();
      } else {
        touchStartY = null;
      }
    },
    { passive: true }
  );

  document.addEventListener(
    "touchend",
    (e) => {
      if (touchStartY == null) return;

      const dy = e.changedTouches[0].clientY - touchStartY; // down:+  up:-
      const dt = Date.now() - touchStartTime;

      // Heuristics
      const fastEnough = dt < 600;
      const farEnoughDown = dy > 80;
      const farEnoughUp = dy < -80;

      if (touchFingerCount === 3 && fastEnough) {
        if (farEnoughDown) {
          // 3 fingers swipe DOWN => show UI
          showUI();
        } else if (farEnoughUp) {
          // 3 fingers swipe UP => hide UI
          hideUI();
        }
      }

      touchStartY = null;
    },
    { passive: true }
  );
});