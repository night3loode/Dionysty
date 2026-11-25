/* Dionysty: circles, stars and Starlight (client).
 * Self-contained. Load it at the end of /app/index.html:
 *   <script>window.DY_CIRCLES={api:'https://<BOT_WORKER_HOST>/api/'}</script>
 *   <script src="/app/circles.js" defer></script>
 * It signs requests exactly like the app (Telegram initData, else the saved dy_login object)
 * and talks only to /api/sq/c/*. It does not touch the app's own code or endpoints.
 */
(function () {
  'use strict';
  if (window.__dyCircles) return;
  window.__dyCircles = 1;

  var CFG = window.DY_CIRCLES || {};
  var API = CFG.api || '<BOT_WORKER_HOST>/api/';
  var TEMPLES = [
    ['artists', 'The Artists', 'I'], ['thinkers', 'The Thinkers', 'II'], ['healers', 'The Healers', 'III'],
    ['lovers', 'The Lovers', 'IV'], ['wanderers', 'The Wanderers', 'V'], ['revellers', 'The Revellers', 'VI'],
    ['builders', 'The Builders', 'VII']
  ];
  var TNAME = {}; TEMPLES.forEach(function (t) { TNAME[t[0]] = t[1]; });
  var MODES = {
    open: ['Open', 'Anyone in the village can come straight in.'],
    knock: ['Knock', 'People knock. You choose who comes in.'],
    invite: ['Invite only', 'Only people you invite. Everyone else sees just the name and theme.']
  };
  var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- network ----------
  function auth(body) {
    var tg = window.Telegram && Telegram.WebApp;
    var init = tg && tg.initData;
    if (init) body.initData = init;
    else { try { var l = JSON.parse(localStorage.getItem('dy_login') || 'null'); if (l) body.login = l; } catch (e) {} }
    return body;
  }
  function api(path, body) {
    return fetch(API + 'sq/c/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(auth(body || {}))
    }).then(function (r) { return r.json(); }).catch(function () {
      return { ok: false, error: 'We couldn\u2019t reach the sky. Try again in a moment.' };
    });
  }

  // ---------- helpers ----------
  function $(s, r) { return (r || document).querySelector(s); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function buzz(kind) { try { var h = Telegram.WebApp.HapticFeedback; kind ? h.notificationOccurred(kind) : h.impactOccurred('light'); } catch (e) {} }
  function title(o) { return o.name || o.topic || ''; }
  function hash(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  function ago(t) { var s = (Date.now() - t) / 1000; return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h'; }

  // ---------- state ----------
  var S = {
    open: false, room: 'all', sky: null, st: null, cid: 0, lines: [], after: 0,
    sheet: null, sheetData: null, knock: null, invites: [], left: null, dismissed: {}, pins: null
  };

  // ---------- styles ----------
  var css = '' +
    '#dyc-launch{position:fixed;right:16px;bottom:calc(env(safe-area-inset-bottom,0px) + 104px);z-index:55;width:54px;height:54px;border-radius:50%;' +
    'border:1px solid rgba(198,163,109,.55);background:radial-gradient(circle at 50% 40%,#3a1a1f,#140a0c 70%);color:#e9d3ae;display:none;align-items:center;justify-content:center;' +
    'box-shadow:0 10px 30px rgba(0,0,0,.5),inset 0 0 18px rgba(198,163,109,.12);cursor:pointer;padding:0}' +
    '#dyc-launch.on{display:flex}#dyc-launch svg{width:26px;height:26px}' +
    '#dyc-launch .dot{position:absolute;top:4px;right:4px;width:11px;height:11px;border-radius:50%;background:#e8b77a;box-shadow:0 0 10px #e8b77a;display:none}' +
    '#dyc-launch.alert .dot{display:block}' +
    '#dyc-launch.inside:after{content:"";position:absolute;inset:-5px;border-radius:50%;border:1px solid rgba(232,183,122,.6);animation:dycPulse 2.4s ease-out infinite}' +
    '@keyframes dycPulse{0%{transform:scale(.92);opacity:.9}100%{transform:scale(1.25);opacity:0}}' +
    '#dyc{position:fixed;inset:0;z-index:60;display:none;flex-direction:column;color:#f2e7d5;font-family:Jost,system-ui,sans-serif;font-weight:300;' +
    'background:radial-gradient(120% 70% at 50% -10%,#3b1720 0%,#14090b 55%,#0b0604 100%);padding-top:env(safe-area-inset-top,0px)}' +
    '#dyc.on{display:flex}' +
    '#dyc button{font-family:inherit}' +
    '#dyc :focus-visible{outline:2px solid #e8b77a;outline-offset:2px}' +
    '.dyc-head{display:flex;align-items:flex-start;justify-content:space-between;padding:18px 20px 6px}' +
    '.dyc-h{font-family:"Cormorant Garamond",Georgia,serif;font-weight:300;font-size:34px;line-height:1;margin:0;letter-spacing:.01em}' +
    '.dyc-sub{font-family:Michroma,sans-serif;font-size:9px;letter-spacing:.22em;color:#cdb490;margin-top:8px;text-transform:uppercase}' +
    '.dyc-x{background:none;border:1px solid rgba(198,163,109,.35);color:#e9d3ae;width:40px;height:40px;border-radius:50%;font-size:20px;line-height:1;cursor:pointer}' +
    '.dyc-rooms{display:flex;gap:8px;overflow-x:auto;padding:10px 20px 8px;scrollbar-width:none}.dyc-rooms::-webkit-scrollbar{display:none}' +
    '.dyc-room{flex:0 0 auto;border:1px solid rgba(198,163,109,.28);background:rgba(26,12,17,.6);color:#e9d3ae;border-radius:999px;padding:8px 14px;font-size:13px;cursor:pointer;white-space:nowrap}' +
    '.dyc-room b{font-family:Michroma,sans-serif;font-weight:400;font-size:8px;letter-spacing:.14em;color:#c6a36d;margin-right:6px}' +
    '.dyc-room.on{background:linear-gradient(180deg,#c6a36d,#a37c4a);color:#1a0c11;border-color:transparent}.dyc-room.on b{color:#1a0c11}' +
    '.dyc-scroll{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:calc(env(safe-area-inset-bottom,0px) + 110px)}' +
    '.dyc-skywrap{position:relative;margin:4px 14px 0;height:min(56vh,460px);border-radius:200px 200px 22px 22px;overflow:hidden;' +
    'border:1px solid rgba(198,163,109,.35);box-shadow:inset 0 0 0 5px rgba(11,6,4,.6),inset 0 0 0 6px rgba(198,163,109,.18)}' +
    '.dyc-skywrap canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:pointer}' +
    '.dyc-empty{position:absolute;left:0;right:0;bottom:22px;text-align:center;font-family:"Cormorant Garamond",serif;font-style:italic;font-size:19px;color:#cdb490;pointer-events:none;padding:0 30px}' +
    '.dyc-banner{margin:12px 14px 0;padding:14px 16px;border-radius:18px;background:rgba(198,163,109,.1);border:1px solid rgba(198,163,109,.35);display:flex;gap:12px;align-items:center}' +
    '.dyc-banner p{margin:0;flex:1;font-size:14px;line-height:1.4}.dyc-banner em{font-family:"Cormorant Garamond",serif;font-size:17px}' +
    '.dyc-list{padding:6px 14px 0}' +
    '.dyc-lh{font-family:Michroma,sans-serif;font-size:9px;letter-spacing:.22em;color:#c6a36d;margin:20px 6px 8px;text-transform:uppercase}' +
    '.dyc-row{display:flex;width:100%;text-align:left;align-items:center;gap:14px;padding:12px 10px;border:0;border-bottom:1px solid rgba(198,163,109,.12);background:none;color:inherit;cursor:pointer}' +
    '.dyc-row .g{width:34px;height:34px;flex:0 0 34px}.dyc-row .t{flex:1;min-width:0}' +
    '.dyc-row .n{display:block;font-family:"Cormorant Garamond",serif;font-size:20px;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.dyc-row .m{display:block;font-size:12.5px;color:#cdb490;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.dyc-new{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 26px);z-index:2;border:0;border-radius:999px;padding:15px 26px;' +
    'background:linear-gradient(180deg,#d4b07a,#a8794a);color:#1a0c11;font-size:15px;font-weight:500;letter-spacing:.02em;box-shadow:0 14px 34px rgba(0,0,0,.55);cursor:pointer}' +
    '.dyc-sheetbg{position:fixed;inset:0;z-index:61;background:rgba(5,2,2,.55);opacity:0;pointer-events:none;transition:opacity .25s}' +
    '.dyc-sheetbg.on{opacity:1;pointer-events:auto}' +
    '.dyc-sheet{position:fixed;left:0;right:0;bottom:0;z-index:62;max-height:92dvh;display:flex;flex-direction:column;background:linear-gradient(180deg,#24101a,#140a0c);' +
    'border-top:1px solid rgba(198,163,109,.45);border-radius:26px 26px 0 0;transform:translateY(105%);transition:transform .32s cubic-bezier(.2,.8,.2,1);' +
    'padding:10px 20px calc(env(safe-area-inset-bottom,0px) + 18px);color:#f2e7d5;font-family:Jost,system-ui,sans-serif;font-weight:300;max-width:640px;margin:0 auto}' +
    '.dyc-sheet.on{transform:none}.dyc-sheet.tall{height:92dvh}' +
    '.dyc-grab{width:42px;height:4px;border-radius:4px;background:rgba(198,163,109,.4);margin:0 auto 12px}' +
    '.dyc-st{font-family:"Cormorant Garamond",serif;font-weight:300;font-size:30px;line-height:1.05;margin:2px 0 4px}' +
    '.dyc-sm{font-size:14px;color:#cdb490;line-height:1.45;margin:0 0 6px}' +
    '.dyc-tag{display:inline-block;font-family:Michroma,sans-serif;font-size:8.5px;letter-spacing:.18em;color:#c6a36d;border:1px solid rgba(198,163,109,.35);border-radius:999px;padding:5px 9px;margin:6px 6px 0 0;text-transform:uppercase}' +
    '.dyc-field{display:block;margin:14px 0 0}.dyc-field span{display:block;font-size:12.5px;color:#cdb490;margin-bottom:6px}' +
    '.dyc-in{width:100%;box-sizing:border-box;background:rgba(11,6,4,.55);border:1px solid rgba(198,163,109,.3);border-radius:14px;color:#f2e7d5;padding:13px 14px;font:inherit;font-size:16px}' +
    '.dyc-in:focus{border-color:#c6a36d;outline:none}' +
    '.dyc-modes{display:grid;gap:8px;margin-top:6px}' +
    '.dyc-mode{display:block;text-align:left;width:100%;border:1px solid rgba(198,163,109,.25);background:rgba(11,6,4,.4);color:inherit;border-radius:14px;padding:11px 14px;cursor:pointer}' +
    '.dyc-mode b{display:block;font-weight:500;font-size:15px}.dyc-mode i{display:block;font-style:normal;font-size:12.5px;color:#cdb490;margin-top:2px}' +
    '.dyc-mode.on{border-color:#d4b07a;background:rgba(198,163,109,.14)}' +
    '.dyc-seg{display:flex;border:1px solid rgba(198,163,109,.3);border-radius:999px;padding:3px;margin-top:10px}' +
    '.dyc-seg button{flex:1;border:0;background:none;color:#e9d3ae;padding:8px 6px;border-radius:999px;font-size:13px;cursor:pointer}' +
    '.dyc-seg button.on{background:#c6a36d;color:#1a0c11}' +
    '.dyc-btn{border:0;border-radius:999px;padding:14px 20px;font-size:15px;font-weight:500;cursor:pointer;background:linear-gradient(180deg,#d4b07a,#a8794a);color:#1a0c11;width:100%;margin-top:16px}' +
    '.dyc-btn[disabled]{opacity:.45;cursor:default}' +
    '.dyc-ghost{border:1px solid rgba(198,163,109,.4);background:none;color:#e9d3ae;border-radius:999px;padding:10px 16px;font-size:14px;cursor:pointer}' +
    '.dyc-row2{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}' +
    '.dyc-people{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 2px}' +
    '.dyc-p{font-size:12.5px;padding:5px 10px;border-radius:999px;background:rgba(198,163,109,.1);color:#e9d3ae}.dyc-p.f{border:1px solid rgba(198,163,109,.45)}' +
    '.dyc-knock{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;background:rgba(232,183,122,.1);border:1px solid rgba(232,183,122,.35);margin-top:8px}' +
    '.dyc-knock p{margin:0;flex:1;font-size:14px}' +
    '.dyc-lines{flex:1;overflow-y:auto;margin:12px -6px 0;padding:0 6px;min-height:120px}' +
    '.dyc-ln{display:block;width:100%;text-align:left;border:0;background:none;color:inherit;padding:7px 0;cursor:pointer}' +
    '.dyc-ln .a{font-family:Michroma,sans-serif;font-size:8px;letter-spacing:.16em;color:#c6a36d;text-transform:uppercase}' +
    '.dyc-ln .b{display:inline-block;margin-top:3px;background:#f2e7d5;color:#2a1018;border-radius:4px 14px 14px 14px;padding:8px 12px;font-size:14.5px;line-height:1.35;max-width:88%}' +
    '.dyc-ln.mine{text-align:right}.dyc-ln.mine .b{background:#c6a36d;color:#1a0c11;border-radius:14px 4px 14px 14px}' +
    '.dyc-pin{margin-top:10px;padding:10px 14px;border-left:2px solid #c6a36d;font-family:"Cormorant Garamond",serif;font-style:italic;font-size:19px;line-height:1.25}' +
    '.dyc-compose{display:flex;gap:8px;margin-top:10px}.dyc-compose .dyc-in{flex:1}' +
    '.dyc-send{border:0;border-radius:14px;padding:0 16px;background:#c6a36d;color:#1a0c11;font-weight:500;cursor:pointer}' +
    '.dyc-light{display:flex;align-items:center;gap:12px;margin-top:12px;padding:10px 12px;border-radius:16px;background:rgba(11,6,4,.45);border:1px solid rgba(198,163,109,.2)}' +
    '.dyc-light .bar{flex:1;height:4px;border-radius:4px;background:rgba(198,163,109,.18);overflow:hidden}.dyc-light .bar i{display:block;height:100%;background:linear-gradient(90deg,#a8794a,#f1dcb4)}' +
    '.dyc-light small{display:block;font-size:12px;color:#cdb490;margin-top:5px}' +
    '.dyc-give{border:1px solid #d4b07a;background:rgba(198,163,109,.14);color:#f1dcb4;border-radius:999px;padding:9px 14px;font-size:13.5px;cursor:pointer;white-space:nowrap}' +
    '.dyc-toast{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 16px);transform:translate(-50%,-140%);z-index:70;background:#f2e7d5;color:#2a1018;padding:11px 18px;border-radius:999px;' +
    'font-family:Jost,system-ui,sans-serif;font-size:14px;box-shadow:0 10px 30px rgba(0,0,0,.4);transition:transform .3s;max-width:88vw;text-align:center}' +
    '.dyc-toast{visibility:hidden}.dyc-toast.on{transform:translate(-50%,0);visibility:visible}' +
    '.dyc-tags{display:flex;flex-wrap:wrap}' +
    '.dyc-sx{position:absolute;top:14px;right:16px;width:36px;height:36px;font-size:18px}.dyc-sheet .dyc-st{padding-right:40px}' +
    '.dyc-act{margin-top:8px;display:flex;gap:8px}' +
    '@media (min-width:720px){.dyc-skywrap{height:min(60vh,560px);margin:4px auto 0;max-width:760px}.dyc-list,.dyc-banner{max-width:760px;margin-left:auto;margin-right:auto}}' +
    '@media (prefers-reduced-motion:reduce){#dyc-launch.inside:after{animation:none}.dyc-sheet,.dyc-toast{transition:none}}';
  var style = document.createElement('style'); style.id = 'dyc-css'; style.textContent = css; document.head.appendChild(style);

  // ---------- glyphs ----------
  var ICON = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="16" cy="16" r="9.5"/>' +
    '<circle cx="16" cy="6.5" r="1.7" fill="currentColor"/><circle cx="24.2" cy="20.8" r="1.7" fill="currentColor"/><circle cx="7.8" cy="20.8" r="1.7" fill="currentColor"/><path d="M16 12.6l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9z" fill="currentColor"/></svg>';
  function glyph(kind, o) {
    if (kind === 'star') {
      var p = '', g = o.glow || .5;
      for (var i = 0; i < 8; i++) p += '<ellipse cx="17" cy="8.5" rx="2.6" ry="7" transform="rotate(' + (i * 45) + ' 17 17)" fill="rgba(241,220,180,' + (.18 + g * .4) + ')" stroke="rgba(241,220,180,.6)" stroke-width=".5"/>';
      return '<svg class="g" viewBox="0 0 34 34">' + p + '<circle cx="17" cy="17" r="3.6" fill="#fff4dc"/></svg>';
    }
    var cap = o.cap || 8, n = o.count || 0, dots = '';
    if (o.mode !== 'invite' || o.mine) for (var j = 0; j < cap; j++) {
      var a = -Math.PI / 2 + j * 2 * Math.PI / cap; dots += '<circle cx="' + (17 + 12 * Math.cos(a)).toFixed(1) + '" cy="' + (17 + 12 * Math.sin(a)).toFixed(1) + '" r="2.1" fill="' + (j < n ? '#f1dcb4' : 'none') + '" stroke="rgba(241,220,180,.55)" stroke-width=".7"/>';
    }
    var ring = o.mode === 'invite' && !o.mine ? '<circle cx="17" cy="17" r="12" fill="none" stroke="rgba(198,163,109,.6)" stroke-dasharray="2 3"/><rect x="13.5" y="16" width="7" height="6" rx="1" fill="none" stroke="#c6a36d"/><path d="M14.8 16v-1.6a2.2 2.2 0 0 1 4.4 0V16" fill="none" stroke="#c6a36d"/>' : '';
    return '<svg class="g" viewBox="0 0 34 34">' + ring + dots + '</svg>';
  }

  // ---------- DOM ----------
  var launch = document.createElement('button');
  launch.id = 'dyc-launch'; launch.type = 'button'; launch.setAttribute('aria-label', 'Circles');
  launch.innerHTML = ICON + '<span class="dot"></span>';
  var root = document.createElement('div');
  root.id = 'dyc'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Circles');
  root.innerHTML =
    '<div class="dyc-head"><div><h1 class="dyc-h">Circles</h1><div class="dyc-sub" id="dyc-sub">&nbsp;</div></div>' +
    '<button class="dyc-x" id="dyc-close" type="button" aria-label="Close">\u00d7</button></div>' +
    '<div class="dyc-rooms" id="dyc-rooms" role="tablist"></div>' +
    '<div class="dyc-scroll"><div id="dyc-banners"></div><div class="dyc-skywrap"><canvas id="dyc-cv" aria-hidden="true"></canvas><div class="dyc-empty" id="dyc-empty"></div></div>' +
    '<div class="dyc-list" id="dyc-list"></div></div>' +
    '<button class="dyc-new" id="dyc-new" type="button">Start a circle</button>';
  var bg = document.createElement('div'); bg.className = 'dyc-sheetbg';
  var sheet = document.createElement('div'); sheet.className = 'dyc-sheet'; sheet.setAttribute('role', 'dialog');
  var toast = document.createElement('div'); toast.className = 'dyc-toast'; toast.setAttribute('role', 'status');
  function mount() { [launch, root, bg, sheet, toast].forEach(function (n) { document.body.appendChild(n); }); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  var tT = 0;
  function say(msg) { toast.textContent = msg; toast.classList.add('on'); clearTimeout(tT); tT = setTimeout(function () { toast.classList.remove('on'); }, 2800); }

  // ---------- rooms ----------
  function paintRooms() {
    var h = '<button class="dyc-room' + (S.room === 'all' ? ' on' : '') + '" data-r="all" role="tab">Whole sky</button>' +
      '<button class="dyc-room' + (S.room === 'none' ? ' on' : '') + '" data-r="none" role="tab">Open sky</button>';
    TEMPLES.forEach(function (t) { h += '<button class="dyc-room' + (S.room === t[0] ? ' on' : '') + '" data-r="' + t[0] + '" role="tab"><b>' + t[2] + '</b>' + t[1].replace('The ', '') + '</button>'; });
    $('#dyc-rooms').innerHTML = h;
  }
  root.addEventListener('click', function (e) {
    var r = e.target.closest('[data-r]'); if (r) { S.room = r.dataset.r; buzz(); paintRooms(); paintSky(); return; }
    var it = e.target.closest('[data-item]'); if (it) { openItem(it.dataset.item); return; }
    var inv = e.target.closest('[data-inv]'); if (inv) { joinCircle(+inv.dataset.inv); return; }
    var dis = e.target.closest('[data-dis]'); if (dis) { api('decline', { id: +dis.dataset.dis }); S.dismissed[dis.dataset.dis] = 1; paintBanners(); return; }
    var kd = e.target.closest('[data-kdis]'); if (kd) { S.dismissed['k' + kd.dataset.kdis] = 1; paintBanners(); }
  });
  $('#dyc-close', root).onclick = function () { closeAll(); };
  $('#dyc-new', root).onclick = function () { openNew(); };
  launch.onclick = function () { buzz(); if (S.cid) openInside(); else openSky(); };

  function inRoom(o) { return S.room === 'all' || (S.room === 'none' ? !o.temple : o.temple === S.room); }
  function items() {
    if (!S.sky) return [];
    return S.sky.circles.map(function (c) { c.kind = 'circle'; return c; }).concat(S.sky.stars.map(function (s) { s.kind = 'star'; return s; })).filter(inRoom);
  }

  // ---------- sky list + banners ----------
  function paintSky() {
    var list = items(), circ = list.filter(function (i) { return i.kind === 'circle'; }), stars = list.filter(function (i) { return i.kind === 'star'; });
    var here = 0; if (S.sky) S.sky.circles.forEach(function (c) { here += c.count || 0; });
    $('#dyc-sub').textContent = (S.sky ? S.sky.circles.length + ' circle' + (S.sky.circles.length === 1 ? '' : 's') + ' \u00b7 ' + S.sky.stars.length + ' star' + (S.sky.stars.length === 1 ? '' : 's') : 'Looking up');
    var h = '';
    if (circ.length) {
      h += '<div class="dyc-lh">Circles now</div>';
      circ.forEach(function (c) {
        var meta = c.mine ? 'You are here' : c.mode === 'invite' ? 'By invitation' : (c.count || 0) + ' inside \u00b7 ' + MODES[c.mode][0];
        if (c.temple) meta += ' \u00b7 ' + TNAME[c.temple];
        h += '<button class="dyc-row" data-item="c' + c.id + '">' + glyph('circle', c) + '<span class="t"><span class="n">' + esc(title(c)) + '</span><span class="m">' + esc((c.name ? c.topic + ' \u00b7 ' : '') + meta) + '</span></span></button>';
      });
    }
    if (stars.length) {
      h += '<div class="dyc-lh">Stars</div>';
      stars.forEach(function (s) {
        h += '<button class="dyc-row" data-item="s' + s.id + '">' + glyph('star', s) + '<span class="t"><span class="n">' + esc(title(s)) + '</span><span class="m">' + esc(s.line ? '\u201c' + s.line + '\u201d' : s.topic) + '</span></span></button>';
      });
    }
    $('#dyc-list').innerHTML = h;
    $('#dyc-empty').textContent = S.sky && !list.length ? (S.room === 'all' ? 'A quiet sky. Start the first circle.' : 'Nothing here yet. Start the first circle in this room.') : '';
    layout();
  }
  function paintBanners() {
    var h = '';
    (S.invites || []).forEach(function (i) {
      if (S.dismissed[i.id] || i.id === S.cid) return;
      var who = i.how === 'let-in' ? (i.from ? 'You\u2019re let in. ' + esc(i.from) + ' brought you to ' : 'They let you in to ') : esc(i.from) + ' invited you to ';
      h += '<div class="dyc-banner"><p>' + who + '<em>' + esc(i.name || i.topic) + '</em></p><button class="dyc-ghost" data-inv="' + i.id + '">Come in</button><button class="dyc-ghost" data-dis="' + i.id + '" aria-label="Not now">\u00d7</button></div>';
    });
    var k = S.knock;
    if (k && !S.dismissed['k' + k.kid]) {
      var t = k.status === 'waiting' ? 'Knocking. Someone inside can let you in. Stay close.' : k.status === 'no' ? 'They didn\u2019t open the door this time.' : 'No answer this time.';
      h += '<div class="dyc-banner"><p>' + t + '</p>' + (k.status === 'waiting' ? '' : '<button class="dyc-ghost" data-kdis="' + k.kid + '" aria-label="Dismiss">\u00d7</button>') + '</div>';
    }
    $('#dyc-banners').innerHTML = h;
    var alert = (S.invites || []).some(function (i) { return !S.dismissed[i.id] && i.id !== S.cid; }) || (S.st && S.st.knocks && S.st.knocks.length);
    launch.classList.toggle('alert', !!alert);
    launch.classList.toggle('inside', !!S.cid);
  }

  // ---------- canvas sky ----------
  var cv = null, cx = null, W = 0, H = 0, DPR = 1, BGS = [], POS = [], raf = 0, t0 = performance.now();
  for (var i = 0; i < 160; i++) BGS.push({ x: hash(i + 1), y: hash(i + 77), r: hash(i + 33) < .9 ? .5 + hash(i + 9) * .7 : 1.3 + hash(i + 5), p: hash(i + 13) * 6.28, s: .4 + hash(i + 51) });
  function size() {
    cv = $('#dyc-cv'); if (!cv) return; cx = cv.getContext('2d');
    var r = cv.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1); W = r.width; H = r.height;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR); layout();
  }
  function layout() {
    POS = [];
    var list = items(); if (!W) return;
    var n = list.length, cxm = W / 2, cym = H * .56, rx = W * .36, ry = H * .3;
    list.forEach(function (o, k) {
      var seed = (o.kind === 'star' ? 1000 : 0) + o.id;
      var a = (k / Math.max(1, n)) * Math.PI * 2 + hash(seed) * .9 - Math.PI / 2;
      var rr = n === 1 ? 0 : .55 + hash(seed + 3) * .45;
      POS.push({ o: o, x: cxm + Math.cos(a) * rx * rr, y: cym + Math.sin(a) * ry * rr, r: o.kind === 'star' ? 12 + 10 * (o.glow || .3) : 22 });
    });
  }
  function petals(x, y, r, n, t, a) {
    cx.save(); cx.translate(x, y); cx.rotate(t);
    for (var i = 0; i < n; i++) {
      cx.rotate(Math.PI * 2 / n); cx.beginPath(); cx.moveTo(0, -r * .25);
      cx.bezierCurveTo(r * .35, -r * .45, r * .3, -r * .9, 0, -r); cx.bezierCurveTo(-r * .3, -r * .9, -r * .35, -r * .45, 0, -r * .25);
      cx.fillStyle = 'rgba(241,220,180,' + (a * .22) + ')'; cx.fill(); cx.strokeStyle = 'rgba(241,220,180,' + (a * .7) + ')'; cx.lineWidth = .7; cx.stroke();
    }
    cx.restore();
  }
  function draw(now) {
    raf = 0; if (!S.open || !cx) return;
    var t = REDUCED ? 0 : (now - t0) / 1000;
    cx.setTransform(DPR, 0, 0, DPR, 0, 0); cx.clearRect(0, 0, W, H);
    var g = cx.createRadialGradient(W / 2, H * .55, 0, W / 2, H * .55, Math.max(W, H) * .75);
    g.addColorStop(0, '#2a1218'); g.addColorStop(1, '#0b0604'); cx.fillStyle = g; cx.fillRect(0, 0, W, H);
    var ang = t * .012, ca = Math.cos(ang), sa = Math.sin(ang);
    BGS.forEach(function (s) {
      var dx = (s.x - .5) * W * 1.5, dy = (s.y - .5) * H * 1.5, x = W / 2 + dx * ca - dy * sa, y = H / 2 + dx * sa + dy * ca;
      if (x < 0 || y < 0 || x > W || y > H) return;
      cx.fillStyle = 'rgba(242,231,213,' + Math.max(.06, .25 + .3 * Math.sin(t * s.s + s.p)) + ')'; cx.fillRect(x, y, s.r, s.r);
    });
    cx.globalCompositeOperation = 'lighter';
    // threads from circles to the star they orbit
    POS.forEach(function (p) {
      if (p.o.kind !== 'circle' || !p.o.star_id) return;
      var s = POS.filter(function (q) { return q.o.kind === 'star' && q.o.id === p.o.star_id; })[0];
      if (!s) return; cx.setLineDash([2, 5]); cx.strokeStyle = 'rgba(198,163,109,.35)'; cx.beginPath(); cx.moveTo(p.x, p.y); cx.lineTo(s.x, s.y); cx.stroke(); cx.setLineDash([]);
    });
    POS.forEach(function (p, k) {
      var o = p.o;
      if (o.kind === 'star') {
        var gl = o.glow || .3, hr = p.r * (2.6 + gl);
        var h = cx.createRadialGradient(p.x, p.y, 0, p.x, p.y, hr); h.addColorStop(0, 'rgba(255,226,170,' + (.35 * gl + .05) + ')'); h.addColorStop(1, 'rgba(0,0,0,0)');
        cx.fillStyle = h; cx.beginPath(); cx.arc(p.x, p.y, hr, 0, 7); cx.fill();
        petals(p.x, p.y, p.r * 1.25, 8, t * .08 + k, .35 + gl * .65); petals(p.x, p.y, p.r * .8, 6, -t * .12 + k, .3 + gl * .5);
        cx.fillStyle = 'rgba(255,246,226,' + (.6 + .4 * gl) + ')'; cx.beginPath(); cx.arc(p.x, p.y, 2.5 + 2 * gl, 0, 7); cx.fill();
      } else {
        var closed = o.mode === 'invite' && !o.mine, cap = o.cap || 8, n = o.count || 0;
        var hh = cx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 1.8); hh.addColorStop(0, 'rgba(232,183,122,' + (o.mine ? .28 : .14) + ')'); hh.addColorStop(1, 'rgba(0,0,0,0)');
        cx.fillStyle = hh; cx.beginPath(); cx.arc(p.x, p.y, p.r * 1.8, 0, 7); cx.fill();
        cx.strokeStyle = 'rgba(198,163,109,' + (closed ? .55 : .3) + ')'; cx.lineWidth = 1;
        if (closed) cx.setLineDash([3, 4]);
        cx.beginPath(); cx.arc(p.x, p.y, p.r, 0, 7); cx.stroke(); cx.setLineDash([]);
        if (!closed) for (var j = 0; j < cap; j++) {
          var a = -Math.PI / 2 + j * Math.PI * 2 / cap + t * .05;
          var dx2 = p.x + Math.cos(a) * p.r, dy2 = p.y + Math.sin(a) * p.r;
          cx.beginPath(); cx.arc(dx2, dy2, j < n ? 3.2 : 2.2, 0, 7);
          if (j < n) { cx.fillStyle = 'rgba(255,240,214,' + (.75 + .25 * Math.sin(t * 2 + j)) + ')'; cx.fill(); } else { cx.strokeStyle = 'rgba(241,220,180,.35)'; cx.stroke(); }
        }
        else { cx.fillStyle = 'rgba(198,163,109,.8)'; cx.fillRect(p.x - 4, p.y - 1, 8, 6); cx.strokeStyle = 'rgba(198,163,109,.8)'; cx.beginPath(); cx.arc(p.x, p.y - 1, 3, Math.PI, 0); cx.stroke(); }
      }
      cx.globalCompositeOperation = 'source-over';
      cx.fillStyle = 'rgba(242,231,213,.85)'; cx.textAlign = 'center';
      cx.font = 'italic 300 15px "Cormorant Garamond",Georgia,serif';
      var label = title(o); if (label.length > 26) label = label.slice(0, 25) + '\u2026';
      cx.fillText(label, p.x, p.y + p.r + 20);
      if (o.temple) { cx.fillStyle = 'rgba(198,163,109,.7)'; cx.font = '400 7px Michroma,sans-serif'; cx.fillText(TNAME[o.temple].replace('The ', '').toUpperCase(), p.x, p.y + p.r + 32); }
      cx.globalCompositeOperation = 'lighter';
    });
    cx.globalCompositeOperation = 'source-over';
    if (!REDUCED) raf = requestAnimationFrame(draw);
  }
  function startDraw() { if (!raf) raf = requestAnimationFrame(draw); }
  document.addEventListener('click', function (e) {
    if (!cv || e.target !== cv) return;
    var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, best = null, bd = 1e9;
    POS.forEach(function (p) { var d = Math.hypot(p.x - x, p.y - y); if (d < p.r + 24 && d < bd) { bd = d; best = p; } });
    if (best) openItem((best.o.kind === 'star' ? 's' : 'c') + best.o.id);
  });
  window.addEventListener('resize', function () { if (S.open) { size(); startDraw(); } });

  // ---------- sheets ----------
  function showSheet(html, tall, noClose) {
    sheet.innerHTML = '<div class="dyc-grab"></div>' + (noClose ? '' : '<button class="dyc-x dyc-sx" type="button" aria-label="Close">\u00d7</button>') + html;
    sheet.classList.toggle('tall', !!tall);
    var tg = sheet.querySelectorAll(':scope > .dyc-tag');
    if (tg.length) { var wr = document.createElement('div'); wr.className = 'dyc-tags'; tg[0].parentNode.insertBefore(wr, tg[0]); tg.forEach(function (t) { wr.appendChild(t); }); }
    var sx = sheet.querySelector('.dyc-sx'); if (sx) sx.onclick = hideSheet;
    bg.classList.add('on'); sheet.classList.add('on');
    var f = sheet.querySelector('[autofocus]'); if (f) setTimeout(function () { f.focus(); }, 320);
  }
  function hideSheet() { S.sheet = null; S.sheetData = null; sheet.classList.remove('on'); bg.classList.remove('on'); }
  bg.onclick = hideSheet;
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (sheet.classList.contains('on')) hideSheet(); else if (S.open) closeAll();
  });

  function openItem(key) {
    buzz();
    var kind = key[0], id = +key.slice(1);
    if (kind === 's') return openStar(id);
    if (id === S.cid) return openInside();
    var c = S.sky && S.sky.circles.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    S.sheet = 'outside'; S.sheetData = c;
    var action = c.mode === 'open' ? '<button class="dyc-btn" id="dyc-go">Come in</button>'
      : c.mode === 'knock' ? '<button class="dyc-btn" id="dyc-go">Knock</button>'
        : '<button class="dyc-btn" disabled>By invitation only</button>';
    var invited = (S.invites || []).some(function (i) { return i.id === c.id; });
    if (invited) action = '<button class="dyc-btn" id="dyc-go">Come in</button>';
    showSheet(
      (c.name ? '<div class="dyc-sm" style="margin:0">' + esc(c.topic) + '</div>' : '') +
      '<h2 class="dyc-st">' + esc(title(c)) + '</h2>' +
      '<span class="dyc-tag">' + MODES[c.mode][0] + '</span>' + (c.temple ? '<span class="dyc-tag">' + TNAME[c.temple] + '</span>' : '') +
      (c.people && c.people.length ? '<div class="dyc-people">' + c.people.map(function (p) { return '<span class="dyc-p">' + esc(p.alias) + '</span>'; }).join('') + '</div>' : '') +
      '<p class="dyc-sm" style="margin-top:12px">' + (c.mode === 'invite' ? 'Someone inside can invite you. Whoever invites you, the founder decides.' : MODES[c.mode][1]) + '</p>' + action);
    var go = $('#dyc-go', sheet);
    if (go) go.onclick = function () {
      go.disabled = true;
      if (c.mode === 'knock' && !invited) {
        api('knock', { id: c.id }).then(function (r) {
          go.disabled = false;
          if (!r.ok) { if (r.open) return joinCircle(c.id); return say(r.error); }
          buzz('success'); S.knock = { kid: r.kid, id: c.id, status: 'waiting' }; delete S.dismissed['k' + r.kid];
          hideSheet(); paintBanners(); say('Knocking. Stay close.'); schedule(true);
        });
      } else joinCircle(c.id, go);
    };
  }

  function joinCircle(id, btn) {
    api('join', { id: id }).then(function (r) {
      if (btn) btn.disabled = false;
      if (!r.ok) { if (r.knock) { say('This circle has a door. Knock first.'); } else say(r.error); return; }
      buzz('success'); S.cid = r.cid; S.lines = []; S.after = 0; S.knock = null;
      refreshState().then(openInside); refreshSky();
    });
  }

  function openNew(opts) {
    opts = opts || {};
    S.sheet = 'new';
    var room = opts.temple !== undefined ? opts.temple : (S.room !== 'all' && S.room !== 'none' ? S.room : '');
    var mode = 'open';
    var tOpts = '<option value="">Open sky</option>' + TEMPLES.map(function (t) { return '<option value="' + t[0] + '"' + (t[0] === room ? ' selected' : '') + '>' + t[2] + ' \u00b7 ' + t[1] + '</option>'; }).join('');
    showSheet(
      '<h2 class="dyc-st">' + (opts.star ? 'A circle around ' + esc(title(opts.star)) : 'Start a circle') + '</h2>' +
      '<p class="dyc-sm">A circle lasts while people are in it. Give it enough Starlight and it becomes a star.</p>' +
      '<label class="dyc-field"><span>What is it about?</span><input class="dyc-in" id="dyc-topic" maxlength="80" placeholder="The year you would relive" autofocus></label>' +
      '<label class="dyc-field"><span>A name, if you like</span><input class="dyc-in" id="dyc-name" maxlength="40" placeholder="Optional"></label>' +
      '<div class="dyc-field"><span>Who can come in?</span><div class="dyc-modes" role="radiogroup">' +
      Object.keys(MODES).map(function (m) { return '<button type="button" role="radio" aria-checked="' + (m === mode) + '" class="dyc-mode' + (m === mode ? ' on' : '') + '" data-m="' + m + '"><b>' + MODES[m][0] + '</b><i>' + MODES[m][1] + '</i></button>'; }).join('') +
      '</div></div>' +
      (opts.star ? '' : '<label class="dyc-field"><span>Where</span><select class="dyc-in" id="dyc-temple">' + tOpts + '</select></label>') +
      '<button class="dyc-btn" id="dyc-light">Open the circle</button>', true);
    sheet.querySelectorAll('[data-m]').forEach(function (b) {
      b.onclick = function () { mode = b.dataset.m; sheet.querySelectorAll('[data-m]').forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); }); buzz(); };
    });
    $('#dyc-light', sheet).onclick = function () {
      var topic = $('#dyc-topic', sheet).value.trim(); if (!topic) { say('Give your circle a theme.'); $('#dyc-topic', sheet).focus(); return; }
      var b = this; b.disabled = true;
      var body = { topic: topic, name: $('#dyc-name', sheet).value.trim(), mode: mode, wx: Math.round(Math.random() * 800 - 400), wy: Math.round(Math.random() * 600 - 300) };
      if (opts.star) body.star_id = opts.star.id; else body.temple = $('#dyc-temple', sheet).value;
      api('new', body).then(function (r) {
        b.disabled = false; if (!r.ok) return say(r.error);
        buzz('success'); S.cid = r.cid; S.lines = []; S.after = 0;
        refreshState().then(openInside); refreshSky();
      });
    };
  }

  function openStar(id) {
    api('star', { id: id }).then(function (r) {
      if (!r.ok) { say(r.error); refreshSky(); return; }
      var s = r.star; S.sheet = 'star'; S.sheetData = s;
      var lines = s.lines ? '<div class="dyc-lh" style="margin-left:0">What was said</div><div class="dyc-lines" style="max-height:34dvh">' + s.lines.map(lineHtml).join('') + '</div>' : '';
      showSheet(
        (s.name ? '<div class="dyc-sm" style="margin:0">' + esc(s.topic) + '</div>' : '') + '<h2 class="dyc-st">' + esc(title(s)) + '</h2>' +
        (s.temple ? '<span class="dyc-tag">' + TNAME[s.temple] + '</span>' : '') + '<span class="dyc-tag">Star</span>' +
        (s.line ? '<div class="dyc-pin">\u201c' + esc(s.line) + '\u201d</div>' : '') +
        '<div class="dyc-light"><div style="flex:1"><div class="bar"><i style="width:' + Math.round(s.glow * 100) + '%"></i></div><small>' + (s.glow < .25 ? 'Dimming. Without light it will go out, and everything said in it with it.' : 'Stars dim slowly unless people give them light.') + '</small></div>' +
        '<button class="dyc-give" id="dyc-give">Give light' + (r.left != null ? ' \u00b7 ' + r.left : '') + '</button></div>' +
        lines + '<button class="dyc-btn" id="dyc-around">Start a circle here</button>', !!s.lines);
      $('#dyc-give', sheet).onclick = function () {
        api('light', { kind: 'star', id: s.id }).then(function (x) { if (!x.ok) return say(x.error); buzz('success'); S.left = x.left; say('Light given. ' + x.left + ' left today.'); openStar(s.id); refreshSky(); });
      };
      $('#dyc-around', sheet).onclick = function () { openNew({ star: s }); };
    });
  }

  function lineHtml(l) {
    return '<button class="dyc-ln' + (l.mine ? ' mine' : '') + '" data-mid="' + l.id + '"><span class="a">' + esc(l.mine ? 'You' : l.alias) + ' \u00b7 ' + ago(l.at) + '</span><br><span class="b">' + esc(l.body) + '</span></button>';
  }

  function openInside() {
    var st = S.st; if (!st || !st.cid) { openSky(); return; }
    var c = st.circle; S.sheet = 'inside';
    var pct = Math.min(100, Math.round(100 * Math.min(c.light / c.needs.light, c.givers / c.needs.givers)));
    showSheet(
      '<div style="display:flex;align-items:flex-start;gap:10px"><div style="flex:1;min-width:0">' + (c.name ? '<div class="dyc-sm" style="margin:0">' + esc(c.topic) + '</div>' : '') +
      '<h2 class="dyc-st">' + esc(title(c)) + '</h2></div><button class="dyc-x" id="dyc-min" aria-label="Back to the sky">\u2193</button></div>' +
      (c.temple ? '<span class="dyc-tag">' + TNAME[c.temple] + '</span>' : '') + '<span class="dyc-tag">' + MODES[c.mode][0] + '</span>' +
      (c.iAmFounder ? '<div class="dyc-seg" role="radiogroup" aria-label="Who can come in">' + Object.keys(MODES).map(function (m) { return '<button role="radio" aria-checked="' + (m === c.mode) + '" class="' + (m === c.mode ? 'on' : '') + '" data-mode="' + m + '">' + MODES[m][0] + '</button>'; }).join('') + '</div>' : '') +
      '<div class="dyc-people" id="dyc-ppl"></div><div id="dyc-knocks"></div>' +
      '<div id="dyc-pinned"></div>' +
      '<div class="dyc-lines" id="dyc-lines" aria-live="polite"></div>' +
      '<div class="dyc-compose"><input class="dyc-in" id="dyc-say" maxlength="500" placeholder="Say something" enterkeyhint="send"><button class="dyc-send" id="dyc-send">Send</button></div>' +
      '<div class="dyc-light"><div style="flex:1"><div class="bar"><i id="dyc-bar" style="width:' + pct + '%"></i></div><small id="dyc-lt"></small></div><button class="dyc-give" id="dyc-give">Give light</button></div>' +
      '<div class="dyc-act"><button class="dyc-ghost" id="dyc-inv">Invite someone</button><button class="dyc-ghost" id="dyc-out">Step out</button></div>', true, true);
    paintInside(true);
    $('#dyc-min', sheet).onclick = function () { hideSheet(); if (!S.open) openSky(); };
    sheet.querySelectorAll('[data-mode]').forEach(function (b) {
      b.onclick = function () { api('mode', { mode: b.dataset.mode }).then(function (r) { if (!r.ok) return say(r.error); buzz('success'); say(MODES[r.mode][1]); refreshState().then(openInside); refreshSky(); }); };
    });
    var input = $('#dyc-say', sheet);
    function send() {
      var t = input.value.trim(); if (!t) return; input.value = '';
      api('say', { text: t }).then(function (r) { if (!r.ok) { input.value = t; return say(r.error); } refreshState(); });
    }
    $('#dyc-send', sheet).onclick = send;
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    $('#dyc-give', sheet).onclick = function () {
      api('light', { kind: 'circle', id: S.cid }).then(function (r) { if (!r.ok) return say(r.error); buzz('success'); S.left = r.left; say('Light given. ' + r.left + ' left today.'); refreshState(); });
    };
    $('#dyc-inv', sheet).onclick = openInvite;
    var out = $('#dyc-out', sheet);
    out.onclick = function () {
      if (!out.dataset.sure) { out.dataset.sure = 1; out.textContent = 'Tap again to step out'; return; }
      api('leave').then(function () { buzz('success'); S.cid = 0; S.st = null; S.lines = []; S.after = 0; hideSheet(); paintBanners(); refreshSky(); if (!S.open) openSky(); });
    };
    $('#dyc-lines', sheet).addEventListener('click', function (e) {
      var ln = e.target.closest('[data-mid]'); if (!ln) return;
      var cc = S.st.circle; if (cc.pinned && !cc.iAmFounder) return;
      if (ln.dataset.ask) { api('pin', { mid: +ln.dataset.mid }).then(function (r) { if (!r.ok) return say(r.error); buzz('success'); say('Kept as this circle\u2019s line.'); refreshState(); }); return; }
      sheet.querySelectorAll('[data-ask]').forEach(function (x) { delete x.dataset.ask; });
      ln.dataset.ask = 1; say('Tap the line again to keep it as this circle\u2019s line.');
    });
  }

  function paintInside(scrollEnd) {
    if (S.sheet !== 'inside' || !S.st || !S.st.cid) return;
    var st = S.st, c = st.circle;
    $('#dyc-ppl', sheet).innerHTML = st.members.map(function (m) { return '<span class="dyc-p' + (m.founder ? ' f' : '') + '">' + esc(m.me ? 'You' : m.alias) + (m.founder ? ' \u00b7 founder' : '') + '</span>'; }).join('');
    var kh = '';
    if (st.knocks && st.knocks.length) {
      if (!c.iAmFounder) kh += '<p class="dyc-sm" style="margin-top:10px">' + esc(c.founder) + ' has stepped away, so anyone inside can answer.</p>';
      st.knocks.forEach(function (k) {
        kh += '<div class="dyc-knock"><p>' + (k.sponsor ? esc(k.sponsor) + ' wants to bring <b>' + esc(k.alias) + '</b>' : '<b>' + esc(k.alias) + '</b> is knocking') + '</p>' +
          '<button class="dyc-ghost" data-k="' + k.kid + '" data-a="in">Let in</button><button class="dyc-ghost" data-k="' + k.kid + '" data-a="no" aria-label="Not now">\u00d7</button></div>';
      });
    }
    var kn = $('#dyc-knocks', sheet); kn.innerHTML = kh;
    kn.querySelectorAll('[data-k]').forEach(function (b) {
      b.onclick = function () { api('answer', { kid: +b.dataset.k, yes: b.dataset.a === 'in' }).then(function (r) { if (!r.ok) return say(r.error); buzz(b.dataset.a === 'in' ? 'success' : ''); refreshState(); }); };
    });
    $('#dyc-pinned', sheet).innerHTML = c.pinned ? '<div class="dyc-pin">\u201c' + esc(c.pinned.body) + '\u201d</div>' : '';
    var box = $('#dyc-lines', sheet), near = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = S.lines.length ? S.lines.map(lineHtml).join('') : '<p class="dyc-sm" style="text-align:center;margin-top:30px">Nothing said yet. Begin.</p>';
    if (scrollEnd || near) box.scrollTop = box.scrollHeight;
    var pct = Math.min(100, Math.round(100 * Math.min(c.light / c.needs.light, c.givers / c.needs.givers)));
    $('#dyc-bar', sheet).style.width = pct + '%';
    $('#dyc-lt', sheet).textContent = pct >= 100 ? 'Bright enough. When everyone leaves, this circle becomes a star.' :
      c.light + ' of ' + c.needs.light + ' light, from ' + c.givers + ' of ' + c.needs.givers + ' people. Otherwise it disperses when everyone leaves.';
    $('#dyc-give', sheet).textContent = 'Give light' + (st.left != null ? ' \u00b7 ' + st.left : '');
  }

  function openInvite() {
    api('people').then(function (r) {
      if (!r.ok) return say(r.error);
      var here = {}; (S.st.members || []).forEach(function (m) { here[m.alias] = 1; });
      var c = S.st.circle, direct = c.mode === 'open' || c.iAmFounder;
      S.sheet = 'invite';
      showSheet('<h2 class="dyc-st">Invite someone</h2><p class="dyc-sm">' + (direct ? 'They\u2019ll see your invitation and can come straight in.' : 'Your invitation goes to ' + esc(c.founder) + ' as a knock. They decide.') + '</p>' +
        '<div class="dyc-lines" style="max-height:60dvh">' + r.people.filter(function (p) { return !here[p.alias]; }).map(function (p) {
          return '<button class="dyc-row" data-pid="' + esc(p.pid) + '"><span class="t"><span class="n">' + esc(p.alias) + '</span>' + (p.temple ? '<span class="m">' + esc(TNAME[p.temple] || '') + '</span>' : '') + '</span></button>';
        }).join('') + '</div><button class="dyc-btn" id="dyc-back">Back to the circle</button>', true);
      sheet.querySelectorAll('[data-pid]').forEach(function (b) {
        b.onclick = function () { b.disabled = true; api('invite', { pid: b.dataset.pid }).then(function (x) { if (!x.ok) { b.disabled = false; return say(x.error); } buzz('success'); b.querySelector('.m') ? (b.querySelector('.m').textContent = x.sent === 'knock' ? 'Sent as a knock' : 'Invited') : (b.innerHTML += '<span class="m">' + (x.sent === 'knock' ? 'Sent as a knock' : 'Invited') + '</span>'); }); };
      });
      $('#dyc-back', sheet).onclick = openInside;
    });
  }

  // ---------- open/close ----------
  function openSky() {
    S.open = true; root.classList.add('on'); paintRooms(); paintBanners(); paintSky();
    requestAnimationFrame(function () { size(); startDraw(); });
    refreshSky(); schedule(true);
  }
  function closeAll() { hideSheet(); S.open = false; root.classList.remove('on'); cancelAnimationFrame(raf); raf = 0; schedule(true); }

  // ---------- polling ----------
  function absorb(r) {
    if (!r || !r.ok) return;
    var was = S.knock;
    S.invites = r.invites || []; S.knock = r.knock || null;
    if (r.left != null) S.left = r.left;
    // My own knock was approved: fly straight in, as the app does today.
    if (was && was.status === 'waiting' && !S.cid) {
      var let_ = S.invites.filter(function (i) { return i.id === was.id && i.how === 'let-in'; })[0];
      if (let_) { S.knock = null; joinCircle(let_.id); }
    }
    paintBanners();
  }
  function refreshSky() {
    return api('sky').then(function (r) {
      if (!r.ok) { $('#dyc-sub').textContent = r.error || ''; return; }
      S.sky = r; if (r.cid !== S.cid) { S.cid = r.cid; if (!r.cid) { S.st = null; S.lines = []; S.after = 0; } }
      absorb(r); paintSky();
    });
  }
  function refreshState() {
    return api('state', { after: S.after }).then(function (r) {
      if (!r.ok) return;
      absorb(r);
      if (!r.cid) {
        if (S.cid) { S.cid = 0; S.st = null; S.lines = []; S.after = 0; if (S.sheet === 'inside') { hideSheet(); say('You stepped out of the circle.'); } }
        paintBanners(); return;
      }
      if (r.cid !== S.cid) { S.lines = []; S.after = 0; }
      S.cid = r.cid; S.st = r;
      (r.lines || []).forEach(function (l) { if (l.id > S.after) { S.lines.push(l); S.after = l.id; } });
      if (S.lines.length > 400) S.lines.splice(0, S.lines.length - 400);
      paintBanners(); paintInside(false);
    });
  }
  var timer = 0;
  function schedule(now) {
    clearTimeout(timer);
    if (document.visibilityState === 'hidden') return; // the server's 2 minute grace covers quick switches
    var fast = S.cid || (S.knock && S.knock.status === 'waiting');
    var wait = fast ? 3000 : S.open ? 6000 : 20000;
    timer = setTimeout(tick, now ? 0 : wait);
  }
  function tick() {
    var p = (S.cid || (S.knock && S.knock.status === 'waiting') || !S.open) ? refreshState() : Promise.resolve();
    (S.open ? Promise.all([p, refreshSky()]) : p).then(function () { schedule(); }, function () { schedule(); });
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') schedule(true); else clearTimeout(timer); });

  // ---------- launcher visibility: show it where the app shows its tab bar ----------
  function launcherWatch() {
    var tb = document.getElementById('tabbar');
    var on = !tb || (getComputedStyle(tb).display !== 'none' && getComputedStyle(tb).visibility !== 'hidden');
    if (S.open) on = false;
    launch.classList.toggle('on', on);
  }
  setInterval(launcherWatch, 500);

  // public hooks for the app and for tests
  window.dyCircles = { open: openSky, close: closeAll, refresh: function () { return Promise.all([refreshSky(), refreshState()]); }, state: S };
  schedule(true);
})();
