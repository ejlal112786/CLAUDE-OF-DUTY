/**
 * main.js
 * Entry point. Boots the game, surfaces fatal errors instead of failing
 * silently, and exposes a small debug handle (window.OBV) for inspection.
 */
import { Game } from './game.js';

function showFatal(message) {
  const overlay = document.getElementById('error-overlay');
  const msg = document.getElementById('error-message');
  if (overlay && msg) {
    msg.textContent = message;
    overlay.classList.remove('hidden');
    // hide every other screen
    for (const el of document.querySelectorAll('.screen')) {
      if (el !== overlay) el.classList.add('hidden');
    }
  } else {
    // DOM not ready — fall back to something visible
    document.body.insertAdjacentHTML('beforeend',
      `<pre style="color:#e88;padding:24px;font-family:monospace;white-space:pre-wrap">${message}</pre>`);
  }
}

window.addEventListener('error', (e) => {
  console.error(e.error || e.message);
  showFatal(`Runtime error: ${e.message}\n(${e.filename || 'script'} line ${e.lineno || '?'})`);
});

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  showFatal(`Unhandled promise rejection: ${e.reason && e.reason.message ? e.reason.message : e.reason}`);
});

// Basic capability hints before we even try
(function preflight() {
  if (!window.WebGLRenderingContext) {
    showFatal('This browser does not support WebGL.');
    return false;
  }
  if (!('pointerLockElement' in document)) {
    showFatal('This browser does not support the Pointer Lock API, which the game requires for mouse look.');
    return false;
  }
  const isSmallTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900;
  if (isSmallTouch) {
    showFatal('OPERATION: BLACK VECTOR is designed for desktop keyboard + mouse. A touch device was detected — gameplay controls are not available.');
    // keep going anyway; some hybrids have keyboards
  }
  return true;
})();

const game = new Game();
window.OBV = game; // debug handle

game.boot().catch((err) => {
  console.error(err);
  showFatal(`Failed to start the game: ${err && err.message ? err.message : err}`);
});
