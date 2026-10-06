/**
 * pwa.js — PWA registration and safe update handling.
 *
 * Registers ./sw.js so the game works offline, and watches for new versions.
 *
 * Updates are deliberately NON-destructive: when a new service worker is found
 * we never reload behind the player's back. A small banner appears instead, and
 * the page reloads only when the player chooses "RELOAD". This keeps an
 * in-progress mission from being torn down by a background update.
 *
 * Exposes window.OBV_PWA for debugging and automated checks.
 */
(function () {
  'use strict';

  const state = {
    supported: 'serviceWorker' in navigator,
    registered: false,
    updateAvailable: false,
    error: null,
    registration: null,
  };
  window.OBV_PWA = state;

  if (!state.supported) return;
  // Service workers require a secure context; file:// will simply not register.
  if (!window.isSecureContext) {
    state.error = 'insecure-context';
    return;
  }

  let banner = null;

  function showUpdateBanner(onReload) {
    if (banner) return;
    banner = document.createElement('div');
    banner.id = 'pwa-update-banner';
    // Inline styles keep this module self-contained (no style.css changes).
    Object.assign(banner.style, {
      position: 'fixed', left: '50%', bottom: '18px', transform: 'translateX(-50%)',
      zIndex: '500', display: 'flex', alignItems: 'center', gap: '10px',
      padding: '10px 14px', borderRadius: '6px',
      background: 'rgba(7,9,11,0.94)', border: '1px solid rgba(217,164,65,0.55)',
      color: '#d9a441', font: '600 12px/1.2 ui-monospace, Menlo, Consolas, monospace',
      letterSpacing: '0.06em', boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
      maxWidth: 'calc(100vw - 24px)',
    });
    banner.innerHTML =
      '<span>UPDATE READY</span>' +
      '<button id="pwa-update-reload" style="appearance:none;border:1px solid #d9a441;' +
      'background:transparent;color:#d9a441;padding:5px 10px;border-radius:4px;' +
      'font:inherit;cursor:pointer">RELOAD</button>' +
      '<button id="pwa-update-later" style="appearance:none;border:1px solid #4a525a;' +
      'background:transparent;color:#8a949e;padding:5px 10px;border-radius:4px;' +
      'font:inherit;cursor:pointer">LATER</button>';
    document.body.appendChild(banner);

    banner.querySelector('#pwa-update-reload').addEventListener('click', () => {
      banner.remove(); banner = null; onReload();
    });
    banner.querySelector('#pwa-update-later').addEventListener('click', () => {
      banner.remove(); banner = null;
    });
  }

  navigator.serviceWorker
    .register('./sw.js', { scope: './' })
    .then((reg) => {
      state.registered = true;
      state.registration = reg;

      // A worker was already waiting before this page loaded.
      if (reg.waiting && navigator.serviceWorker.controller) {
        state.updateAvailable = true;
        showUpdateBanner(() => activateAndReload(reg.waiting));
      }

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state !== 'installed') return;
          if (!navigator.serviceWorker.controller) {
            // First-ever install: nothing to interrupt, already active.
            return;
          }
          state.updateAvailable = true;
          showUpdateBanner(() => activateAndReload(installing));
        });
      });

      // Re-check on a timer and whenever the tab becomes visible again.
      const check = () => { reg.update().catch(() => {}); };
      setInterval(check, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) check();
      });
    })
    .catch((err) => {
      state.error = String((err && err.message) || err);
      console.warn('[pwa] registration failed:', err);
    });

  let reloading = false;
  function activateAndReload(worker) {
    if (!worker || reloading) return;
    reloading = true;
    let reloaded = false;
    const once = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', once);
    worker.postMessage({ type: 'SKIP_WAITING' });
    // Safety net: if control never changes, reload anyway after a short delay.
    setTimeout(once, 2500);
  }
})();
