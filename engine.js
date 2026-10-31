/* V Player engine: runs before index.html. It does not change index.html.
   1. Shorts play through the phone's own player (ExoPlayer) when it is available.
      If anything fails, the old in-app player is used for that video.
   2. The video and song list is remembered, so the app shows it at once on every open.
      The phone is scanned in the background and new files are added on their own.
   3. The phone Back button goes one step back. On the main screen, press twice to exit. */
(function () {
  'use strict';
  var doc = document;
  function R() { return doc.documentElement; }
  /* small check strip at the top-left, hides itself after 25 seconds */
  var DL = [], dT = 0;
  function dbg(m) {
    try {
      DL.push(m); if (DL.length > 9) DL.shift();
      var paint = function () {
        var d = doc.getElementById('engdbg');
        if (!d) {
          d = doc.createElement('div'); d.id = 'engdbg';
          d.style.cssText = 'position:fixed;top:64px;left:6px;z-index:9999;max-width:92%;font:11px/1.35 monospace;color:#9f9;background:rgba(0,0,0,.78);padding:5px 8px;border-radius:8px;pointer-events:none;white-space:pre-wrap;word-break:break-all';
          (doc.body || R()).appendChild(d);
        }
        d.style.display = ''; d.textContent = DL.join('\n');
        clearTimeout(dT); dT = setTimeout(function () { d.style.display = 'none'; }, 25000);
      };
      if (doc.body) paint(); else doc.addEventListener('DOMContentLoaded', paint, { once: true });
    } catch (e) {}
  }
  dbg('engine.js loaded');
  window.addEventListener('error', function (ev) { dbg('JS error: ' + (ev.message || '?')); });
  var Cap = window.Capacitor;
  if (!Cap) { dbg('stopped: Capacitor missing'); return; }
  var isNative = false;
  try { isNative = Cap.isNativePlatform(); } catch (e) {}
  if (!isNative) { dbg('stopped: not a native app'); return; }

  function $(s) { return doc.querySelector(s); }
  function noop() {}

  /* ---------- looks ---------- */
  var st = doc.createElement('style');
  st.textContent =
    'html.eng-on,html.eng-on body{background:transparent!important}' +
    'html.eng-on #app,html.eng-on .panel,html.eng-on #player{visibility:hidden!important}' +
    'html.eng-on #reels{background:transparent!important}' +
    '.reel.eng-live{background:transparent!important}' +
    '.reel video[data-eng]{background:transparent!important}';
  function addStyle() { var t = doc.head || R(); if (t) t.appendChild(st); else doc.addEventListener('DOMContentLoaded', addStyle, { once: true }); }
  addStyle();

  /* on this phone the Capacitor object may not have registerPlugin; plugins are then read from Capacitor.Plugins */
  var origReg = (typeof Cap.registerPlugin === 'function')
    ? Cap.registerPlugin.bind(Cap)
    : function (n) { return Cap.Plugins ? Cap.Plugins[n] : undefined; };
  var VE = null;
  try { VE = origReg('VEngine'); } catch (e) { VE = null; }
  var engOK = !!VE;
  dbg('registerPlugin: ' + (typeof Cap.registerPlugin === 'function' ? 'yes' : 'no, using Plugins'));
  dbg('plugin object: ' + (VE ? 'yes' : 'no'));

  function call(name, args) {
    if (!VE) return Promise.reject(new Error('no engine'));
    try { return Promise.resolve(VE[name](args || {})); } catch (e) { return Promise.reject(e); }
  }

  /* ================= 1. list that opens at once + background scan ================= */
  var KEY = 'vp-scan-cache', skipBg = false;
  function readCache() {
    try {
      var s = localStorage.getItem(KEY);
      if (!s) return null;
      var a = JSON.parse(s);
      return (Array.isArray(a) && a.length) ? a : null;
    } catch (e) { return null; }
  }
  function writeCache(a) { try { localStorage.setItem(KEY, JSON.stringify(a || [])); } catch (e) {} }
  function sig(a) {
    var s = a.length + '|';
    for (var i = 0; i < a.length; i++) s += a[i].id + ':' + a[i].name + '|';
    return s;
  }
  function refreshApp() {
    var b = doc.createElement('button');
    b.setAttribute('data-act', 'rescan');
    b.hidden = true;
    (doc.body || R()).appendChild(b);
    b.click();
    b.remove();
  }
  function scanFn(p) {
    var useSkip = skipBg; skipBg = false;
    var c = readCache();
    if (c) {
      if (!useSkip) {
        var s0 = sig(c);
        Promise.resolve(p.scan()).then(function (r) {
          var it = (r && r.items) || [];
          writeCache(it);
          if (sig(it) !== s0) { skipBg = true; refreshApp(); }
        }).catch(noop);
      }
      return Promise.resolve({ items: c });
    }
    return Promise.resolve(p.scan()).then(function (r) { writeCache((r && r.items) || []); return r; });
  }
  Cap.registerPlugin = function (name) {
    var p = origReg.apply(null, arguments);
    if (name !== 'MediaScan') return p;
    return new Proxy(p, {
      get: function (t, k) { return k === 'scan' ? function () { return scanFn(p); } : t[k]; }
    });
  };

  /* ================= 2. shorts through the phone's player ================= */
  var HM = HTMLMediaElement.prototype;
  var dSrc = Object.getOwnPropertyDescriptor(HM, 'src');
  var dCT = Object.getOwnPropertyDescriptor(HM, 'currentTime');
  var dMuted = Object.getOwnPropertyDescriptor(HM, 'muted');
  var dRate = Object.getOwnPropertyDescriptor(HM, 'playbackRate');
  var dVol = Object.getOwnPropertyDescriptor(HM, 'volume');
  var dDur = Object.getOwnPropertyDescriptor(HM, 'duration');
  var dPaused = Object.getOwnPropertyDescriptor(HM, 'paused');
  var oPlay = HM.play, oPause = HM.pause, oLoad = HM.load;

  var seq = 0, active = null, relT = 0, dragging = false, nFirst = 0, nOpen = 0;
  /* picture shown while a short has no thumbnail yet: never the grey play picture of the phone */
  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  var thumbMem = {}, thumbKeys = [];
  function applyThumb(e, u) { if (e.v.getAttribute('poster') === BLANK) e.v.poster = u; }
  function wantPoster(e) {
    /* no frame is pulled from the file here, so nothing can slow the video down; the real thumbnail, when the app already has one, is set by the app itself */
    e.v.poster = BLANK;
  }

  function parsePath(u) {
    var m = String(u).match(/\/_capacitor_file_(\/.*)$/);
    if (!m) return null;
    try { return decodeURI(m[1]); } catch (e) { return m[1]; }
  }
  function reelOf(e) {
    var n = e.v.parentNode;
    return n && n.classList ? n : null;
  }
  function live(e) {
    e.v.style.visibility = 'hidden';
    var r = reelOf(e); if (r) r.classList.add('eng-live');
    R().classList.add('eng-on');
  }
  function unlive(e) {
    /* During a finger drag the native TextureView cannot follow the WebView's
       translated reel. Keep the empty HTML video hidden and reveal the reel's
       prepared poster image underneath it instead of flashing a black frame. */
    e.v.style.visibility = 'hidden';
    var r = reelOf(e); if (r) r.classList.remove('eng-live');
  }
  function stopNative() {
    if (active) return;
    call('stop').catch(noop);
    R().classList.remove('eng-on');
  }
  function activate(e) {
    clearTimeout(relT);
    if (active && active !== e) unlive(active);
    active = e; e.ready = false; e.opened = true; e.pos = e.seek;
    var r = reelOf(e);
    var fit = (r && r.classList.contains('tall')) ? 'cover' : 'contain';
    call('open', {
      id: e.id, path: e.path, fit: fit, pos: Math.round(e.seek * 1000),
      play: !e.paused, muted: e.muted, rate: e.rate, vol: e.vol
    }).then(function () { if (++nOpen <= 3) dbg('open sent'); }, function (err) { dbg('open FAILED: ' + ((err && err.message) || err)); fail(e); });
  }
  function fail(e) {
    if (e.fb) return;
    e.fb = true;
    var wasActive = (active === e);
    if (wasActive) active = null;
    unlive(e);
    e.v.style.visibility = '';
    e.v.removeAttribute('data-eng');
    if (wasActive) { call('stop').catch(noop); R().classList.remove('eng-on'); }
    dSrc.set.call(e.v, e.url);
    if (!e.paused) { var p = oPlay.call(e.v); if (p && p.catch) p.catch(noop); }
  }
  function manage(v, url, path) {
    var e = {
      v: v, url: url, path: path, id: ++seq, pos: 0, dur: 0, paused: true,
      muted: !!v.muted, rate: 1, vol: 1, ready: false, fb: false, opened: false, seek: 0, w: 0, h: 0
    };
    v._e = e;
    v.setAttribute('data-eng', '1');
    wantPoster(e);
    Object.defineProperties(v, {
      play: { configurable: true, writable: true, value: function () {
        if (e.fb) return oPlay.call(v);
        e.paused = false;
        if (active === e && e.opened) { call('play').catch(noop); if (e.ready && !dragging) live(e); }
        else activate(e);
        return Promise.resolve();
      } },
      pause: { configurable: true, writable: true, value: function () {
        if (e.fb) return oPause.call(v);
        e.paused = true;
        if (active === e) call('pause').catch(noop);
      } },
      load: { configurable: true, writable: true, value: function () {
        if (e.fb) return oLoad.call(v);
        if (active === e) { active = null; unlive(e); clearTimeout(relT); relT = setTimeout(stopNative, 120); }
        e.opened = false;
      } },
      currentTime: { configurable: true,
        get: function () { return e.fb ? dCT.get.call(v) : e.pos; },
        set: function (x) {
          if (e.fb) { dCT.set.call(v, x); return; }
          x = Number(x) || 0; e.pos = x; e.seek = x;
          if (active === e && e.opened) call('seek', { ms: Math.round(x * 1000) }).catch(noop);
        } },
      duration: { configurable: true, get: function () { return e.fb ? dDur.get.call(v) : (e.dur > 0 ? e.dur : NaN); } },
      paused: { configurable: true, get: function () { return e.fb ? dPaused.get.call(v) : e.paused; } },
      muted: { configurable: true,
        get: function () { return e.fb ? dMuted.get.call(v) : e.muted; },
        set: function (x) {
          if (e.fb) { dMuted.set.call(v, x); return; }
          e.muted = !!x; if (active === e) call('setMuted', { muted: e.muted }).catch(noop);
        } },
      playbackRate: { configurable: true,
        get: function () { return e.fb ? dRate.get.call(v) : e.rate; },
        set: function (x) {
          if (e.fb) { dRate.set.call(v, x); return; }
          e.rate = Number(x) || 1; if (active === e) call('setRate', { rate: e.rate }).catch(noop);
        } },
      volume: { configurable: true,
        get: function () { return e.fb ? dVol.get.call(v) : e.vol; },
        set: function (x) {
          if (e.fb) { dVol.set.call(v, x); return; }
          e.vol = Math.max(0, Math.min(1, Number(x))); if (active === e) call('setVol', { value: e.vol }).catch(noop);
        } },
      videoWidth: { configurable: true, get: function () { return e.w; } },
      videoHeight: { configurable: true, get: function () { return e.h; } },
      readyState: { configurable: true, get: function () { return e.ready ? 4 : 0; } }
    });
  }
  /* only shorts are taken (they have loop turned on); the thumbnail maker and the long player are not touched */
  Object.defineProperty(HM, 'src', {
    configurable: true,
    get: function () { return this._e ? this._e.url : dSrc.get.call(this); },
    set: function (val) {
      var p;
      if (this._e) { this._e.url = val; if (this._e.fb) dSrc.set.call(this, val); return; }
      if (engOK && this.loop === true && (p = parsePath(val))) { manage(this, String(val), p); return; }
      dSrc.set.call(this, val);
    }
  });

  if (VE) {
    try {
      VE.addListener('state', function (s) {
        if (!active || s.id !== active.id) return;
        var e = active;
        e.pos = s.pos / 1000;
        if (s.dur > 0) e.dur = s.dur / 1000;
        if (s.w) { e.w = s.w; e.h = s.h; }
        e.v.dispatchEvent(new Event('timeupdate'));
      });
      VE.addListener('first', function (s) {
        if (!active || s.id !== active.id) return;
        active.ready = true;
        if (++nFirst <= 2) dbg('first frame ok; view vis=' + s.vis + ' box=' + s.bw + 'x' + s.bh + ' tv=' + s.tw + 'x' + s.th + ' tex=' + s.tex + ' in ' + s.par + ' wv=' + s.wv);
        if (!dragging) live(active);
      });
      VE.addListener('error', function (s) {
        if (active && s.id === active.id) { dbg('player error: ' + (s.msg || '?')); fail(active); }
      });
    } catch (e) { engOK = false; }
  }

  /* while the page is dragged, the picture is shown again so it moves with the finger */
  var dg = null;
  doc.addEventListener('pointerdown', function (ev) { dg = { x: ev.clientX, y: ev.clientY, on: false }; }, true);
  doc.addEventListener('pointermove', function (ev) {
    if (!dg || dg.on || !active) return;
    var dx = ev.clientX - dg.x, dy = ev.clientY - dg.y;
    if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx) && ev.target && ev.target.closest &&
        ev.target.closest('#reels') && !ev.target.closest('.rprog')) {
      dg.on = true; dragging = true; unlive(active);
    }
  }, true);
  function dragEnd() {
    dg = null;
    setTimeout(function () {
      dragging = false;
      /* If the gesture snapped back to the same short, restore its native layer. */
      if (active && active.ready && !active.paused) live(active);
    }, 0);
  }
  doc.addEventListener('pointerup', dragEnd, true);
  doc.addEventListener('pointercancel', dragEnd, true);

  doc.addEventListener('visibilitychange', function () {
    if (!doc.hidden && active && !active.paused && active.opened) call('play').catch(noop);
  });

  /* ================= 3. phone Back button ================= */
  var tt = 0, lastBack = 0;
  function toast(m) {
    var t = $('#toast'); if (!t) return;
    t.textContent = m; t.hidden = false; clearTimeout(tt);
    tt = setTimeout(function () { t.hidden = true; }, 2000);
  }
  function vis(id) { var el = doc.getElementById(id); return !!(el && !el.hidden); }
  function stepBack() {
    var got = false;
    var h = function () { got = true; };
    window.addEventListener('popstate', h, { once: true });
    try { history.back(); } catch (e) {}
    setTimeout(function () {
      window.removeEventListener('popstate', h);
      if (!got) window.dispatchEvent(new PopStateEvent('popstate'));
    }, 150);
  }
  function onBack() {
    dbg('back pressed');
    if (vis('modal')) { doc.getElementById('modal').hidden = true; return; }
    if (vis('sheet')) { doc.getElementById('sheet').hidden = true; return; }
    var L = ['reels', 'player', 'now', 'recent', 'settings'];
    for (var i = 0; i < L.length; i++) if (vis(L[i])) { stepBack(); return; }
    if (vis('srch')) { var b = $('#bSearch'); if (b) b.click(); return; }
    var t = Date.now();
    if (t - lastBack < 2000) { call('exit').catch(noop); }
    else { lastBack = t; toast('Press back again to exit'); }
  }
  if (VE) {
    try {
      VE.addListener('back', onBack);
      Promise.resolve(VE.setBackReady()).then(function () { dbg('back button hooked'); }, function (er) { engOK = false; dbg('back hook FAILED: ' + ((er && er.message) || er)); });
      Promise.resolve(VE.ping()).then(function (r) { dbg('plugin ping ok, android ' + (r && r.sdk)); }, function (er) { dbg('plugin ping FAILED: ' + ((er && er.message) || er)); });
    } catch (e) { engOK = false; }
  }
})();
