'use strict';
/**
 * Camera-only photo capture.
 * Enforcement: getUserMedia streams LIVE frames — there is no gallery-pick
 * path at all (unlike <input type=file capture>, which many Androids let the
 * user bypass into the gallery). If getUserMedia is unavailable the mark still
 * goes through with NO_PHOTO flagged; we never block.
 * The canvas re-encode strips EXIF, so date/time + GPS are burnt into the
 * pixels — that is what survives for the auditor.
 */
const Camera = (() => {
  let stream = null;

  async function start(videoEl) {
    stop();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 } },
      audio: false
    });
    videoEl.srcObject = stream;
    await videoEl.play();
  }

  function stop() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
  }

  /** Square snapshot with a burnt-in stamp bar, compressed to <= maxKB. */
  async function capture(videoEl, stampLines, maxKB) {
    const side = 480;
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    const s = Math.min(vw, vh);
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoEl, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, side, side);

    const barH = 18 * stampLines.length + 10;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, side - barH, side, barH);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px monospace';
    stampLines.forEach((line, i) => ctx.fillText(line, 8, side - barH + 18 * (i + 1)));

    let last = null;
    for (let q = 0.7; q >= 0.25; q -= 0.1) {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
      if (!blob) break;
      last = blob;
      if (blob.size <= maxKB * 1024) return blob;
    }
    return last; // smallest attempt; better slightly over than no photo
  }

  return { start, stop, capture };
})();
