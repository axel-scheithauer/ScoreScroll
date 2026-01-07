document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("pdfInput");
  const pdfContainer = document.getElementById("pdfContainer");

  let viewerMode = false;
	
	async function enterFullscreen() {
  const el = document.getElementById("pdfContainer");
  if (!document.fullscreenElement && el?.requestFullscreen) {
    try {
      await el.requestFullscreen();
    } catch (e) {
      console.warn("Fullscreen failed:", e);
    }
  }
}

async function exitFullscreen() {
  if (document.fullscreenElement && document.exitFullscreen) {
    try {
      await document.exitFullscreen();
    } catch (e) {
      console.warn("Exit fullscreen failed:", e);
    }
  }
}

  function enterViewerMode() {
  viewerMode = true;
  document.body.classList.add("viewer-mode");
}

  function exitViewerMode() {
  viewerMode = false;
  document.body.classList.remove("viewer-mode");
  exitFullscreen();
}

  async function loadPdf(file) {
    pdfContainer.innerHTML = "";

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const numPages = pdf.numPages;
    const baseScale = 1.6; // ggf. auf 2.0 erhöhen

    for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);

      const unscaled = page.getViewport({ scale: 1 });

      const containerWidth =
        pdfContainer.clientWidth || window.innerWidth - 32;

      const scale = (containerWidth / unscaled.width) * baseScale;
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      const dpr = window.devicePixelRatio || 1;

      canvas.width = viewport.width * dpr;
      canvas.height = viewport.height * dpr;
      canvas.style.width = viewport.width + "px";
      canvas.style.height = viewport.height + "px";

      pdfContainer.appendChild(canvas);

      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      const renderContext = {
        canvasContext: context,
        viewport,
      };

      await page.render(renderContext).promise;
    }

    // Nach dem Rendern in den Vollbild-Viewer wechseln
    enterViewerMode();
  }

  // Dateiauswahl
  input.addEventListener("change", () => {
  const file = input.files?.[0];
  if (!file) return;

  // 1. Direkt aus der User-Geste heraus versuchen, fullscreen zu aktivieren
  enterFullscreen();

  // 2. Dann PDF laden & Viewer-Mode setzen
  loadPdf(file).catch(console.error);
});

  // === Geste: 3-Finger-Swipe-nach-unten ===

  let touchStartY = null;
  let touchStartTime = 0;
  let touchFingerCount = 0;

  document.addEventListener(
    "touchstart",
    (e) => {
      if (!viewerMode) return;

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
      if (!viewerMode) return;
      if (touchStartY == null) return;

      const dy = e.changedTouches[0].clientY - touchStartY;
      const dt = Date.now() - touchStartTime;

      // einfache Heuristik: schneller Swipe nach unten
      if (touchFingerCount === 3 && dy > 80 && dt < 500) {
        // Viewer-Mode verlassen
        exitViewerMode();

        // Dateiauswahldialog erneut öffnen
        // (user gesture-Kontext ist hier in der Praxis okay, aber ggf. Browser-sensibel)
        setTimeout(() => {
          input.value = ""; // alte Auswahl zurücksetzen
          input.click();
        }, 0);
      }

      touchStartY = null;
    },
    { passive: true }
  );
});