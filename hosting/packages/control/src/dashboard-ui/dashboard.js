'use strict';
/* Basalt owner dashboard. No dependencies: polls /dashboard/api/state and redraws the open
 * section. Charts are hand-drawn SVG. Server text always passes through esc() before innerHTML. */
(function () {
  var P = {
    home:'<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-5h4v5"/>',
    people:'<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2c3 .2 5.5 2.6 5.5 5.8"/>',
    speed:'<path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 18 4-6"/><circle cx="12" cy="18" r="1.3"/>',
    shield:'<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6L12 3Z"/><path d="m8.8 12 2.3 2.3 4.2-4.6"/>',
    rocket:'<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2"/><path d="M9 15 6 12c1-3.5 5-9 12-9 0 7-5.5 11-9 12Z"/><circle cx="14.5" cy="9.5" r="1.6"/>',
    alert:'<path d="M12 3.5 2.5 20h19L12 3.5Z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r=".6"/>',
    list:'<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.8" cy="6" r=".9"/><circle cx="3.8" cy="12" r=".9"/><circle cx="3.8" cy="18" r=".9"/>',
    check:'<path d="m5 12.5 4.5 4.5L19 7.5"/>', x:'<path d="M6 6l12 12M18 6 6 18"/>',
    clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    moon:'<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
    out:'<path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    ban:'<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
    unlock:'<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8.5 11V7.5a3.5 3.5 0 0 1 6.8-1.2"/>',
    star:'<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z"/>',
    globe:'<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5Z"/>',
    eye:'<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
    bolt:'<path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12l1-8Z"/>',
    laptop:'<rect x="4.5" y="5" width="15" height="10.5" rx="1.5"/><path d="M2.5 19h19"/>',
    database:'<ellipse cx="12" cy="6" rx="7.5" ry="2.8"/><path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
    bug:'<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M12 8V5.5M3.5 13H7M17 13h3.5M4.5 8.5 7 10M19.5 8.5 17 10M4.5 18.5 7 17M19.5 18.5 17 17"/>',
    pulse:'<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>', pointer:'<path d="M6 3.5 18 12l-5.2 1.2L10.5 19 6 3.5Z"/>',
    dots:'<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
    search:'<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'
  };
  function ic(n){ return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">'+(P[n]||'')+'</svg>'; }
  window.__dash = { P: P, ic: ic };
})();

/* ---- part 2: helpers, formatting, state ------------------------------------------------ */
(function (D) {
  var ic = D.ic;
  D.esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); };
  var esc = D.esc;
  D.$ = function (s, r) { return (r || document).querySelector(s); };
  var nf = new Intl.NumberFormat();
  D.fmt = function (n) { return nf.format(Math.round(n || 0)); };
  D.short = function (n) { n = n || 0; return n >= 1e6 ? (n/1e6).toFixed(n>=1e7?0:1)+'M' : n >= 1e4 ? Math.round(n/1e3)+'k' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : D.fmt(n); };
  D.pct = function (a, b) { return b ? Math.round(1000*a/b)/10 : 0; };
  D.plural = function (n, one, many) { return D.fmt(n)+' '+(n===1?one:(many||one+'s')); };
  D.clock = function (t) { return new Date(t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); };
  D.when = function (t) { return new Date(t).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); };
  D.ago = function (t) { if (!t) return 'never'; var s = Math.max(0,(Date.now()-new Date(t).getTime())/1000); return s<45?'just now':s<3600?Math.round(s/60)+' min ago':s<86400?Math.round(s/3600)+' h ago':Math.round(s/86400)+' d ago'; };
  D.until = function (t) { var s = Math.max(0,(new Date(t).getTime()-Date.now())/1000); return s<60?'less than a minute':s<3600?Math.round(s/60)+' min':Math.round(s/3600)+' h'; };
  /* The edge's client key: IPv4 as-is, IPv6 per /64 (mirrors ipBucket on the server). */
  D.bucket = function (ip) {
    var m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip); if (m) return m[1];
    if (ip.indexOf(':') < 0 || /\/64$/.test(ip)) return ip;
    var parts = ip.split('::'), head = parts[0] || '', tail = parts[1] || '';
    var h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
    var groups = ip.indexOf('::') >= 0 ? h.concat(Array(Math.max(0, 8-h.length-t.length)).fill('0'), t) : h;
    return groups.slice(0,4).map(function (g) { return g.toLowerCase().padStart(4,'0'); }).join(':')+'::/64';
  };
  D.REASONS = {
    attack_signature:{l:'Tried to break in',d:'Sent attack code (like database tricks or scripts) in a web address.'},
    scanner_path:{l:'Looked for secret files',d:'Asked for files that hold passwords or admin pages, the way hacking tools do.'},
    bad_encoding:{l:'Sent scrambled data',d:'A web address garbled on purpose to slip past checks.'},
    bad_request:{l:'Sent a broken request',d:'A malformed request, usually from a hacking tool.'},
    bad_method:{l:'Used an odd request type',d:'A request type normal browsers never send.'},
    rate_limited:{l:'Too many requests',d:'Far more requests than a person could make.'},
    ip_concurrency:{l:'Too many at once',d:'Opened too many connections at the same time.'},
    banned:{l:'Kept trying while blocked',d:'Came back while already blocked.'},
    challenge_failed:{l:'Failed the robot check',d:'Could not prove it was a real browser.'}
  };
  D.reason = function (r) { return D.REASONS[r] || { l: String(r||'Blocked').replace(/_/g,' '), d:'' }; };
  D.STEPS = { extract:'Unpack','security-scan':'Security scan', detect:'Detect', lockfile:'Lockfile', install:'Install', audit:'Check packages', typecheck:'Check code', lint:'Tidy check','unit-tests':'Tests', build:'Build', package:'Package', static:'Website files', image:'Bundle' };
  D.ENV_LABEL = { production:'Live site', staging:'Final check', preview:'Preview' };
  D.envLabel = function (e) { var nm = e.name || e.env; return e.kind === 'preview' ? 'Preview '+nm : (D.ENV_LABEL[e.kind] || e.name); };
  D.STATUS = { up:{l:'Online',c:'good'}, sleeping:{l:'Resting',c:'info'}, down:{l:'Not answering',c:'critical'}, starting:{l:'Starting',c:'warning'}, not_deployed:{l:'Nothing live yet',c:'warning'} };
  D.chip = function (c, t, i) { return '<span class="chip '+c+'">'+(i?ic(i):'')+esc(t)+'</span>'; };
  D.emptySmall = function (t) { return '<p class="muted small">'+esc(t)+'</p>'; };
})(window.__dash);

