/* ================================================================
   pwa.js — RotaCol PWA helper
   Подключение: <script src="./pwa.js" defer></script>
   ================================================================ */
(function () {
  'use strict';

  /* ---------- 0. Контекст ---------- */
  var PATH        = location.pathname.toLowerCase();
  var IS_AGENT    = PATH.indexOf('agent') !== -1;
  var APP         = IS_AGENT ? 'agent' : 'dispatcher';
  var SW_URL      = './sw.js';
  var LS_HIDE_BTN = 'pwa.hideInstall.' + APP;
  var LS_IOS_HINT = 'pwa.iosHint.' + APP;
  var IOS_HINT_TTL = 7 * 24 * 60 * 60 * 1000; // показывать снова раз в неделю

  var deferredPrompt = null;
  var hadController  = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  var reloading      = false;

  function log(msg) {
    try {
      if (typeof window.dlog === 'function') { window.dlog('[PWA] ' + msg); return; }
    } catch (e) {}
    console.log('[PWA]', msg);
  }

  /* ---------- 1. Определения ---------- */
  function isStandalone() {
    try {
      if (window.navigator.standalone === true) return true;
      if (window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
      if (window.matchMedia('(display-mode: minimal-ui)').matches) return true;
    } catch (e) {}
    return false;
  }

  function isIOS() {
    var ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    return /Macintosh/.test(ua) && 'ontouchend' in document; // iPadOS 13+
  }

  function isSecure() {
    return location.protocol === 'https:' ||
           location.hostname === 'localhost' ||
           location.hostname === '127.0.0.1';
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---------- 2. Стили и элементы UI ---------- */
  var CSS = [
    '.pwa-btn{position:fixed;right:12px;bottom:calc(14px + env(safe-area-inset-bottom,0px));',
    'z-index:2147482000;display:flex;align-items:center;gap:8px;border:0;border-radius:999px;',
    'padding:12px 18px;font:600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
    'color:#fff;background:linear-gradient(135deg,#1f6feb,#0ea5e9);',
    'box-shadow:0 8px 24px rgba(0,0,0,.45);cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '.pwa-btn:active{transform:scale(.97)}',
    '.pwa-btn[hidden]{display:none!important}',

    '.pwa-toast{position:fixed;left:50%;transform:translateX(-50%);',
    'top:calc(12px + env(safe-area-inset-top,0px));z-index:2147483000;',
    'display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);',
    'padding:12px 14px;border-radius:14px;background:#111827;color:#e5e7eb;',
    'box-shadow:0 10px 30px rgba(0,0,0,.5);font:500 14px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '.pwa-toast[hidden]{display:none!important}',
    '.pwa-toast button{border:0;border-radius:9px;padding:9px 13px;font:600 13px/1 inherit;cursor:pointer}',
    '.pwa-toast .yes{background:#22c55e;color:#04210f}',
    '.pwa-toast .no{background:#374151;color:#e5e7eb}',

    '.pwa-sheet{position:fixed;inset:0;z-index:2147483100;display:flex;align-items:flex-end;',
    'background:rgba(0,0,0,.6);padding:0 0 env(safe-area-inset-bottom,0px)}',
    '.pwa-sheet[hidden]{display:none!important}',
    '.pwa-sheet-card{width:100%;max-width:520px;margin:0 auto;background:#111827;color:#e5e7eb;',
    'border-radius:18px 18px 0 0;padding:20px 20px 24px;',
    'font:400 15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '.pwa-sheet-card h3{margin:0 0 12px;font-size:17px}',
    '.pwa-sheet-card ol{margin:0 0 16px;padding-left:20px}',
    '.pwa-sheet-card li{margin-bottom:6px}',
    '.pwa-sheet-card .row{display:flex;gap:10px;justify-content:flex-end}',
    '.pwa-sheet-card button{border:0;border-radius:10px;padding:11px 16px;font:600 14px/1 inherit;cursor:pointer}',
    '.pwa-sheet-card .later{background:#374151;color:#e5e7eb}',
    '.pwa-sheet-card .never{background:transparent;color:#9ca3af;text-decoration:underline}'
  ].join('');

  function injectStyle() {
    if (document.getElementById('pwa-style')) return;
    var s = document.createElement('style');
    s.id = 'pwa-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  var btn = null, toast = null, sheet = null;

  function ensureButton() {
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pwa-btn';
    btn.id = 'pwa-install';
    btn.hidden = true;
    btn.addEventListener('click', onInstallClick);
    document.body.appendChild(btn);
    return btn;
  }

  function ensureToast() {
    if (toast) return toast;
    toast = document.createElement('div');
    toast.className = 'pwa-toast';
    toast.id = 'pwa-toast';
    toast.hidden = true;
    toast.innerHTML =
      '<span class="pwa-toast-text"></span>' +
      '<button type="button" class="yes"></button>' +
      '<button type="button" class="no"></button>';
    document.body.appendChild(toast);
    return toast;
  }

  function showToast(text, yesText, noText, onYes, onNo) {
    var t = ensureToast();
    t.querySelector('.pwa-toast-text').textContent = text;
    var y = t.querySelector('.yes'), n = t.querySelector('.no');
    y.textContent = yesText; n.textContent = noText;
    y.onclick = function () { t.hidden = true; onYes && onYes(); };
    n.onclick = function () { t.hidden = true; onNo  && onNo();  };
    t.hidden = false;
  }

  function ensureSheet() {
    if (sheet) return sheet;
    sheet = document.createElement('div');
    sheet.className = 'pwa-sheet';
    sheet.id = 'pwa-sheet';
    sheet.hidden = true;
    sheet.innerHTML =
      '<div class="pwa-sheet-card">' +
        '<h3>📲 Установить на iPhone / iPad</h3>' +
        '<ol>' +
          '<li>Нажмите кнопку <b>«Поделиться»</b> <span style="opacity:.7">(квадрат со стрелкой вверх)</span> внизу экрана.</li>' +
          '<li>Пролистайте и выберите <b>«На экран „Домой“»</b>.</li>' +
          '<li>Нажмите <b>«Добавить»</b> — иконка появится на рабочем столе.</li>' +
        '</ol>' +
        '<p style="opacity:.65;font-size:13px;margin:0 0 16px">' +
          'Важно: открывать нужно именно из Safari. В Chrome/Firefox на iOS установка тоже есть, но пункт называется так же — «На экран „Домой“».' +
        '</p>' +
        '<div class="row">' +
          '<button type="button" class="never">Больше не показывать</button>' +
          '<button type="button" class="later">Понятно</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(sheet);
    sheet.querySelector('.later').onclick = function () { sheet.hidden = true; };
    sheet.querySelector('.never').onclick = function () {
      lsSet(LS_IOS_HINT, String(Date.now() + 3650 * 24 * 3600 * 1000));
      sheet.hidden = true;
      if (btn) btn.hidden = true;
    };
    sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.hidden = true; });
    return sheet;
  }

  /* ---------- 3. Кнопка «Установить» ---------- */
  function showInstallButton(label) {
    if (isStandalone()) return;
    if (lsGet(LS_HIDE_BTN) === 'never') return;
    ensureButton();
    btn.textContent = label;
    btn.hidden = false;
  }

  function hideInstallButton() {
    if (btn) btn.hidden = true;
  }

  function onInstallClick() {
    if (deferredPrompt) {
      var p = deferredPrompt;
      deferredPrompt = null;
      p.prompt();
      p.userChoice.then(function (res) {
        log('userChoice: ' + res.outcome);
        hideInstallButton();
        if (res.outcome === 'dismissed') {
          lsSet(LS_HIDE_BTN, String(Date.now() + 7 * 24 * 3600 * 1000)); // вернуть через неделю
        }
      }).catch(function () { hideInstallButton(); });
      return;
    }
    if (isIOS()) {
      ensureSheet().hidden = false;
      return;
    }
    log('Промпт установки недоступен');
  }

  /* ---------- 4. Регистрация service worker ---------- */
  function registerSW() {
    if (!('serviceWorker' in navigator)) { log('serviceWorker не поддерживается'); return; }
    if (!isSecure()) { log('SW не регистрирую: нужен https:// (сейчас ' + location.protocol + ')'); return; }

    navigator.serviceWorker.register(SW_URL, { scope: './' }).then(function (reg) {
      log('SW зарегистрирован, scope=' + reg.scope);
      reg.update().catch(function () {});

      // периодическая проверка обновлений, пока страница открыта
      setInterval(function () { reg.update().catch(function () {}); }, 60 * 60 * 1000);

      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            log('Доступно обновление');
            showToast('Доступно обновление', 'Обновить', 'Позже', function () {
              if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
              else location.reload();
            });
          }
        });
      });
    }).catch(function (e) {
      log('Ошибка регистрации SW: ' + (e && e.message));
    });

    // новый SW взял управление → перезагружаемся (один раз)
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloading) return;
      reloading = true;
      log('Активирована новая версия — перезагрузка');
      location.reload();
    });

    // возврат на страницу из фона → проверяем обновления
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        navigator.serviceWorker.getRegistration().then(function (r) {
          if (r) r.update().catch(function () {});
        }).catch(function () {});
      }
    });
  }

  /* ---------- 5. Установка / запуск ---------- */
  function boot() {
    injectStyle();

    registerSW();

    // Android / Chrome / Edge — нативный промпт
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      log('beforeinstallprompt получен');
      var hide = lsGet(LS_HIDE_BTN);
      if (hide === 'never') return;
      if (hide && Date.now() < parseInt(hide, 10)) return;
      showInstallButton('📲 Установить приложение');
    });

    window.addEventListener('appinstalled', function () {
      log('Приложение установлено');
      deferredPrompt = null;
      hideInstallButton();
    });

    // iOS — только ручная инструкция
    if (isIOS() && !isStandalone()) {
      var until = parseInt(lsGet(LS_IOS_HINT) || '0', 10);
      if (!until || Date.now() > until) {
        showInstallButton('📲 На экран «Домой»');
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ---------- 6. Публичный API ---------- */
  window.RotaPWA = {
    isStandalone: isStandalone,
    isIOS: isIOS,
    install: onInstallClick,
    showIOSHint: function () { ensureSheet().hidden = false; }
  };
})();
