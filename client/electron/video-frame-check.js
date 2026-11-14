'use strict';

const { BrowserWindow } = require('electron');

// This function runs in the sandboxed probe renderer.
function decodeFrame(url, inPoint) {
  return new Promise(resolve => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.width = 160;
    video.height = 90;
    document.body.append(video);
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
      video.removeAttribute('src');
      video.load();
      video.remove();
      resolve(result);
    };
    video.onerror = () => finish(video.error?.code === 2 ? 'unreadable' : 'decode');
    let metadataReady = false;
    let checking = false;
    const checkFrame = async () => {
      if (!metadataReady || checking || video.seeking || video.readyState < video.HAVE_CURRENT_DATA) return;
      checking = true;
      try {
        // Require an actual picture even if only the audio track can supply current data.
        const picture = await createImageBitmap(video, { resizeWidth: 2, resizeHeight: 2 });
        picture.close();
        finish('ok');
      } catch {
        finish('no-frame');
      }
    };
    video.onloadeddata = video.onseeked = checkFrame;
    video.onloadedmetadata = () => {
      if (!video.videoWidth || !video.videoHeight) return finish('no-frame');
      if (inPoint > 0 && inPoint >= video.duration) return finish('in-point');
      if (inPoint !== video.currentTime) video.currentTime = inPoint;
      metadataReady = true;
      void checkFrame();
    };
    video.src = url;
  });
}

function checkVideoFrame(url, inPoint, signal, timeoutMs = 8000) {
  if (signal.aborted) return Promise.resolve('canceled');
  const probe = new BrowserWindow({
    width: 320, height: 180, show: false, focusable: false, skipTaskbar: true,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  const contents = probe.webContents;
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (!probe.isDestroyed()) probe.destroy();
      resolve(result);
    };
    const cancel = () => finish('canceled');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    contents.once('render-process-gone', () => finish('probe-error'));
    contents.on('will-navigate', event => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const csp = `default-src 'none'; media-src ${new URL(url).origin}; base-uri 'none'`;
    const page = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><body></body>`;
    probe.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(page)}`)
      .then(() => contents.executeJavaScript(`(${decodeFrame})(${JSON.stringify(url)}, ${inPoint})`))
      .then(finish, () => finish('probe-error'));
  });
}

module.exports = { checkVideoFrame };