/* ---- part 3: state, server polling, chrome, router ------------------------------------- */
(function (D) {
  var esc = D.esc, ic = D.ic, $ = D.$;
  var TABS = [
    { id:'home', label:'Overview', icon:'home' },
    { id:'visitors', label:'Visitors', icon:'people' },
    { id:'health', label:'Speed & errors', icon:'speed' },
    { id:'security', label:'Security', icon:'shield' },
    { id:'updates', label:'Updates', icon:'rocket' },
    { id:'problems', label:'Problems', icon:'alert' },
    { id:'logs', label:'Activity log', icon:'list' }
  ];
  var ui = D.ui = { tab:'home', app:null, env:null, range:'24h', logs:'visits', problems:'all', ipFilter:'', search:'' };
  D.data = null;
  var lastOk = 0;
  D.charts = new Map();

  D.readHash = function () {
    var p = location.hash.slice(1).split('?'), tab = p[0], q = new URLSearchParams(p[1] || '');
    if (TABS.some(function (t) { return t.id === tab; })) ui.tab = tab;
    if (q.get('app')) ui.app = q.get('app');
    if (q.get('env')) ui.env = q.get('env');
  };
  D.writeHash = function () {
    var q = new URLSearchParams();
    if (ui.app) q.set('app', ui.app);
    if (ui.env) q.set('env', ui.env);
    history.replaceState(null, '', '#'+ui.tab+'?'+q);
  };

  D.api = function (path, opts) {
    opts = opts || {};
    return fetch('/dashboard/api'+path, {
      method: opts.method || 'GET', credentials:'same-origin',
      headers: opts.body ? { 'content-type':'application/json', 'x-basalt-dashboard':'1' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok) throw new Error(j.error || 'The dashboard answered '+res.status+'.');
        return j;
      });
    });
  };

  function setLive(ok, why) {
    var el = $('#live');
    el.className = 'live '+(ok ? 'on' : 'off');
    $('#live-text').textContent = ok ? 'Live' : (why ? 'Reconnecting…' : 'Offline');
    el.title = ok ? 'Updated '+D.clock(lastOk) : (why || '');
  }

  D.refresh = function () {
    var q = new URLSearchParams();
    if (ui.app) q.set('app', ui.app);
    if (ui.env) q.set('env', ui.env);
    return D.api('/state?'+q).then(function (d) {
      D.data = d; lastOk = Date.now();
      if (d.selected) { ui.app = d.selected.app; ui.env = d.selected.env; }
      setLive(true); D.render();
    }).catch(function (err) {
      setLive(false, err.message);
      if (!D.data) $('#view').innerHTML = '<div class="card"><div class="empty">'+ic('alert')+'<b>Couldn’t load your dashboard</b><span>'+esc(err.message)+'</span></div></div>';
    });
  };

  D.renderChrome = function () {
    var probs = D.appIncidents().filter(function (i) { return i.ongoing && i.severity !== 'info'; }).length;
    var banned = D.data.security.bans.length;
    $('#nav').innerHTML = TABS.map(function (t) {
      var badge = t.id==='problems' && probs ? '<span class="badge">'+probs+'</span>' : t.id==='security' && banned ? '<span class="badge soft" title="Visitors blocked right now">'+banned+'</span>' : '';
      return '<button class="nav-item" data-tab="'+t.id+'" '+(ui.tab===t.id?'aria-current="page"':'')+'>'+ic(t.icon)+'<span class="n-label">'+esc(t.label)+'</span>'+badge+'</button>';
    }).join('');
    var appSel = $('#app'), names = D.data.apps.map(function (a) { return a.name; });
    if (appSel.dataset.names !== names.join(',') || appSel.value !== ui.app) {
      appSel.innerHTML = names.length ? names.map(function (n) { return '<option value="'+esc(n)+'" '+(n===ui.app?'selected':'')+'>'+esc(n)+'</option>'; }).join('') : '<option>No apps yet</option>';
      appSel.dataset.names = names.join(',');
    }
    $('#envs').innerHTML = D.envsOfApp().map(function (e) { return '<button class="env-pill" role="tab" data-env="'+esc(e.name)+'" aria-selected="'+(e.name===ui.env)+'"><span class="sdot '+esc(e.status)+'" aria-hidden="true"></span>'+esc(D.envLabel(e))+'</button>'; }).join('');
    var s = D.sel(), visit = $('#visit');
    visit.hidden = !s;
    if (s) visit.href = D.openHref(s);
  };

  // Production opens at its address; test versions are private, so the dashboard mints a share link.
  D.openHref = function (s) { return '/dashboard/api/open?app='+encodeURIComponent(s.app)+'&env='+encodeURIComponent(s.env); };

  // Claude asked to delete an app: only the owner's Confirm here deletes it.
  D.deletionRequests = function () {
    return (D.data.pendingDeletions || []).map(function (p) {
      return '<div class="verdict critical del-req" role="alert"><div class="v-icon">'+ic('alert')+'</div><div><h2>'+esc(p.message)+'</h2><p>Claude asked to delete it. Nothing is removed until you tap Confirm.</p></div>'+
        '<div class="v-actions"><button class="btn secondary" type="button" data-del-cancel="'+esc(p.app)+'">Cancel</button><button class="btn danger" type="button" data-del-confirm="'+esc(p.app)+'">Confirm</button></div></div>';
    }).join('');
  };

  D.sel = function () { return D.data && D.data.selected; };
  D.envsOfApp = function () { if (!D.data) return []; var a = D.data.apps.find(function (x) { return x.name === ui.app; }); return a ? a.environments : []; };
  D.appIncidents = function () { return D.data ? D.data.incidents.filter(function (i) { return !ui.app || i.app === ui.app || !i.app; }) : []; };
  D.isAllowed = function (ip) { return D.data.security.allowlist.some(function (a) { return a.ip === D.bucket(ip); }); };
  D.banOf = function (ip) { return D.data.security.bans.find(function (b) { return b.ip === D.bucket(ip); }); };
  D.isYou = function (ip) { return D.data.you && D.bucket(ip) === D.data.you.bucket; };

  D.render = function () {
    if (!D.data) return;
    D.renderChrome();
    D.charts.clear();
    var view = $('#view'), scroll = window.scrollY;
    if (!D.data.apps.length) {
      view.innerHTML = D.head('Welcome to your dashboard', 'When Claude puts your first app online, you’ll see its visitors, speed, updates and security here.')+'<div class="card"><div class="empty">'+ic('rocket')+'<b>No apps yet</b><span>Ask Claude to build and launch one.</span></div></div>';
      return;
    }
    view.innerHTML = D.deletionRequests() + (D.views[ui.tab] || D.views.home)();
    D.drawCharts();
    window.scrollTo(0, scroll);
  };

  D.head = function (title, sub) { return '<div class="page-head"><h1>'+esc(title)+'</h1>'+(sub?'<p>'+esc(sub)+'</p>':'')+'</div>'; };
  D.card = function (title, sub, body, cls, right) { return '<section class="card '+(cls||'')+'"><div class="card-head"><h2>'+esc(title)+'</h2>'+(right || (sub?'<span class="sub">'+esc(sub)+'</span>':''))+'</div>'+body+'</section>'; };
  D.kpi = function (i, label, value, note, spark) { return '<div class="card kpi"><div class="k-label">'+ic(i)+esc(label)+'</div><div class="k-value">'+value+'</div><div class="k-note">'+note+'</div>'+(spark||'')+'</div>'; };
  D.rangeSeg = function () { return '<div class="seg" role="group" aria-label="Time range"><button data-range="1h" aria-pressed="'+(ui.range==='1h')+'">Last hour</button><button data-range="24h" aria-pressed="'+(ui.range==='24h')+'">Last 24 hours</button></div>'; };
  D.views = {};
})(window.__dash);

/* ---- part 4: charts (hand-drawn SVG) --------------------------------------------------- */
(function (D) {
  var esc = D.esc;
  var SVGNS = 'http://www.w3.org/2000/svg';
  function el(name, attrs) { var n = document.createElementNS(SVGNS, name); for (var k in attrs) n.setAttribute(k, attrs[k]); return n; }
  function niceMax(v) { if (v <= 5) return 5; var p = Math.pow(10, Math.floor(Math.log10(v))); var f = v / p; var m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10; return m * p; }

  D.chartSlot = function (id, spec, height) { spec.height = height || 200; D.charts.set(id, spec); return '<div class="chart" data-chart="'+esc(id)+'" style="height:'+spec.height+'px"></div>'; };
  D.sparkSlot = function (id, values) { D.charts.set(id, { kind:'spark', values: values || [] }); return '<div class="chart" data-chart="'+esc(id)+'" style="height:100%"></div>'; };

  var tip = D.$('#tip');
  function showTip(html, x, y) { tip.innerHTML = html; tip.hidden = false; var w = tip.offsetWidth, h = tip.offsetHeight; var left = Math.min(Math.max(8, x - w/2), window.innerWidth - w - 8); var top = y - h - 14; if (top < 8) top = y + 18; tip.style.left = left+'px'; tip.style.top = top+'px'; }
  function hideTip() { tip.hidden = true; }
  D.hideTip = hideTip;

  D.drawCharts = function () {
    D.charts.forEach(function (spec, id) {
      var host = D.$('[data-chart="'+(window.CSS && CSS.escape ? CSS.escape(id) : id)+'"]');
      if (!host) return;
      try { (DRAW[spec.kind] || function(){})(host, spec); } catch (e) { /* a bad series shouldn't blank the page */ }
    });
  };

  var DRAW = {};

  DRAW.spark = function (host, spec) {
    var vals = spec.values, W = Math.max(60, host.clientWidth || 120), H = Math.max(20, host.clientHeight || 30);
    var max = Math.max(1, Math.max.apply(null, vals.length ? vals : [0]));
    var svg = el('svg', { viewBox:'0 0 '+W+' '+H, preserveAspectRatio:'none' }), n = vals.length;
    if (n > 1) {
      var step = W / (n - 1);
      var pts = vals.map(function (v, i) { return (i*step).toFixed(1)+','+(H - 2 - (H-4)*v/max).toFixed(1); });
      var area = 'M0,'+H+' L'+pts.join(' L')+' L'+W+','+H+' Z';
      svg.appendChild(el('path', { d: area, fill:'var(--series-1)', 'fill-opacity':'0.12' }));
      svg.appendChild(el('path', { d:'M'+pts.join(' L'), fill:'none', stroke:'var(--series-1)', 'stroke-width':'2', 'stroke-linejoin':'round', 'stroke-linecap':'round' }));
    }
    host.innerHTML = ''; host.appendChild(svg);
  };

  function frame(host, spec, pad) {
    var W = Math.max(280, host.clientWidth || 280), H = spec.height;
    var L = pad.l, R = pad.r, T = pad.t, B = pad.b;
    var svg = el('svg', { viewBox:'0 0 '+W+' '+H });
    return { W:W, H:H, L:L, R:R, T:T, B:B, pw:W-L-R, ph:H-T-B, svg:svg };
  }
  function yAxis(f, max) {
    for (var i = 0; i <= 4; i++) {
      var y = f.T + f.ph * i/4, v = Math.round(max * (1 - i/4));
      f.svg.appendChild(el('line', { class:'gridline', x1:f.L, y1:y.toFixed(1), x2:f.L+f.pw, y2:y.toFixed(1) }));
      var tx = document.createElementNS(SVGNS, 'text'); tx.setAttribute('class','axis'); tx.setAttribute('x', f.L-8); tx.setAttribute('y', (y+4).toFixed(1)); tx.setAttribute('text-anchor','end'); tx.textContent = D.short(v); f.svg.appendChild(tx);
    }
  }
  function xLabels(f, rows, step) {
    var every = Math.ceil(rows.length / 6);
    rows.forEach(function (r, i) {
      if (i % every) return;
      var x = f.L + f.pw * (i + 0.5) / rows.length;
      var tx = document.createElementNS(SVGNS, 'text'); tx.setAttribute('class','axis'); tx.setAttribute('x', x.toFixed(1)); tx.setAttribute('y', f.H-8); tx.setAttribute('text-anchor','middle');
      tx.textContent = step >= 3600000 ? new Date(r.t).toLocaleTimeString([], {hour:'2-digit'}) : D.clock(r.t);
      f.svg.appendChild(tx);
    });
  }
  D.__chartDraw = DRAW;
  D.__chartHelpers = { el: el, niceMax: niceMax, frame: frame, yAxis: yAxis, xLabels: xLabels, showTip: showTip, SVGNS: SVGNS };
})(window.__dash);

