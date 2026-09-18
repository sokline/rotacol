/* =====================================================================
   features.js — RotaCol
   «Агенты видят друг друга» + сообщения диспетчера + история
   Подключается в оба файла: <script src="./features.js" defer></script>
   ===================================================================== */
(function () {
'use strict';

var PATH = (location.pathname || '').toLowerCase();
var IS_DISP = PATH.indexOf('dispatcher') !== -1;
var ROLE = IS_DISP ? 'dispatcher' : 'agent';

var K_HIST_DISP  = 'disp.msgHistory';
var K_HIST_AGENT = 'agent.msgHistory';
var K_HIST       = IS_DISP ? K_HIST_DISP : K_HIST_AGENT;
var MAX_HIST     = 200;

var S = {
  client: null,
  topicPrefix: null,    // 'rotacol-v1/<hash>' — БЕЗ слэша в конце
  encrypt: null,        // async (obj) -> payload (строка base64url / Uint8Array)
  decrypt: null,        // async (payload) -> obj
  dlog: function () {},
  agentsVisible: false,
  activeMsg: null,      // { id, text, level, ts }
  otherAgents: {},      // agentId -> { lastSeen, name, car, lat, lng }
  selfId: null
};

var F = window.RotaFeatures = {};
F.role = ROLE;

/* ---------------- утилиты ---------------- */
function lsGet(k, def){ try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch(e){ return def; } }
function lsSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
function uid(){ return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,7); }
function now(){ return Date.now(); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function humanAgo(ts){
  if (!ts) return '—';
  var d = Math.max(0, Math.floor((Date.now()-ts)/1000));
  if (d < 60) return d + ' с назад';
  if (d < 3600) return Math.floor(d/60) + ' мин назад';
  if (d < 86400) return Math.floor(d/3600) + ' ч назад';
  return Math.floor(d/86400) + ' дн назад';
}
function fmtTime(ts){
  try { return new Date(ts).toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'}); }
  catch(e){ return ''; }
}

/* ---------------- история ---------------- */
function histLoad(){ return lsGet(K_HIST, []) || []; }
function histSave(h){ lsSet(K_HIST, h.slice(0, MAX_HIST)); }
function histPush(entry){
  var h = histLoad();
  for (var i=0;i<h.length;i++){ if (h[i].id === entry.id){ Object.assign(h[i], entry); histSave(h); return; } }
  h.unshift(entry);
  histSave(h);
}
function histPatch(id, patch){
  var h = histLoad();
  for (var i=0;i<h.length;i++){ if (h[i].id === id){ Object.assign(h[i], patch); break; } }
  histSave(h);
}
F.getHistory = histLoad;

/* ---------------- attach ---------------- */
F.attach = function (opts) {
  Object.assign(S, opts || {});
  S.selfId = lsGet('agent.id', null);

  // подписка на всё в нашей группе — простой и надёжный вариант
  try { S.client.subscribe(S.topicPrefix + '/+', { qos: 0 }); }
  catch (e) { S.dlog('[FEAT] subscribe fail: ' + e.message); }
  S.dlog('[FEAT] attach ' + ROLE + ', топик ' + S.topicPrefix + '/+');

  if (IS_DISP) {
    // продублировать настройки группы (retained) на случай, если кто-то подключился раньше
    publishGroupSettings();
    // подтянуть текущее активное сообщение из retained (придёт как обычное MQTT)
  }

  buildUI();
};

/* ---------------- отправка ---------------- */
async function enc(obj){ try { return await S.encrypt(obj); } catch(e){ S.dlog('[FEAT] enc fail: '+e.message); return null; } }
function pub(suffix, payload, retain){
  try { S.client.publish(S.topicPrefix + '/' + suffix, payload, { qos:0, retain: !!retain }); }
  catch(e){ S.dlog('[FEAT] pub fail: '+e.message); }
}

async function publishGroupSettings(){
  var obj = { t:'set', agentsVisible: !!S.agentsVisible, ts: now() };
  var p = await enc(obj);
  if (p != null) pub('_group', p, true);
}

F.sendGroupSettings = function (agentsVisible) {
  if (!IS_DISP) return;
  S.agentsVisible = !!agentsVisible;
  publishGroupSettings();
  S.dlog('[FEAT] agentsVisible=' + S.agentsVisible);
};

F.sendMessage = async function (text, level) {
  if (!IS_DISP) return null;
  text = String(text || '').trim().slice(0, 500);
  if (!text) return null;
  var id = uid();
  var msg = { t:'msg', id:id, text:text, level: level || 'info', active:true, ts: now() };
  var p = await enc(msg);
  if (p != null) pub('_broadcast', p, true);
  S.activeMsg = msg;
  histPush({ id:id, text:text, level:msg.level, ts:msg.ts, active:true, direction:'out' });
  renderDispActive();
  renderDispHistory();
  return msg;
};

F.setActive = async function (id, active) {
  if (!IS_DISP) return;
  var h = histLoad(), src = null;
  for (var i=0;i<h.length;i++) if (h[i].id === id){ src = h[i]; break; }
  var msg = { t:'msg', id:id, active: !!active, ts: now(),
              text: src ? src.text : '', level: src ? src.level : 'info' };
  var p = await enc(msg);
  if (p != null) pub('_broadcast', p, true);
  histPatch(id, { active: !!active });
  S.activeMsg = active ? { id:id, text:msg.text, level:msg.level, ts:src?src.ts:now() } : null;
  renderDispActive();
  renderDispHistory();
};

/* ---------------- приём ----------------
   Возвращает:
     true  — сообщение полностью обработано, существующий код может выйти
     false — пусть существующий код обработает как раньше (это чья-то позиция)
------------------------------------------ */
F.handleMessage = async function (topic, payload) {
  if (!S.decrypt) return false;
  if (topic.indexOf(S.topicPrefix + '/') !== 0) return false;
  var suffix = topic.slice(S.topicPrefix.length + 1);

  // служебные топики
  if (suffix === '_group' || suffix === '_broadcast') {
    var obj = null;
    try { obj = await S.decrypt(payload); } catch(e){ S.dlog('[FEAT] decrypt fail '+suffix+': '+e.message); return true; }
    if (!obj || typeof obj !== 'object') return true;

    if (suffix === '_group' && obj.t === 'set') {
      if (!IS_DISP) {
        S.agentsVisible = !!obj.agentsVisible;
        applyAgentVisibility();
        S.dlog('[FEAT] ← agentsVisible=' + S.agentsVisible);
        renderAgentHeader();
      }
      return true;
    }

    if (suffix === '_broadcast' && obj.t === 'msg') {
      if (!IS_DISP) {
        if (obj.active === false) {
          if (S.activeMsg && S.activeMsg.id === obj.id) { S.activeMsg = null; renderAgentBanner(); }
          histPatch(obj.id, { active:false });
        } else if (obj.active === true) {
          S.activeMsg = { id:obj.id, text:obj.text, level:obj.level||'info', ts:obj.ts||now() };
          histPush({ id:obj.id, text:obj.text, level:obj.level||'info', ts:obj.ts||now(),
                     active:true, direction:'in' });
          renderAgentBanner();
        }
      } else {
        // диспетчер тоже обрабатывает — восстановление после reload
        if (obj.active === true) {
          S.activeMsg = { id:obj.id, text:obj.text, level:obj.level||'info', ts:obj.ts||now() };
          renderDispActive();
        } else if (obj.active === false) {
          if (S.activeMsg && S.activeMsg.id === obj.id) { S.activeMsg = null; renderDispActive(); }
        }
      }
      return true;
    }
    return true;
  }

  // позиция или offline — пусть существующий код тоже получит
  // (для агента обновляем «других», для диспетчера ничего не делаем)
  if (!IS_DISP) {
    var obj2 = null;
    try { obj2 = await S.decrypt(payload); } catch(e){ return false; }
    if (!obj2 || typeof obj2 !== 'object') return false;

    if (obj2.t === 'pos' && suffix !== S.selfId) {
      if (!S.agentsVisible) return false;
      var rec = S.otherAgents[suffix] || (S.otherAgents[suffix] = {});
      rec.lastSeen = now();
      rec.lat = obj2.lat; rec.lng = obj2.lng; rec.acc = obj2.acc; rec.spd = obj2.spd;
      rec.name = obj2.name; rec.car = obj2.car;
      drawOtherAgents();
    } else if (obj2.t === 'off' && suffix !== S.selfId) {
      if (S.otherAgents[suffix]) {
        S.otherAgents[suffix].lastSeen = 0;
        drawOtherAgents();
      }
    }
  }
  return false;
};

/* ---------------- видимость агентов ---------------- */
function applyAgentVisibility(){
  if (IS_DISP) return;
  if (!S.agentsVisible) {
    S.otherAgents = {};
    drawOtherAgents();
  }
}
F.isAgentsVisible = function(){ return !!S.agentsVisible; };
F.getOtherAgents  = function(){ return S.otherAgents; };

/* =====================================================================
   UI — общие стили
   ===================================================================== */
var CSS = [
  '.rf-banner{position:fixed;left:0;right:0;top:0;z-index:999990;',
  'padding:calc(8px + env(safe-area-inset-top,0px)) 12px 10px;',
  'font:600 14px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
  'color:#fff;display:flex;gap:10px;align-items:center;box-shadow:0 6px 18px rgba(0,0,0,.35);',
  'transform:translateY(-120%);transition:transform .25s ease}',
  '.rf-banner.rf-on{transform:translateY(0)}',
  '.rf-banner.rf-info {background:#1f6feb}',
  '.rf-banner.rf-warn {background:#d97706}',
  '.rf-banner.rf-alarm{background:#dc2626}',
  '.rf-banner .rf-ico{font-size:18px;flex:0 0 auto}',
  '.rf-banner .rf-txt{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:normal;max-height:3.2em}',
  '.rf-banner .rf-min{background:rgba(255,255,255,.18);border:0;color:#fff;border-radius:8px;',
  'padding:6px 10px;font:600 12px/1 inherit;cursor:pointer;flex:0 0 auto}',
  '.rf-banner.rf-minimized .rf-txt{display:none}',

  '.rf-panel{background:#111827;color:#e5e7eb;border-radius:14px;padding:14px;',
  'font:400 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
  'box-shadow:0 8px 22px rgba(0,0,0,.4);max-width:440px;width:calc(100vw - 24px)}',
  '.rf-panel h3{margin:0 0 12px;font-size:15px;letter-spacing:.3px}',
  '.rf-panel textarea{width:100%;box-sizing:border-box;background:#0b1220;color:#e5e7eb;',
  'border:1px solid #374151;border-radius:10px;padding:10px;font:14px/1.4 inherit;resize:vertical;min-height:70px}',
  '.rf-panel .rf-row{display:flex;gap:8px;align-items:center;margin:10px 0 0;flex-wrap:wrap}',
  '.rf-panel .rf-levels{display:flex;gap:6px}',
  '.rf-panel .rf-levels label{display:flex;gap:5px;align-items:center;padding:6px 10px;border-radius:9px;',
  'background:#1f2937;cursor:pointer;font-size:13px;user-select:none}',
  '.rf-panel .rf-levels input{accent-color:#1f6feb}',
  '.rf-panel .rf-send{background:#22c55e;color:#04210f;border:0;border-radius:10px;padding:10px 16px;',
  'font:700 14px/1 inherit;cursor:pointer;margin-left:auto}',
  '.rf-panel .rf-send:disabled{opacity:.4;cursor:not-allowed}',
  '.rf-panel .rf-card{background:#1f2937;border-radius:10px;padding:10px 12px;margin-top:12px;',
  'display:flex;gap:10px;align-items:flex-start}',
  '.rf-panel .rf-card.rf-info  {border-left:4px solid #1f6feb}',
  '.rf-panel .rf-card.rf-warn  {border-left:4px solid #d97706}',
  '.rf-panel .rf-card.rf-alarm {border-left:4px solid #dc2626}',
  '.rf-panel .rf-card .rf-card-txt{flex:1;font-size:13px;word-break:break-word}',
  '.rf-panel .rf-card .rf-card-meta{font-size:11px;opacity:.6;margin-top:4px}',
  '.rf-panel .rf-card label{display:flex;gap:6px;align-items:center;font-size:12px;white-space:nowrap;cursor:pointer}',
  '.rf-panel .rf-card input[type=checkbox]{accent-color:#22c55e}',

  '.rf-modal{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:999995;display:flex;',
  'align-items:center;justify-content:center;padding:12px}',
  '.rf-modal.rf-hidden{display:none}',
  '.rf-modal .rf-box{background:#111827;border-radius:14px;max-width:520px;width:100%;',
  'max-height:80vh;display:flex;flex-direction:column;color:#e5e7eb;',
  'font:400 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
  'box-shadow:0 12px 40px rgba(0,0,0,.55)}',
  '.rf-modal .rf-head{padding:14px 16px;border-bottom:1px solid #1f2937;display:flex;align-items:center;gap:10px}',
  '.rf-modal .rf-head h3{margin:0;font-size:15px;flex:1}',
  '.rf-modal .rf-x{background:transparent;border:0;color:#9ca3af;font-size:20px;cursor:pointer;padding:4px 8px}',
  '.rf-modal .rf-body{overflow:auto;padding:8px 16px 16px}',
  '.rf-modal .rf-item{padding:10px 0;border-bottom:1px solid #1f2937}',
  '.rf-modal .rf-item:last-child{border-bottom:0}',
  '.rf-modal .rf-item .rf-t{font-size:13px;word-break:break-word}',
  '.rf-modal .rf-item .rf-m{font-size:11px;opacity:.55;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap}',
  '.rf-modal .rf-item.rf-info  {border-left:3px solid #1f6feb;padding-left:10px}',
  '.rf-modal .rf-item.rf-warn  {border-left:3px solid #d97706;padding-left:10px}',
  '.rf-modal .rf-item.rf-alarm {border-left:3px solid #dc2626;padding-left:10px}',
  '.rf-modal .rf-item.rf-inactive{opacity:.5}',
  '.rf-modal .rf-empty{opacity:.5;padding:24px;text-align:center}',

  '.rf-chip{position:fixed;right:12px;z-index:999985;background:#111827;color:#e5e7eb;',
  'border:1px solid #374151;border-radius:999px;padding:8px 12px;font:600 13px/1 -apple-system,sans-serif;',
  'cursor:pointer;box-shadow:0 6px 16px rgba(0,0,0,.45);display:flex;gap:6px;align-items:center}',
  '.rf-chip:hover{background:#1f2937}',
  '.rf-chip.rf-hidden{display:none}',
  '.rf-chip .rf-badge{background:#dc2626;color:#fff;border-radius:999px;padding:2px 7px;font-size:11px}'
].join('');

function injectCSS(){
  if (document.getElementById('rf-style')) return;
  var s = document.createElement('style');
  s.id = 'rf-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* =====================================================================
   UI — ДИСПЕТЧЕР
   ===================================================================== */
var dispRefs = {};

function buildDispatcherUI(){
  injectCSS();

  // 1) Настройка «Агенты видят друг друга» — вставим в шапку настроек, если есть
  //    контейнер #settings или #disp-settings. Иначе — плавающая кнопка.
  var host = document.getElementById('settings') || document.getElementById('disp-settings') ||
             document.querySelector('#group-settings') || null;

  var groupBlock = document.createElement('div');
  groupBlock.className = 'rf-panel';
  groupBlock.style.marginTop = '12px';
  groupBlock.innerHTML =
    '<h3>👥 Видимость агентов</h3>' +
    '<label style="display:flex;gap:8px;align-items:center;font-size:14px;cursor:pointer">' +
      '<input type="checkbox" id="rf-agents-visible" style="accent-color:#22c55e;transform:scale(1.2)">' +
      '<span>Агенты видят друг друга на карте</span>' +
    '</label>' +
    '<div style="font-size:11px;opacity:.55;margin-top:6px">' +
      'Когда включено — каждый агент видит остальных из своей группы.' +
    '</div>';
  if (host && host.appendChild) host.appendChild(groupBlock);
  else {
    groupBlock.style.position = 'fixed';
    groupBlock.style.left = '12px';
    groupBlock.style.bottom = 'calc(80px + env(safe-area-inset-bottom,0px))';
    groupBlock.style.zIndex = '999984';
    document.body.appendChild(groupBlock);
  }
  var cb = groupBlock.querySelector('#rf-agents-visible');
  cb.checked = false;
  cb.addEventListener('change', function(){ F.sendGroupSettings(cb.checked); });

  // 2) Панель отправки сообщения — модальное окно
  var composer = document.createElement('div');
  composer.className = 'rf-modal rf-hidden';
  composer.id = 'rf-composer';
  composer.innerHTML =
    '<div class="rf-box">' +
      '<div class="rf-head"><h3>📨 Сообщение агентам</h3>' +
        '<button class="rf-x" type="button">×</button></div>' +
      '<div class="rf-body">' +
        '<textarea id="rf-text" placeholder="Текст сообщения (до 500 символов)"></textarea>' +
        '<div class="rf-row">' +
          '<div class="rf-levels">' +
            '<label><input type="radio" name="rf-lvl" value="info" checked> Инфо</label>' +
            '<label><input type="radio" name="rf-lvl" value="warn"> Внимание</label>' +
            '<label><input type="radio" name="rf-lvl" value="alarm"> Тревога</label>' +
          '</div>' +
          '<button class="rf-send" type="button" id="rf-send">Отправить</button>' +
        '</div>' +
        '<div id="rf-active-wrap"></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(composer);
  dispRefs.composer = composer;
  dispRefs.text     = composer.querySelector('#rf-text');
  dispRefs.active   = composer.querySelector('#rf-active-wrap');

  composer.querySelector('.rf-x').addEventListener('click', function(){ composer.classList.add('rf-hidden'); });
  composer.addEventListener('click', function(e){ if (e.target === composer) composer.classList.add('rf-hidden'); });
  composer.querySelector('#rf-send').addEventListener('click', async function(){
    var text = dispRefs.text.value;
    var lvl  = (composer.querySelector('input[name=rf-lvl]:checked')||{}).value || 'info';
    if (!text.trim()) return;
    await F.sendMessage(text, lvl);
    dispRefs.text.value = '';
  });

  // 3) Кнопки в шапке: «📨 Сообщение» и «📜 История»
  var actions = document.createElement('div');
  actions.className = 'rf-chip';
  actions.style.bottom = 'calc(70px + env(safe-area-inset-bottom,0px))';
  actions.innerHTML = '📨 <span>Сообщение</span>';
  actions.addEventListener('click', function(){ composer.classList.remove('rf-hidden'); });
  document.body.appendChild(actions);
  dispRefs.openBtn = actions;

  var histBtn = document.createElement('div');
  histBtn.className = 'rf-chip';
  histBtn.style.bottom = 'calc(120px + env(safe-area-inset-bottom,0px))';
  histBtn.innerHTML = '📜 <span>История</span>';
  histBtn.addEventListener('click', openHistory);
  document.body.appendChild(histBtn);

  renderDispActive();
}

function renderDispActive(){
  if (!dispRefs.active) return;
  var m = S.activeMsg;
  if (!m){ dispRefs.active.innerHTML = ''; return; }
  dispRefs.active.innerHTML =
    '<div class="rf-card rf-' + esc(m.level) + '">' +
      '<div class="rf-card-txt">' + esc(m.text) +
        '<div class="rf-card-meta">отправлено ' + esc(fmtTime(m.ts)) + '</div>' +
      '</div>' +
      '<label><input type="checkbox" checked id="rf-active-cb"> Показывать</label>' +
    '</div>';
  dispRefs.active.querySelector('#rf-active-cb').addEventListener('change', function(e){
    F.setActive(m.id, e.target.checked);
  });
}

/* =====================================================================
   UI — АГЕНТ
   ===================================================================== */
var agentRefs = {};

function buildAgentUI(){
  injectCSS();

  // Баннер сверху
  var banner = document.createElement('div');
  banner.className = 'rf-banner rf-hidden';
  banner.id = 'rf-banner';
  banner.innerHTML =
    '<span class="rf-ico">📢</span>' +
    '<span class="rf-txt"></span>' +
    '<button class="rf-min" type="button">Свернуть</button>';
  document.body.appendChild(banner);
  agentRefs.banner = banner;

  banner.querySelector('.rf-min').addEventListener('click', function(){
    banner.classList.toggle('rf-minimized');
    banner.querySelector('.rf-min').textContent =
      banner.classList.contains('rf-minimized') ? 'Развернуть' : 'Свернуть';
  });

  // Кнопка «История»
  var histBtn = document.createElement('div');
  histBtn.className = 'rf-chip';
  histBtn.style.bottom = 'calc(70px + env(safe-area-inset-bottom,0px))';
  histBtn.innerHTML = '📜 <span>История</span><span class="rf-badge rf-hidden" id="rf-hb">0</span>';
  histBtn.addEventListener('click', openHistory);
  document.body.appendChild(histBtn);
  agentRefs.histBtn = histBtn;

  // Индикатор «видишь других»
  var chip = document.createElement('div');
  chip.className = 'rf-chip rf-hidden';
  chip.style.bottom = 'calc(120px + env(safe-area-inset-bottom,0px))';
  chip.id = 'rf-visible-chip';
  document.body.appendChild(chip);
  agentRefs.visibleChip = chip;

  renderAgentBanner();
  renderAgentHeader();
  drawOtherAgents();
}

function renderAgentBanner(){
  var b = agentRefs.banner;
  if (!b) return;
  var m = S.activeMsg;
  if (!m){ b.classList.remove('rf-on'); b.classList.remove('rf-info','rf-warn','rf-alarm'); return; }
  b.classList.remove('rf-info','rf-warn','rf-alarm');
  b.classList.add('rf-' + (m.level || 'info'));
  b.classList.add('rf-on');
  b.querySelector('.rf-txt').textContent = m.text;
  // обновляем каждые 10 сек. на случай, если сообщение долго висит
  clearInterval(renderAgentBanner._t);
  renderAgentBanner._t = setInterval(function(){
    if (!S.activeMsg) { clearInterval(renderAgentBanner._t); return; }
    b.querySelector('.rf-txt').textContent = S.activeMsg.text;
  }, 10000);
}

function renderAgentHeader(){
  var chip = agentRefs.visibleChip;
  if (!chip) return;
  var n = Object.keys(S.otherAgents).filter(function(id){
    var r = S.otherAgents[id];
    return r && r.lastSeen && (Date.now() - r.lastSeen) < 90000;
  }).length;

  if (S.agentsVisible){
    chip.classList.remove('rf-hidden');
    chip.innerHTML = '👥 <span>Видно: ' + n + '</span>';
  } else {
    chip.classList.add('rf-hidden');
  }

  // badge в кнопке истории — число непрочитанных сообщений
  var badge = document.getElementById('rf-hb');
  if (badge){
    var h = histLoad();
    var unread = h.filter(function(x){ return x.direction === 'in' && !x.read; }).length;
    if (unread > 0){ badge.textContent = unread > 99 ? '99+' : String(unread); badge.classList.remove('rf-hidden'); }
    else badge.classList.add('rf-hidden');
  }
}

/* Рисуем других агентов поверх мини-карты.
   Мини-карта у агента — переменная `map`, `L` (Leaflet) — тоже глобальные.
   Если имена другие — поправьте одну строку ниже. */
var otherLayer = null;
function drawOtherAgents(){
  if (IS_DISP) return;
  if (typeof window.L === 'undefined') return;
  var map = window.map || window.agentMap || null;
  if (!map) return;

  if (!otherLayer){
    otherLayer = L.layerGroup().addTo(map);
  }
  otherLayer.clearLayers();
  if (!S.agentsVisible) return;

  var me = S.selfId;
  Object.keys(S.otherAgents).forEach(function(id){
    if (id === me) return;
    var r = S.otherAgents[id];
    if (!r || !r.lat || !r.lng) return;
    var online = r.lastSeen && (Date.now() - r.lastSeen) < 90000;
    L.circleMarker([r.lat, r.lng], {
      radius: 6, color: '#fff', weight: 2,
      fillColor: online ? '#22c55e' : '#6b7280', fillOpacity: .9
    })
    .bindTooltip(esc(r.name || id) + (online ? '' : ' · офлайн'), { permanent: false, direction: 'top' })
    .addTo(otherLayer);
  });

  renderAgentHeader();
}
F.redrawOtherAgents = drawOtherAgents;

/* =====================================================================
   История (модалка) — общая для двух страниц
   ===================================================================== */
var histModal = null;
function openHistory(){
  injectCSS();
  if (!histModal){
    histModal = document.createElement('div');
    histModal.className = 'rf-modal rf-hidden';
    histModal.innerHTML =
      '<div class="rf-box">' +
        '<div class="rf-head"><h3>📜 История сообщений</h3>' +
          '<button class="rf-x" type="button">×</button></div>' +
        '<div class="rf-body" id="rf-hist-body"></div>' +
      '</div>';
    document.body.appendChild(histModal);
    histModal.querySelector('.rf-x').addEventListener('click', function(){ histModal.classList.add('rf-hidden'); });
    histModal.addEventListener('click', function(e){ if (e.target === histModal) histModal.classList.add('rf-hidden'); });
  }
  renderHistoryModal();
  histModal.classList.remove('rf-hidden');
}

function renderHistoryModal(){
  var body = document.getElementById('rf-hist-body');
  if (!body) return;
  var h = histLoad();
  if (!h.length){
    body.innerHTML = '<div class="rf-empty">Пока пусто</div>';
    return;
  }
  var html = '';
  h.forEach(function(m){
    var dir = m.direction === 'in' ? '← получено' : '→ отправлено';
    var cls = 'rf-' + (m.level || 'info') + (m.active === false ? ' rf-inactive' : '');
    html += '<div class="rf-item ' + cls + '">' +
      '<div class="rf-t">' + esc(m.text || '') + '</div>' +
      '<div class="rf-m">' +
        '<span>' + esc(fmtTime(m.ts)) + ' · ' + esc(humanAgo(m.ts)) + '</span>' +
        '<span>' + esc(dir) + '</span>' +
        '<span>' + (m.active ? '● активно' : '○ скрыто') + '</span>' +
      '</div>' +
    '</div>';
  });
  body.innerHTML = html;

  // отметить всё как прочитанное (для агента)
  if (!IS_DISP){
    var hh = histLoad();
    var ch = false;
    hh.forEach(function(x){ if (x.direction === 'in' && !x.read){ x.read = true; ch = true; } });
    if (ch) histSave(hh);
    renderAgentHeader();
  }
}

/* =====================================================================
   Автозапуск UI
   ===================================================================== */
function buildUI(){
  if (IS_DISP) buildDispatcherUI();
  else buildAgentUI();

  // периодически — перерисовка статусов «онлайн/офлайн» и счётчиков
  setInterval(function(){
    if (!IS_DISP){ drawOtherAgents(); renderAgentHeader(); }
  }, 10000);
}

})();