/* ---- part 5: bar / line / stack draws -------------------------------------------------- */
(function (D) {
  var DRAW = D.__chartDraw, H = D.__chartHelpers, el = H.el, frame = H.frame, yAxis = H.yAxis, xLabels = H.xLabels, showTip = H.showTip, esc = D.esc;

  function hoverBand(f, rows, tipFor) {
    var g = el('g', {});
    rows.forEach(function (r, i) {
      var x = f.L + f.pw * i / rows.length;
      var rect = el('rect', { class:'hit', x: x.toFixed(2), y: f.T, width: (f.pw/rows.length).toFixed(2), height: f.ph });
      rect.addEventListener('mousemove', function (ev) { showTip(tipFor(r), ev.clientX, ev.clientY); });
      rect.addEventListener('mouseleave', D.hideTip);
      g.appendChild(rect);
    });
    f.svg.appendChild(g);
  }

  DRAW.bars = function (host, spec) {
    var rows = spec.rows, f = frame(host, spec, { l:44, r:8, t:12, b:26 });
    var max = H.niceMax(Math.max(1, Math.max.apply(null, rows.map(function (r) { return r.v || 0; }))));
    yAxis(f, max); xLabels(f, rows, spec.step);
    f.svg.appendChild(el('line', { class:'baseline', x1:f.L, y1:f.T+f.ph, x2:f.L+f.pw, y2:f.T+f.ph }));
    var bw = f.pw / rows.length;
    rows.forEach(function (r, i) {
      var h = f.ph * (r.v || 0) / max, x = f.L + i*bw + Math.min(2, bw*0.1);
      if (h > 0.4) f.svg.appendChild(el('rect', { x: x.toFixed(2), y: (f.T+f.ph-h).toFixed(2), width: Math.max(1, bw - Math.min(4, bw*0.2)).toFixed(2), height: h.toFixed(2), rx: Math.min(3, bw/3).toFixed(1), fill: spec.color || 'var(--series-1)' }));
    });
    hoverBand(f, rows, function (r) { return '<div class="t-row"><i style="background:'+(spec.color||'var(--series-1)')+'"></i><span>'+D.clock(r.t)+'</span></div><b>'+D.fmt(r.v||0)+'</b> '+esc(spec.label||''); });
    host.innerHTML = ''; host.appendChild(f.svg);
  };

  DRAW.line = function (host, spec) {
    var rows = spec.rows, key = spec.key, f = frame(host, spec, { l:44, r:8, t:12, b:26 });
    var vals = rows.map(function (r) { return r[key]; }).filter(function (v) { return v != null; });
    var max = H.niceMax(Math.max(1, Math.max.apply(null, vals.length ? vals : [1])));
    yAxis(f, max); xLabels(f, rows, spec.step);
    f.svg.appendChild(el('line', { class:'baseline', x1:f.L, y1:f.T+f.ph, x2:f.L+f.pw, y2:f.T+f.ph }));
    var pts = [], cx = [];
    rows.forEach(function (r, i) { var x = f.L + f.pw*(i+0.5)/rows.length; cx.push(x); if (r[key] != null) pts.push([x, f.T+f.ph - f.ph*r[key]/max]); });
    if (pts.length) {
      f.svg.appendChild(el('path', { d:'M'+pts.map(function (p){return p[0].toFixed(1)+','+p[1].toFixed(1);}).join(' L'), fill:'none', stroke: spec.color||'var(--series-1)', 'stroke-width':'2', 'stroke-linejoin':'round', 'stroke-linecap':'round' }));
    }
    hoverBand(f, rows, function (r) { return '<div class="t-row"><i style="background:'+(spec.color||'var(--series-1)')+'"></i><span>'+D.clock(r.t)+'</span></div><b>'+(r[key]==null?'–':D.fmt(r[key])+' '+esc(spec.label||''))+'</b>'; });
    host.innerHTML = ''; host.appendChild(f.svg);
  };

  DRAW.stack = function (host, spec) {
    var rows = spec.rows, keys = spec.keys, f = frame(host, spec, { l:44, r:8, t:12, b:26 });
    var max = H.niceMax(Math.max(1, Math.max.apply(null, rows.map(function (r) { var s=0; keys.forEach(function (k){ s += r[k[0]]||0; }); return s; }))));
    yAxis(f, max); xLabels(f, rows, spec.step);
    f.svg.appendChild(el('line', { class:'baseline', x1:f.L, y1:f.T+f.ph, x2:f.L+f.pw, y2:f.T+f.ph }));
    var bw = f.pw / rows.length;
    rows.forEach(function (r, i) {
      var base = f.T + f.ph, x = f.L + i*bw + Math.min(1.5, bw*0.08), w = Math.max(1, bw - Math.min(3, bw*0.16));
      keys.forEach(function (k) {
        var v = r[k[0]] || 0; if (v <= 0) return;
        var h = f.ph * v / max; base -= h;
        f.svg.appendChild(el('rect', { x:x.toFixed(2), y:base.toFixed(2), width:w.toFixed(2), height:Math.max(0.5,h-0.5).toFixed(2), fill: k[2] }));
      });
    });
    hoverBand(f, rows, function (r) {
      var lines = keys.filter(function (k){ return (r[k[0]]||0) > 0; }).map(function (k){ return '<div class="t-row"><i style="background:'+k[2]+'"></i><span>'+esc(k[1])+'</span> <b>'+D.fmt(r[k[0]])+'</b></div>'; }).join('');
      return '<div class="t-row"><span>'+D.clock(r.t)+'</span></div>'+(lines || '<span class="muted">no traffic</span>');
    });
    host.innerHTML = ''; host.appendChild(f.svg);
  };
})(window.__dash);

/* ---- part 6: data shaping + Overview --------------------------------------------------- */
(function (D) {
  var esc = D.esc, ic = D.ic, card = D.card, kpi = D.kpi, chip = D.chip;

  /* Buckets the per-minute series: 24 h in 15-minute bars, or the last hour by minute. */
  D.buckets = function (series, range) {
    var step = range === '1h' ? 60000 : 900000, n = range === '1h' ? 60 : 96;
    var end = Math.floor(Date.now()/step)*step, out = [];
    for (var i = 0; i < n; i++) out.push({ t: end - (n-1-i)*step, r:0, ok:0, c4:0, c5:0, b:0, lat:0 });
    var first = out[0].t;
    (series || []).forEach(function (row) {
      var i = Math.floor((row[0]-first)/step); if (i<0||i>=n) return;
      var o = out[i]; o.r+=row[1]; o.ok+=row[2]; o.c4+=row[3]; o.c5+=row[4]; o.b+=row[5]; o.lat+=row[6]*row[1];
    });
    out.forEach(function (o) { o.avg = o.r ? Math.round(o.lat/o.r) : null; o.fine = Math.max(0, o.r - o.b - o.c5); });
    return { rows: out, step: step };
  };
  D.totals = function (series) {
    var r=0,c5=0,b=0,lat=0; (series||[]).forEach(function (row) { r+=row[1]; c5+=row[4]; b+=row[5]; lat+=row[6]*row[1]; });
    return { requests:r, errors:c5, blocked:b, avg: r?Math.round(lat/r):null, served: r-b };
  };
  D.speedWord = function (ms) { return ms==null ? {w:'No visits yet',c:'info'} : ms<250 ? {w:'Fast',c:'good'} : ms<1000 ? {w:'OK',c:'warning'} : {w:'Slow',c:'critical'}; };

  function verdict() {
    var s = D.sel(), ui = D.ui;
    var inc = D.appIncidents().filter(function (i) { return i.ongoing && i.env === s.env; });
    var crit = inc.filter(function (i) { return i.severity==='critical'; });
    var warn = inc.filter(function (i) { return i.severity==='warning'; });
    if (s.status==='down' || crit.length) return { c:'critical', i:'alert', t:'Something needs fixing', x:(crit[0]&&crit[0].title)||'The app’s server is not answering.', a:'problems' };
    if (warn.length) return { c:'warning', i:'alert', t:'Worth a look', x:warn[0].title, a:'problems' };
    if (s.status==='sleeping') return { c:'neutral', i:'moon', t:'Resting to save resources', x:'Test versions rest when nobody uses them. It wakes up by itself on the next visit.' };
    if (s.status==='not_deployed' || s.status==='starting') return { c:'neutral', i:'clock', t:'Getting ready', x:'Nothing is live here yet. Claude is still setting it up.' };
    var blocked = D.totals(s.traffic && s.traffic.series).blocked;
    return { c:'good', i:'check', t:'All good. '+s.app+' is online and protected.', x: blocked ? 'Basalt turned away '+D.plural(blocked,'attack attempt')+' in the last 24 hours. Nothing got through.' : 'Every visit is answered and every person only sees their own data.' };
  }

  function appCard(app, e) {
    var st = D.STATUS[e.status] || D.STATUS.starting, on = app===D.ui.app && e.name===D.ui.env;
    return '<button class="app-card" data-pick-app="'+esc(app)+'" data-pick-env="'+esc(e.name)+'" aria-pressed="'+on+'">'+
      '<div class="ac-top"><span class="sdot '+esc(e.status)+'" aria-hidden="true"></span><span class="ac-name">'+esc(app)+'</span><span class="ac-env">'+esc(D.envLabel(e))+'</span></div>'+
      '<div>'+chip(st.c, st.l)+'</div>'+
      '<div style="height:30px">'+D.sparkSlot('spark-'+app+'-'+e.name, e.spark)+'</div>'+
      '<div class="ac-stats"><span><b class="num">'+D.short(e.visitors24h)+'</b> visitors</span><span><b class="num">'+D.short(e.blocked24h)+'</b> blocked</span><span><b class="num">'+D.short(e.errors24h)+'</b> errors</span></div></button>';
  }

  D.views.home = function () {
    var s = D.sel(), tr = s.traffic, t = D.totals(tr && tr.series), v = verdict(), sp = D.speedWord(t.avg);
    var visitorsSpark = tr ? tr.visitors.perHour.map(function (p){ return p[1]; }) : [];
    var b = D.buckets(tr && tr.series, D.ui.range);
    var fine = t.served ? D.pct(t.served - t.errors, t.served) : 100;
    var recentInc = D.appIncidents().slice(0, 4), deps = D.data.deployments.slice(0, 4);
    return D.head(s.app, D.envLabel(s)+' · '+s.url.replace(/^https?:\/\//,''))+
      '<div class="verdict '+v.c+'"><div class="v-icon">'+ic(v.i)+'</div><div><h2>'+esc(v.t)+'</h2><p>'+esc(v.x)+'</p></div>'+(v.a?'<button class="btn secondary v-action" data-tab="'+v.a+'">See what happened</button>':'')+'</div>'+
      '<div class="grid g-kpi mt">'+
        kpi('people','Visitors', D.short(tr?tr.visitors.last24h:0), 'different people, last 24 h', '<div class="k-spark">'+D.sparkSlot('spark-vis', visitorsSpark)+'</div>')+
        kpi('eye','Visits', D.short(t.served), 'pages and actions, last 24 h', '<div class="k-spark">'+D.sparkSlot('spark-req', b.rows.map(function(r){return r.fine;}))+'</div>')+
        kpi('bolt','Speed','<span class="big-word">'+esc(sp.w)+'</span>', t.avg==null?'no visits yet':'answers in about '+D.fmt(t.avg)+' ms')+
        kpi('check','Worked fine', fine+'%', t.errors?D.plural(t.errors,'server error')+' in 24 h':'no server errors in 24 h')+
        kpi('shield','Attacks stopped', D.short(t.blocked), D.data.security.bans.length?D.plural(D.data.security.bans.length,'attacker')+' blocked right now':'nobody blocked right now')+
      '</div>'+
      card('Traffic','','<div class="legend"><span><i style="background:var(--series-1)"></i>Answered</span><span><i style="background:var(--serious)"></i>Attacks blocked</span><span><i style="background:var(--critical)"></i>Server errors</span></div>'+
        D.chartSlot('traffic', { kind:'stack', rows:b.rows, step:b.step, keys:[['fine','Answered','var(--series-1)'],['b','Attacks blocked','var(--serious)'],['c5','Server errors','var(--critical)']] }, 220), 'mt', D.rangeSeg())+
      '<div class="grid g-2 mt">'+
        card('Problems','last 7 days', recentInc.length?'<div class="feed">'+recentInc.map(D.incidentItem).join('')+'</div>':'<div class="empty">'+ic('check')+'<b>No problems</b><span>Nothing has gone wrong in the last week.</span></div>', '', '<button class="row-btn" data-tab="problems">See all</button>')+
        card('Latest updates','', deps.length?'<div class="feed">'+deps.map(function(d){return D.depItem(d);}).join('')+'</div>':'<div class="empty">'+ic('rocket')+'<span>No updates yet.</span></div>', '', '<button class="row-btn" data-tab="updates">See all</button>')+
      '</div>'+
      card('All your apps','tap one to look at it', '<div class="apps">'+D.data.apps.reduce(function (h, a) { return h + a.environments.map(function (e){ return appCard(a.name, e); }).join(''); }, '')+'</div>', 'mt');
  };
})(window.__dash);

/* ---- part 7: Visitors + Speed & errors ------------------------------------------------- */
(function (D) {
  var esc = D.esc, ic = D.ic, card = D.card, kpi = D.kpi, chip = D.chip;

  D.barList = function (items, label, unit, emptyText) {
    if (!items || !items.length) return D.emptySmall(emptyText || 'Nothing yet.');
    var max = Math.max.apply(null, items.map(function (i){ return i.count; }));
    return '<div class="bars">'+items.map(function (i) {
      return '<div class="bar-row" title="'+esc(i.key)+'"><span class="label">'+esc(label(i.key))+'</span><span class="value">'+D.fmt(i.count)+' '+esc(unit)+'</span><div class="track"><div class="fill '+(i.cls||'')+'" style="width:'+Math.max(1, 100*i.count/max)+'%"></div></div></div>';
    }).join('')+'</div>';
  };
  D.split = function (parts, total) {
    var shown = parts.filter(function (p){ return p[1] > 0; });
    return '<div class="split" role="img" aria-label="'+esc(shown.map(function (p){ return p[0]+' '+D.pct(p[1],total)+'%'; }).join(', '))+'">'+
      shown.map(function (p){ return '<div style="flex:'+p[1]+';background:'+p[2]+'" title="'+esc(p[0])+': '+D.fmt(p[1])+'"></div>'; }).join('')+'</div>'+
      '<div class="split-legend">'+parts.map(function (p){ return '<div><i style="background:'+p[2]+'"></i>'+esc(p[0])+'<span class="v">'+D.pct(p[1],total)+'% · '+D.fmt(p[1])+'</span></div>'; }).join('')+'</div>';
  };
  function friendlyApi(key) {
    var sp = key.split(' '), method = sp[0], path = sp[1] || '';
    var what = path.replace(/^\/api\/?/,'').replace(/\/:id/g,'').replace(/[/_-]+/g,' ').trim() || 'home';
    var verb = { GET:'Look at', POST:'Add', PUT:'Change', PATCH:'Change', DELETE:'Remove' }[method] || method;
    return verb+' '+what;
  }

  D.views.visitors = function () {
    var s = D.sel(), tr = s.traffic;
    if (!tr) return D.head('Visitors','Who comes to your app and what they look at.')+'<div class="card"><div class="empty">'+ic('globe')+'<b>No visits yet</b><span>As soon as someone opens the app, it shows up here.</span></div></div>';
    var hours = tr.visitors.perHour.map(function (p){ return { t:p[0], v:p[1] }; });
    var dev = tr.devices, devTotal = dev.phone+dev.computer+dev.tablet+dev.bot;
    var browsers = Object.keys(tr.browsers).map(function (k){ return { key:k, count:tr.browsers[k] }; }).sort(function (a,b){ return b.count-a.count; });
    var bTotal = browsers.reduce(function (a,x){ return a+x.count; }, 0);
    return D.head('Visitors','Who comes to your app and what they look at. Counts only real visits; blocked attacks are left out.')+
      '<div class="grid g-kpi">'+
        kpi('people','Different people', D.short(tr.visitors.last24h), 'last 24 hours')+
        kpi('eye','Pages opened', D.short(tr.pages.reduce(function (a,p){ return a+p.count; },0)), 'since the app last restarted')+
        kpi('pointer','Actions', D.short(tr.api.reduce(function (a,p){ return a+p.count; },0)), 'saves, loads and sign-ins')+
        kpi('clock','Last visit', esc(D.ago(tr.totals.lastRequestAt)), tr.totals.lastRequestAt?esc(D.when(tr.totals.lastRequestAt)):'')+
      '</div>'+
      card('People per hour','last 24 hours', D.chartSlot('vis-hours', { kind:'bars', rows:hours, label:'people', step:3600000, color:'var(--series-1)' }, 200), 'mt')+
      '<div class="grid g-2 mt">'+
        card('Most visited pages','', D.barList(tr.pages, function (k){ return k; }, 'views'))+
        card('Most used features','what people do in your app', D.barList(tr.api, friendlyApi, 'times'))+
        card('What people use','devices', devTotal?D.split([['Computer',dev.computer,'var(--series-1)'],['Phone',dev.phone,'var(--series-2)'],['Tablet',dev.tablet,'var(--series-3)'],['Bots and scripts',dev.bot,'var(--ink-3)']], devTotal):D.emptySmall('No page views yet.'))+
        card('Browsers','', bTotal?D.barList(browsers, function (k){ return k; }, 'views'):D.emptySmall('No page views yet.'))+
        card('Where visitors came from','other websites that link to you', D.barList(tr.referrers, function (k){ return k; }, 'visits', 'People came straight to your app (typed the address or used a bookmark).'), 'span-2')+
      '</div>';
  };

  function serverFacts(s) {
    var k = s.backend, p = s.protection || {}, rows = [
      ['Address','<a href="'+esc(D.openHref(s))+'" target="_blank" rel="noopener noreferrer">'+esc(s.url.replace(/^https?:\/\//,''))+'</a>'],
      ['Server', k?esc(k.state)+(k.health?' ('+esc(k.health)+')':''):'website only'],
      ['Running since', k&&k.startedAt?esc(D.when(k.startedAt)):'–'],
      ['Restarts', k?D.fmt(k.restarts):'–'],
      ['Visitor speed limit', p.perIpPerMinute?D.fmt(p.perIpPerMinute)+' requests a minute per visitor':'default'],
      ['Robot check', p.underAttack?chip('warning','On'):chip('info','Off')]
    ];
    if (s.expiresAt) rows.push(['Removed automatically', esc(D.when(s.expiresAt))]);
    return '<table><tbody>'+rows.map(function (r){ return '<tr><td class="muted">'+esc(r[0])+'</td><td>'+r[1]+'</td></tr>'; }).join('')+'</tbody></table>';
  }

  D.views.health = function () {
    var s = D.sel(), tr = s.traffic, t = D.totals(tr && tr.series), sp = D.speedWord(t.avg);
    var b = D.buckets(tr && tr.series, D.ui.range), k = s.backend, lat = tr?tr.totals.latencyMs:{};
    var slow = typeof lat.p95==='number'?D.fmt(lat.p95)+' ms':(lat.p95||'–');
    var st = D.STATUS[s.status] || D.STATUS.starting;
    var hist = tr?tr.latencyBuckets.map(function (x, i, all){ return { key: x.upToMs==null?'over 5 s':(i===0?'under '+x.upToMs+' ms':all[i-1].upToMs+'–'+x.upToMs+' ms'), count:x.count }; }):[];
    var histMax = Math.max.apply(null, [1].concat(hist.map(function (h){ return h.count; })));
    var st4 = tr?tr.totals.status:{'2xx':0,'3xx':0,'4xx':0,'5xx':0};
    var stTotal = st4['2xx']+st4['3xx']+st4['4xx']+st4['5xx'];
    return D.head('Speed & errors','How quickly your app answers, and whether anything is failing.')+
      '<div class="grid g-kpi">'+
        kpi('pulse','Right now','<span class="big-word">'+esc(st.l)+'</span>', k?'server '+esc(k.state)+(k.health?', '+esc(k.health):'')+(k.restarts?', restarted '+D.plural(k.restarts,'time'):''):(s.status==='up'?'website only, no server needed':''))+
        kpi('bolt','Typical answer','<span class="big-word">'+esc(sp.w)+'</span>', t.avg==null?'no visits yet':'about '+D.fmt(t.avg)+' ms on average')+
        kpi('clock','Slowest 5%', esc(slow), 'take longer than this')+
        kpi('check','Worked fine', (t.served?D.pct(t.served-t.errors,t.served):100)+'%', D.plural(t.errors,'server error')+' in 24 h')+
      '</div>'+
      card('How fast it answered','average per bar', D.chartSlot('lat', { kind:'line', rows:b.rows, step:b.step, key:'avg', label:'ms', color:'var(--series-1)' }, 200), 'mt', D.rangeSeg())+
      '<div class="grid g-2 mt">'+
        card('Errors over time','server errors your visitors saw', D.chartSlot('errs', { kind:'bars', rows:b.rows.map(function (r){ return { t:r.t, v:r.c5 }; }), step:b.step, label:'server errors', color:'var(--critical)' }, 180))+
        card('Answer times','how many requests took how long', '<div class="bars">'+hist.map(function (h){ return '<div class="bar-row"><span class="label">'+esc(h.key)+'</span><span class="value">'+D.fmt(h.count)+'</span><div class="track"><div class="fill" style="width:'+(100*h.count/histMax)+'%"></div></div></div>'; }).join('')+'</div>')+
        card('How requests ended','since the app last restarted', stTotal?D.split([['Worked',st4['2xx']+st4['3xx'],'var(--good)'],['Refused or not found',st4['4xx'],'var(--warning)'],['Server error',st4['5xx'],'var(--critical)']], stTotal)+'<p class="hint">'+ic('alert')+'"Refused or not found" includes every blocked attack, so it rises during an attack. That’s normal.</p>':D.emptySmall('No requests yet.'))+
        card('Server','', serverFacts(s))+
      '</div>';
  };
})(window.__dash);

/* ---- part 8: Security view ------------------------------------------------------------- */
(function (D) {
  var esc = D.esc, ic = D.ic, card = D.card, kpi = D.kpi, chip = D.chip;

  function ipCell(ip) { return '<td class="ip">'+esc(ip)+(D.isYou(ip)?'<span class="you-tag">you</span>':'')+'</td>'; }
  function menuBtn(ip) { return '<td style="text-align:right"><button class="row-btn" data-ip-menu="'+esc(ip)+'" aria-label="Options for '+esc(ip)+'">'+ic('dots')+'</button></td>'; }

  function youCard(you) {
    var allowed = you.allowlisted;
    return '<section class="card mt you-card">'+ic('laptop')+'<div><div class="muted small">This computer</div><div class="you-ip">'+esc(you.ip)+'</div></div>'+
      '<div>'+(you.banned?chip('critical','Blocked','ban'):allowed?chip('good','Always allowed','check'):chip('info','Normal visitor'))+'</div>'+
      '<div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">'+(allowed?'<button class="btn secondary" data-disallow="'+esc(you.bucket)+'">Stop always allowing</button>':'<button class="btn good" data-allow="'+esc(you.ip)+'" data-label="This computer">'+ic('star')+'Always allow this computer</button>')+(you.banned?'<button class="btn secondary" data-unban="'+esc(you.bucket)+'">'+ic('unlock')+'Unblock now</button>':'')+'</div>'+
      '<p class="muted small" style="flex-basis:100%">Always-allowed computers are never blocked or slowed down on your apps. Attack attempts from them are still refused one by one and still show up here, so you can test your app’s defences without locking yourself out.</p></section>';
  }

  function blockedTable() {
    var bans = D.data.security.bans;
    if (!bans.length) return '<div class="empty">'+ic('check')+'<b>Nobody is blocked</b><span>Visitors who attack your app get blocked here automatically.</span></div>';
    return '<div class="table-wrap"><table><thead><tr><th>Address</th><th>Why</th><th>Blocked for</th><th></th></tr></thead><tbody>'+
      bans.map(function (b){ return '<tr class="ctx" data-ip="'+esc(b.ip)+'">'+ipCell(b.ip)+'<td>'+esc(D.reason(b.reason).l)+(b.bans>1?' <span class="muted small">('+D.fmt(b.bans)+'× so far)</span>':'')+'</td><td class="num">'+esc(D.until(b.until))+'</td>'+menuBtn(b.ip)+'</tr>'; }).join('')+
      '</tbody></table></div><p class="hint">'+ic('pointer')+'Right-click a row to always allow or unblock that address. Blocks lift by themselves, and get longer each time.</p>';
  }

  function allowTable() {
    var list = D.data.security.allowlist;
    var form = '<form class="inline-form" data-allow-form><label class="sr" for="allow-ip">Address</label><input id="allow-ip" name="ip" placeholder="Address, like 203.0.113.7" autocomplete="off" required><label class="sr" for="allow-label">Name</label><input id="allow-label" name="label" placeholder="Name (optional)" autocomplete="off"><button class="btn secondary" type="submit">Add</button></form>';
    if (!list.length) return '<p class="muted small">No one yet. Add your own computer before testing your app’s defences, so you don’t get blocked.</p>'+form;
    return '<div class="table-wrap"><table><thead><tr><th>Address</th><th>Name</th><th>Since</th><th></th></tr></thead><tbody>'+
      list.map(function (a){ return '<tr class="ctx" data-ip="'+esc(a.ip)+'">'+ipCell(a.ip)+'<td>'+esc(a.label||'–')+'</td><td class="muted small">'+esc(D.ago(a.addedAt))+'</td><td style="text-align:right"><button class="row-btn" data-disallow="'+esc(a.ip)+'">Remove</button></td></tr>'; }).join('')+
      '</tbody></table></div>'+form;
  }

  function attackTable(events) {
    if (!events.length) return '<div class="empty">'+ic('check')+'<span>Nothing stopped yet.</span></div>';
    var list = events.slice(-100).reverse();
    return '<div class="table-wrap"><table><thead><tr><th>When</th><th>Address</th><th>What they tried</th><th>Where</th><th>Result</th><th></th></tr></thead><tbody>'+
      list.map(function (e){
        var where = e.env ? D.envLabel({ kind: (e.env==='production'||e.env==='staging')?e.env:'preview', name:e.env }) : '';
        var result = e.banned?chip('critical','Blocked + banned','ban'):e.allowed?chip('info','Refused (allowed IP)','x'):chip('serious','Refused','x');
        return '<tr class="ctx" data-ip="'+esc(e.ip)+'"><td class="num muted small">'+esc(D.clock(e.at))+'</td>'+ipCell(e.ip)+'<td>'+esc(D.reason(e.reason).l)+'<div class="muted small" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(e.path)+'">'+esc(e.method)+' '+esc(e.path)+'</div></td><td class="small">'+esc(where)+'</td><td>'+result+'</td>'+menuBtn(e.ip)+'</tr>';
      }).join('')+'</tbody></table></div>';
  }

  D.latestGuard = function () {
    for (var i = 0; i < D.data.deployments.length; i++) {
      var tests = D.data.deployments[i].tests;
      for (var j = tests.length-1; j >= 0; j--) if (tests[j].kind==='guard' && tests[j].status!=='running') return tests[j];
    }
    return null;
  };

  function dataCard(s, guard) {
    var d = s.data, rows = [];
    if (d) rows.push('<div class="feed-item"><div class="f-icon '+(d.status==='live'?'good':'warning')+'">'+ic('database')+'</div><div><div class="f-title">'+(d.status==='live'?'Data rules are on':d.status==='waiting_for_owner'?'Waiting for your OK':'No data saved here')+'</div><div class="f-detail">'+esc((d.rules||'This version doesn’t save customer data with Basalt.').split('\n').slice(0,4).join(' '))+'</div>'+(d.mapUrl?'<div class="f-meta"><a href="'+esc(d.mapUrl)+'" target="_blank" rel="noopener noreferrer">See where your data lives '+ic('out')+'</a></div>':'')+'</div></div>');
    if (guard) rows.push('<div class="feed-item"><div class="f-icon '+(guard.status==='passed'?'good':'critical')+'">'+ic('shield')+'</div><div><div class="f-title">'+(guard.status==='passed'?'Guard: nobody could reach other people’s data':'Guard found data the wrong people could reach')+'</div><div class="f-detail">Guard signs in as two test customers and a stranger and tries '+D.fmt((guard.passed||0)+(guard.failed||0))+' ways to see or change data that isn’t theirs. Last run on '+esc(guard.env)+', '+esc(D.ago(guard.at))+'.</div>'+(guard.receiptUrl?'<div class="f-meta"><a href="'+esc(guard.receiptUrl)+'" target="_blank" rel="noopener noreferrer">Open the safety receipt '+ic('out')+'</a></div>':'')+'</div></div>');
    return rows.length?'<div class="feed">'+rows.join('')+'</div>':D.emptySmall('This app doesn’t save customer data with Basalt yet.');
  }

  D.views.security = function () {
    var s = D.sel(), sec = D.data.security, ui = D.ui;
    var mine = {}; D.envsOfApp().forEach(function (e){ mine[e.name] = 1; });
    var events = sec.events.filter(function (e){ return e.app===ui.app && mine[e.env]; }).filter(function (e){ return !ui.ipFilter || D.bucket(e.ip)===D.bucket(ui.ipFilter); });
    var dayAgo = Date.now()-86400000, day = events.filter(function (e){ return e.at>=dayAgo; });
    var step = ui.range==='1h'?60000:900000, n = ui.range==='1h'?60:96, end = Math.floor(Date.now()/step)*step, rows = [];
    for (var i = 0; i < n; i++) rows.push({ t: end-(n-1-i)*step, v:0 });
    events.forEach(function (e){ var idx = Math.floor((e.at-rows[0].t)/step); if (idx>=0&&idx<n) rows[idx].v++; });
    var byReason = {}; day.forEach(function (e){ byReason[e.reason] = (byReason[e.reason]||0)+1; });
    var reasons = Object.keys(byReason).map(function (k){ return { key:k, count:byReason[k], cls:'c-serious' }; }).sort(function (a,b){ return b.count-a.count; });
    var attackers = {}; day.forEach(function (e){ if (!e.allowed) attackers[D.bucket(e.ip)] = 1; });
    var guard = D.latestGuard(), you = D.data.you;
    return D.head('Security','Basalt checks every visit before it reaches your app. Here is everyone it stopped, and why.')+
      '<div class="grid g-kpi">'+
        kpi('shield','Attacks stopped', D.short(day.length), 'last 24 hours')+
        kpi('ban','Blocked right now', D.fmt(sec.bans.length), sec.bans.length?'can’t reach your apps for a while':'nobody is blocked')+
        kpi('bug','Different attackers', D.fmt(Object.keys(attackers).length), 'last 24 hours')+
        kpi('database','Customer data', guard?(guard.status==='passed'?'<span class="big-word">Safe</span>':'<span class="big-word">Check</span>'):'<span class="big-word">–</span>', guard?(guard.status==='passed'?'Guard tried '+D.fmt(guard.passed)+' ways in, all refused':'Guard found a way in'):'Guard hasn’t run yet')+
      '</div>'+
      (you?youCard(you):'')+
      (ui.ipFilter?'<div class="card mt you-card"><span>'+ic('search')+' Showing only <b class="ip">'+esc(ui.ipFilter)+'</b></span><button class="btn secondary" data-clear-ip>Show everyone</button></div>':'')+
      card('Attacks over time','', D.chartSlot('attacks', { kind:'bars', rows:rows, step:step, label:'attacks stopped', color:'var(--serious)' }, 180), 'mt', D.rangeSeg())+
      '<div class="grid g-2 mt">'+
        card('Blocked visitors','right-click an address for options', blockedTable())+
        card('Always allowed','never blocked on your apps', allowTable())+
        card('What attackers tried','last 24 hours', reasons.length?D.barList(reasons, function (k){ return D.reason(k).l; }, 'times')+'<details class="more"><summary>What do these mean?</summary><div class="bars mt">'+reasons.map(function (r){ return '<p class="small"><b>'+esc(D.reason(r.key).l)+'.</b> '+esc(D.reason(r.key).d)+'</p>'; }).join('')+'</div></details>':'<div class="empty">'+ic('check')+'<span>No attacks in the last 24 hours.</span></div>')+
        card('Customer data protection','', dataCard(s, guard))+
      '</div>'+
      card('Every stopped request','newest first; right-click an address for options', attackTable(events), 'mt')+
      (sec.edgeReachable?'':'<p class="hint">'+ic('alert')+'The traffic checker didn’t answer just now, so this may be out of date.</p>');
  };
})(window.__dash);

/* ---- part 9: Updates + Problems + Activity log ---------------------------------------- */
(function (D) {
  var esc = D.esc, ic = D.ic, card = D.card, kpi = D.kpi, chip = D.chip;

  function stageState(d, name) {
    if (name==='build') return d.status==='built'?'passed':d.status==='failed'?'failed':'running';
    var tests = d.tests.filter(function (t){ return name==='preview'?['staging','production'].indexOf(t.env)<0:t.env===name; });
    if (d.liveIn.some(function (e){ return name==='preview'?['staging','production'].indexOf(e)<0:e===name; })) return tests.some(function (t){ return t.status==='failed'; })?'failed':'passed';
    if (tests.some(function (t){ return t.status==='failed'||t.status==='error'; })) return 'failed';
    if (tests.length && tests.every(function (t){ return t.status==='passed'; })) return 'passed';
    var p = d.pipelines.find(function (x){ return x.status==='running'; });
    if (p && (p.stage===name || (name==='preview'&&p.stage==='preview'))) return 'running';
    return d.pipelines.find(function (x){ return x.status==='failed'&&x.stage===name; })?'failed':'pending';
  }
  function flow(d) {
    var stages = [['build','Built and checked'],['preview','Tested privately'],['staging','Final check'],['production','Live']];
    var icn = { passed:'check', failed:'x', running:'clock', pending:'clock' };
    return '<div class="flow" aria-label="Progress of this update">'+stages.map(function (st, i){ var s = stageState(d, st[0]); return (i?'<span class="arrow" aria-hidden="true"></span>':'')+'<span class="stage '+s+'">'+ic(icn[s])+esc(st[1])+'</span>'; }).join('')+'</div>';
  }
  function depBody(d) {
    var steps = d.steps.length?'<div class="steps">'+d.steps.map(function (s){ return '<span class="step '+esc(s.status)+'" title="'+(s.ms?Math.round(s.ms/100)/10+' s':'')+'">'+ic(s.status==='passed'?'check':s.status==='failed'?'x':'clock')+esc(D.STEPS[s.name]||s.name)+'</span>'; }).join('')+'</div>':'';
    var tests = d.tests.length?'<div class="f-meta">'+d.tests.map(function (t){ return chip(t.status==='passed'?'good':t.status==='running'?'warning':'critical', (t.kind==='guard'?'Guard':t.kind==='e2e'?'App tests':'Quick check')+' on '+t.env+(t.passed!=null?': '+t.passed+'/'+((t.passed||0)+(t.failed||0)):''), t.status==='passed'?'check':'x'); }).join('')+'</div>':'';
    var log = d.pipelines.reduce(function (a, p){ return a.concat(p.log); }, []).slice(-10);
    return steps+tests+(d.error?'<p class="small mt" style="color:var(--critical-ink)">'+esc(d.error.split('\n')[0])+'</p>':'')+(log.length?'<details class="more"><summary>What happened, step by step</summary><pre class="log">'+esc(log.map(function (l){ return D.clock(l.at)+'  '+l.message; }).join('\n'))+'</pre></details>':'');
  }
  D.depItem = function (d, full) {
    var st = (d.status==='failed'||d.pipelines.some(function (p){ return p.status==='failed'; }))?'critical':(d.pipelines.some(function (p){ return p.status==='running'; })||d.status==='building'||d.status==='queued')?'warning':'good';
    var label = st==='critical'?'Didn’t pass':st==='warning'?'In progress':d.liveIn.indexOf('production')>=0?'Live':'Passed';
    return '<div class="feed-item"><div class="f-icon '+st+'">'+ic(st==='critical'?'x':st==='warning'?'clock':'rocket')+'</div><div><div class="f-title">'+esc(d.message||'Update')+'</div><div class="f-meta">'+chip(st,label)+d.liveIn.map(function (e){ return chip('info','on '+e); }).join('')+'</div>'+(full?depBody(d):'')+'</div><div class="f-time">'+esc(D.ago(d.createdAt))+'</div></div>';
  };
  function releasesTable(rels) {
    if (!rels || !rels.length) return D.emptySmall('Nothing has gone live here yet.');
    function word(r){ return r.current?chip('good','Live now','check'):r.status==='rolled_back'?chip('warning','Taken down'):r.status==='failed'?chip('critical','Failed to start'):chip('info','Replaced'); }
    return '<div class="table-wrap"><table><thead><tr><th>Went live</th><th>State</th><th>Why it changed</th></tr></thead><tbody>'+rels.map(function (r){ return '<tr><td class="small">'+esc(D.when(r.liveAt||r.createdAt))+'</td><td>'+word(r)+'</td><td class="small muted">'+esc((r.reason||'').split('\n')[0].slice(0,160))+'</td></tr>'; }).join('')+'</tbody></table></div>';
  }
  D.views.updates = function () {
    var s = D.sel(), deps = D.data.deployments, latest = deps[0];
    return D.head('Updates','Every change Claude made to your app, the checks it passed, and where it went live.')+
      (latest?card('Latest update', D.ago(latest.createdAt), flow(latest)+depBody(latest)):'<div class="card"><div class="empty">'+ic('rocket')+'<span>No updates yet.</span></div></div>')+
      (deps.length>1?card('Earlier updates','', '<div class="feed">'+deps.slice(1).map(function (d){ return D.depItem(d, true); }).join('')+'</div>', 'mt'):'')+
      card('Versions on '+D.envLabel(s),'what visitors got, and when', releasesTable(s.releases), 'mt');
  };

  D.incidentItem = function (i) {
    var icn = { outage:'pulse', errors:'alert', deploy:'rocket', security:'shield' }[i.kind] || 'alert';
    return '<div class="feed-item"><div class="f-icon '+esc(i.severity)+'">'+ic(icn)+'</div><div><div class="f-title">'+esc(i.title)+'</div><div class="f-detail">'+esc(i.detail)+'</div><div class="f-meta">'+(i.ongoing?chip(i.severity==='info'?'info':'critical','Happening now'):chip('info','Over'))+(i.app?chip('info', i.app+(i.env?' · '+i.env:'')):'')+'</div></div><div class="f-time">'+esc(D.ago(i.at))+'</div></div>';
  };
  D.views.problems = function () {
    var all = D.appIncidents(), ui = D.ui;
    var filters = [['all','Everything'],['now','Happening now'],['security','Security'],['outage','Downtime & errors'],['deploy','Updates']];
    var list = all.filter(function (i){ return ui.problems==='all' || (ui.problems==='now'?i.ongoing:ui.problems==='outage'?(i.kind==='outage'||i.kind==='errors'):i.kind===ui.problems); });
    var crit = all.filter(function (i){ return i.severity==='critical'; }).length;
    return D.head('Problems','Anything that went wrong in the last 7 days, newest first. Basalt fixes most of these by itself; the rest are worth telling Claude about.')+
      '<div class="grid g-kpi">'+
        kpi('alert','Happening now', D.fmt(all.filter(function (i){ return i.ongoing && i.severity!=='info'; }).length), 'need attention')+
        kpi('pulse','Serious', D.fmt(crit), 'last 7 days')+
        kpi('shield','Security', D.fmt(all.filter(function (i){ return i.kind==='security'; }).length), 'blocked attackers and Guard findings')+
        kpi('rocket','Updates that stopped', D.fmt(all.filter(function (i){ return i.kind==='deploy'; }).length), 'nothing changed for visitors')+
      '</div>'+
      '<section class="card mt"><div class="toolbar"><div class="seg" role="group" aria-label="Filter">'+filters.map(function (ff){ return '<button data-problems="'+ff[0]+'" aria-pressed="'+(ui.problems===ff[0])+'">'+esc(ff[1])+'</button>'; }).join('')+'</div></div>'+
      (list.length?'<div class="feed">'+list.map(D.incidentItem).join('')+'</div>':'<div class="empty">'+ic('check')+'<b>Nothing here</b><span>No problems of this kind.</span></div>')+'</section>';
  };
})(window.__dash);

/* ---- part 10: Activity log view ------------------------------------------------------- */
(function (D) {
  var esc = D.esc, ic = D.ic, chip = D.chip;

  function visitsLog() {
    var tr = D.sel().traffic, q = D.ui.search.toLowerCase();
    var list = (tr?tr.access:[]).slice().reverse().filter(function (a){ return !q || (a.path+' '+a.ip+' '+a.status+' '+a.method).toLowerCase().indexOf(q)>=0; });
    if (!list.length) return D.emptySmall('No visits yet.');
    function result(a){ return a.blocked?chip(a.allowed?'info':'serious', D.reason(a.blocked).l, 'shield'):a.status>=500?chip('critical','Server error','x'):a.status>=400?chip('warning', a.status===404?'Not found':a.status===401?'Not signed in':'Refused'):chip('good','OK','check'); }
    return '<div class="table-wrap"><table><thead><tr><th>When</th><th>Request</th><th>Address</th><th>Result</th><th>Time</th></tr></thead><tbody>'+
      list.slice(0,200).map(function (a){ return '<tr class="ctx" data-ip="'+esc(a.ip)+'"><td class="num muted small">'+esc(D.clock(a.at))+'</td><td class="small"><b>'+esc(a.method)+'</b> <span style="display:inline-block;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom" title="'+esc(a.path)+'">'+esc(a.path)+'</span></td><td class="ip">'+esc(a.ip)+(D.isYou(a.ip)?'<span class="you-tag">you</span>':'')+'</td><td>'+result(a)+'</td><td class="num muted small">'+D.fmt(a.ms)+' ms</td></tr>'; }).join('')+
      '</tbody></table></div>';
  }
  function serverLog() {
    if (D.serverLogs == null) { D.loadServerLogs(); return '<div class="empty">'+ic('clock')+'<span>Loading the server’s messages…</span></div>'; }
    if (D.serverLogs.error) return D.emptySmall(D.serverLogs.error);
    var q = D.ui.search.toLowerCase();
    var lines = D.serverLogs.lines.filter(function (l){ return !q || l.message.toLowerCase().indexOf(q)>=0; });
    if (!lines.length) return D.emptySmall('No server messages'+(q?' match that.':' yet. This app may be website-only.'));
    return '<pre class="log">'+lines.map(function (l){ var t = l.at?D.clock(l.at)+'  ':''; var lvl = l.level==='error'?'✖ ':l.level==='warn'?'⚠ ':''; return esc(t+lvl+l.message); }).join('\n')+'</pre>';
  }
  function changesLog() {
    var acts = D.data.activity;
    if (!acts.length) return D.emptySmall('No changes yet.');
    var NAMES = { 'app.created':'Created the app','app.deleted':'Deleted the app','deploy.started':'Started an update','promote':'Moved a version forward','secret.set':'Set a secret','secret.deleted':'Removed a secret','data_rules.updated':'Changed the data rules','data_admin.requested':'Asked to add a data admin','data_check.ran':'Ran a Guard check','protection.updated':'Changed protection settings','allowlist.added':'Always-allowed an address','allowlist.removed':'Removed an always-allowed address','ban.lifted':'Unblocked an address','token.created':'Made a connector key','api_config.updated':'Changed backend settings' };
    return '<div class="feed">'+acts.map(function (a){ return '<div class="feed-item"><div class="f-icon info">'+ic('list')+'</div><div><div class="f-title">'+esc(NAMES[a.action]||a.action)+'</div><div class="f-meta">'+(a.target?chip('info', a.target):'')+'</div></div><div class="f-time">'+esc(D.ago(a.at))+'</div></div>'; }).join('')+'</div>';
  }
  D.views.logs = function () {
    var subs = [['visits','Visits'],['server','Server messages'],['changes','Changes made']], ui = D.ui;
    var body = ui.logs==='visits'?visitsLog():ui.logs==='server'?serverLog():changesLog();
    return D.head('Activity log','Everything happening in your app, as it happens.')+
      '<section class="card"><div class="toolbar"><div class="seg" role="group" aria-label="Which log">'+subs.map(function (s){ return '<button data-logs="'+s[0]+'" aria-pressed="'+(ui.logs===s[0])+'">'+esc(s[1])+'</button>'; }).join('')+'</div>'+
      (ui.logs!=='changes'?'<label class="sr" for="log-search">Search</label><input type="search" id="log-search" placeholder="Search…" value="'+esc(ui.search)+'">':'')+'</div>'+body+'</section>';
  };

  D.serverLogs = null;
  D.loadServerLogs = function () {
    var ui = D.ui;
    D.api('/logs?app='+encodeURIComponent(ui.app)+'&env='+encodeURIComponent(ui.env)).then(function (r){ D.serverLogs = r; if (ui.tab==='logs' && ui.logs==='server') D.render(); }).catch(function (err){ D.serverLogs = { error: err.message }; if (ui.tab==='logs') D.render(); });
  };
})(window.__dash);

/* ---- part 11: actions, IP menu, theme, bootstrap -------------------------------------- */
(function (D) {
  var esc = D.esc, ic = D.ic, $ = D.$, ui = D.ui;
  var toastTimer;
  function toast(text, bad) { var t = $('#toast'); t.textContent = text; t.className = 'toast'+(bad?' bad':''); t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function (){ t.hidden = true; }, 3500); }

  function act(path, body, okText) {
    return D.api(path, { method: body.__method || 'POST', body: body }).then(function (){ if (okText) toast(okText); return D.refresh(); }).catch(function (err){ toast(err.message, true); });
  }
  D.allow = function (ip, label) { return act('/allowlist', { ip: ip, label: label || '' }, 'Added to always-allowed.'); };
  D.disallow = function (ip) { return act('/allowlist', { ip: ip, __method:'DELETE' }, 'Removed from always-allowed.'); };
  D.unban = function (ip) { return act('/unban', { ip: ip }, 'Unblocked.'); };
  D.confirmDelete = function (app, btn) {
    btn.disabled = true; btn.textContent = 'Deleting…';
    return act('/delete-app', { app: app }, app+' was deleted.').then(function (){ if (ui.app === app) { ui.app = null; ui.env = null; D.writeHash(); return D.refresh(); } });
  };
  D.cancelDelete = function (app) { return act('/delete-app', { app: app, __method:'DELETE' }, app+' stays. Nothing was deleted.'); };

  var menu = $('#menu');
  function closeMenu() { menu.hidden = true; }
  function openMenu(ip, x, y) {
    var allowed = D.isAllowed(ip), ban = D.banOf(ip), you = D.isYou(ip);
    var items = [];
    if (allowed) items.push(['secondary','star','Stop always allowing', function (){ D.disallow(ip); }]);
    else items.push(['good','star','Always allow this address', function (){ D.allow(ip, you?'This computer':''); }]);
    if (ban) items.push(['','unlock','Unblock now (blocked '+esc(D.until(ban.until))+' more)', function (){ D.unban(ip); }]);
    if (!(ui.tab==='security' && ui.ipFilter)) items.push(['','search','Show only this address', function (){ ui.tab='security'; ui.ipFilter = ip; D.writeHash(); D.render(); }]);
    items.push(['','list','Copy address', function (){ (navigator.clipboard?navigator.clipboard.writeText(ip):Promise.reject()).then(function (){ toast('Copied.'); }, function (){ toast('Couldn’t copy.', true); }); }]);
    menu.innerHTML = '<div class="m-head">'+esc(ip)+(you?' (this computer)':'')+'</div>'+items.map(function (it, i){ return '<button data-mi="'+i+'" class="'+(it[0]==='good'?'good':it[0]==='danger'?'danger':'')+'">'+ic(it[1])+esc(it[2])+'</button>'; }).join('');
    menu._items = items;
    menu.hidden = false;
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - w - 8)+'px';
    menu.style.top = Math.min(y, window.innerHeight - h - 8)+'px';
    var first = menu.querySelector('button'); if (first) first.focus();
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    var mi = t.closest && t.closest('[data-mi]');
    if (mi) { var items = menu._items; closeMenu(); items[+mi.dataset.mi][3](); return; }
    if (!menu.hidden && !t.closest('#menu')) closeMenu();
    var b = t.closest && t.closest('button, [data-pick-app]');
    if (!b) return;
    if (b.dataset.tab) { ui.tab = b.dataset.tab; D.writeHash(); D.render(); }
    else if (b.dataset.range) { ui.range = b.dataset.range; D.render(); }
    else if (b.dataset.env) { ui.env = b.dataset.env; D.writeHash(); D.refresh(); }
    else if (b.dataset.pickApp !== undefined) { ui.app = b.dataset.pickApp; ui.env = b.dataset.pickEnv; ui.tab = 'home'; D.writeHash(); D.refresh(); }
    else if (b.dataset.problems) { ui.problems = b.dataset.problems; D.render(); }
    else if (b.dataset.logs) { ui.logs = b.dataset.logs; if (b.dataset.logs==='server' && D.serverLogs==null) D.loadServerLogs(); D.render(); }
    else if (b.dataset.allow !== undefined) { D.allow(b.dataset.allow, b.dataset.label || ''); }
    else if (b.dataset.disallow !== undefined) { D.disallow(b.dataset.disallow); }
    else if (b.dataset.unban !== undefined) { D.unban(b.dataset.unban); }
    else if (b.dataset.delConfirm !== undefined) { D.confirmDelete(b.dataset.delConfirm, b); }
    else if (b.dataset.delCancel !== undefined) { D.cancelDelete(b.dataset.delCancel); }
    else if (b.hasAttribute('data-clear-ip')) { ui.ipFilter = ''; D.render(); }
    else if (b.dataset.ipMenu !== undefined) { var r = b.getBoundingClientRect(); openMenu(b.dataset.ipMenu, r.left, r.bottom + 4); }
  });

  document.addEventListener('contextmenu', function (e) {
    var row = e.target.closest && e.target.closest('tr.ctx[data-ip]');
    if (!row) return;
    e.preventDefault();
    openMenu(row.dataset.ip, e.clientX, e.clientY);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', function (){ closeMenu(); D.hideTip(); });
  window.addEventListener('scroll', function (){ if (!menu.hidden) closeMenu(); }, true);

  document.addEventListener('change', function (e) { if (e.target.id === 'app') { ui.app = e.target.value; ui.env = null; D.writeHash(); D.refresh(); } });
  document.addEventListener('input', function (e) { if (e.target.id === 'log-search') { ui.search = e.target.value; var pos = e.target.selectionStart; D.render(); var s = $('#log-search'); if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (x) {} } } });
  document.addEventListener('submit', function (e) {
    if (!e.target.matches('[data-allow-form]')) return;
    e.preventDefault();
    var f = e.target, ipEl = f.querySelector('[name=ip]'), lblEl = f.querySelector('[name=label]');
    if (ipEl.value.trim()) D.allow(ipEl.value.trim(), lblEl.value.trim());
  });

  /* Theme: follow the OS, remember an explicit choice. */
  function applyTheme(mode) {
    if (mode) document.documentElement.setAttribute('data-theme', mode); else document.documentElement.removeAttribute('data-theme');
    var dark = mode ? mode==='dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    var btn = $('#theme'); if (btn) btn.innerHTML = ic(dark?'sun':'moon')+'<span>'+(dark?'Light mode':'Dark mode')+'</span>';
  }
  var stored = null; try { stored = localStorage.getItem('basalt-theme'); } catch (e) {}
  applyTheme(stored);
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('#theme')) return;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.hasAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    var next = dark ? 'light' : 'dark';
    try { localStorage.setItem('basalt-theme', next); } catch (x) {}
    applyTheme(next);
  });

  window.addEventListener('hashchange', function () { var before = ui.tab+ui.app+ui.env; D.readHash(); if (before !== ui.tab+ui.app+ui.env) D.refresh(); });
  window.addEventListener('resize', function () { clearTimeout(D._rz); D._rz = setTimeout(function (){ if (D.data) D.drawCharts(); }, 150); });

  D.readHash();
  D.refresh();
  setInterval(function () { if (!document.hidden && menu.hidden) D.refresh(); }, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) D.refresh(); });
})(window.__dash);
