// Agent Relay website. Progressive enhancement only: mobile menu, install tabs and copy,
// dashboard view tabs, reveal on scroll, stat counters, and the one-time Team plan pop-up
// (remembered in localStorage). No network access, no analytics, no cookies.
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  function $(s, c) { return (c || doc).querySelector(s); }
  function $$(s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); }
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- mobile menu ----------------------------------------------------------
  var burger = $('.burger'), overlay = $('.mobile-overlay'), sheet = $('.mobile-menu-sheet');
  function setMenu(open) {
    if (!burger || !overlay) return;
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    overlay.hidden = !open;
  }
  if (burger && overlay) {
    burger.addEventListener('click', function () { setMenu(burger.getAttribute('aria-expanded') !== 'true'); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) setMenu(false); });
    if (sheet) sheet.addEventListener('click', function (e) { e.stopPropagation(); });
    $$('.mobile-link, .mobile-sign-in').forEach(function (link) { link.addEventListener('click', function () { setMenu(false); }); });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && burger.getAttribute('aria-expanded') === 'true') { setMenu(false); burger.focus(); }
    });
    window.addEventListener('resize', function () { if (window.innerWidth > 720 && burger.getAttribute('aria-expanded') === 'true') setMenu(false); });
  }

  // ---- install block ---------------------------------------------------------
  var install = $('#install');
  if (install) {
    var cmds = $$('.cmd', install), tabs = $$('.runner-tabs button', install);
    function show(runner) {
      cmds.forEach(function (c) { c.classList.toggle('on', c.dataset.runner === runner); });
      tabs.forEach(function (t) { t.setAttribute('aria-pressed', String(t.dataset.runner === runner)); });
    }
    tabs.forEach(function (t) { t.addEventListener('click', function () { show(t.dataset.runner); }); });
    var copy = $('#copy'), copyLabel = $('#copy-label'), status = $('#copy-status'), timer;
    function done(ok) {
      copy.dataset.state = ok ? 'done' : 'idle';
      copyLabel.textContent = ok ? 'Copied' : 'Copy failed';
      status.textContent = ok ? 'Command copied to the clipboard' : 'Copy failed. Select the command and copy it manually';
      clearTimeout(timer);
      timer = setTimeout(function () { copy.dataset.state = 'idle'; copyLabel.textContent = 'Copy'; }, 2200);
    }
    function fallback(text) {
      var ta = doc.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:-100px;opacity:0';
      doc.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = doc.execCommand('copy'); } catch (e) {}
      doc.body.removeChild(ta);
      done(ok);
    }
    if (copy) copy.addEventListener('click', function () {
      var active = cmds.filter(function (c) { return c.classList.contains('on'); })[0] || cmds[0];
      var text = active.dataset.cmd;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(text); });
      else fallback(text);
    });
  }

  // ---- dashboard view tabs ---------------------------------------------------
  var tablist = $('.views');
  if (tablist) {
    var vt = $$('[role=tab]', tablist);
    var panels = vt.map(function (t) { return doc.getElementById(t.getAttribute('aria-controls')); });
    function select(i, focus) {
      vt.forEach(function (t, j) {
        var on = i === j;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        panels[j].hidden = !on;
      });
      if (focus) vt[i].focus();
    }
    vt.forEach(function (t, i) {
      t.addEventListener('click', function () { select(i); });
      t.addEventListener('keydown', function (e) {
        var n = vt.length, k = e.key;
        if (k === 'ArrowRight' || k === 'ArrowDown') { e.preventDefault(); select((i + 1) % n, true); }
        else if (k === 'ArrowLeft' || k === 'ArrowUp') { e.preventDefault(); select((i + n - 1) % n, true); }
        else if (k === 'Home') { e.preventDefault(); select(0, true); }
        else if (k === 'End') { e.preventDefault(); select(n - 1, true); }
      });
    });
    select(0);
  } else {
    $$('.vpanel').forEach(function (p) { p.hidden = false; });
  }

  // ---- reveal on scroll ------------------------------------------------------
  var rv = $$('.rv');
  if (!('IntersectionObserver' in window) || calm) {
    rv.forEach(function (e) { e.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    rv.forEach(function (e) { io.observe(e); });
  }

  // ---- stat counters ---------------------------------------------------------
  var values = $$('.stat-value');
  if (values.length) {
    function format(el, value) {
      var decimals = Number(el.dataset.decimals || 0), suffix = el.dataset.suffix || '';
      return Number(value).toFixed(decimals) + suffix;
    }
    function setFinal() { values.forEach(function (el) { el.textContent = format(el, Number(el.dataset.target || 0)); }); }
    if (calm) { setFinal(); }
    else {
      // The markup carries the final values so the band reads right without JavaScript.
      values.forEach(function (el) { el.textContent = format(el, 0); });
      var counted = false;
      function run() {
        if (counted) return;
        counted = true;
        values.forEach(function (el, i) {
          var target = Number(el.dataset.target || 0), duration = 1500 + i * 80, offset = 420 + i * 90;
          setTimeout(function () {
            var start = performance.now();
            function frame(now) {
              var progress = Math.min((now - start) / duration, 1);
              var eased = 1 - Math.pow(1 - progress, 3);
              el.textContent = format(el, target * eased);
              if (progress < 1) requestAnimationFrame(frame); else el.textContent = format(el, target);
            }
            requestAnimationFrame(frame);
          }, offset);
        });
      }
      if ('IntersectionObserver' in window) {
        var band = $('.stats');
        var so = new IntersectionObserver(function (entries) {
          if (entries.some(function (en) { return en.isIntersecting && en.intersectionRatio >= 0.25; })) { run(); so.disconnect(); }
        }, { threshold: [0.25] });
        if (band) so.observe(band);
      } else run();
    }
  }
})();

// The hero film never plays for visitors who ask for less motion, and pauses off screen.
(() => {
  const video = document.querySelector('.hero-video');
  if (!video) return;
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  const stop = () => { video.pause(); video.removeAttribute('autoplay'); };
  if (still && still.matches) { stop(); return; }
  if (still && still.addEventListener) still.addEventListener('change', event => { if (event.matches) stop(); });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      for (const entry of entries) entry.isIntersecting ? video.play().catch(() => {}) : video.pause();
    }).observe(video);
  }
})();

// ---- Team plan pop-up --------------------------------------------------------
// Shown once per browser, a moment after the first visit to any page, so people
// learn about the Team plan without scrolling to it. Whether it has been seen is
// kept in localStorage (not a cookie). If storage is unavailable it never shows,
// rather than nagging on every visit. The form posts to the same endpoint as
// the full form on the home page, on the canonical origin.
(function () {
  'use strict';
  var KEY = 'agent-relay-team-pop';
  if (typeof HTMLDialogElement !== 'function') return;
  try {
    if (localStorage.getItem(KEY)) return;
    // Storage that cannot be written would show the pop-up on every visit.
    localStorage.setItem(KEY + '-probe', '1');
    localStorage.removeItem(KEY + '-probe');
  } catch (e) { return; }
  var team = document.querySelector('a.nav-team');
  var canonical = document.querySelector('link[rel="canonical"]');
  if (!team || !canonical) return;
  var seen = function () { try { localStorage.setItem(KEY, new Date().toISOString()); } catch (e) {} };
  // Someone already on their way to the Team section does not need the pop-up.
  if (location.hash === '#team') { seen(); return; }

  var dialog = document.createElement('dialog');
  dialog.className = 'team-pop';
  dialog.setAttribute('aria-labelledby', 'team-pop-title');
  dialog.innerHTML =
    '<button class="team-pop-close" type="button" aria-label="Close">&times;</button>' +
    '<canvas class="team-pop-scene" role="img" aria-label="Claude Code, OpenCode and Pi on your machine, and Codex and an OpenAI agent in the cloud, passing messages, claims and handovers through one relay room."></canvas>' +
    '<div class="team-pop-body">' +
      '<p class="kicker">Team plan &middot; waitlist</p>' +
      '<h2 id="team-pop-title">Running agents across a team?</h2>' +
      '<p>Agent Relay stays free, local and MIT licensed. We are deciding whether to build a hosted Team plan on top of it:</p>' +
      '<ul class="ticks">' +
        '<li>An always-on hosted relay: rooms keep running when your laptop sleeps, and cloud agents join with no tunnel.</li>' +
        '<li>One room per repository, shared by every teammate’s agents, with roles for who can approve a cloud agent.</li>' +
        '<li>A team dashboard, an audit log of claims and handovers, and Slack or webhook notifications.</li>' +
      '</ul>' +
      '<form method="post">' +
        '<label class="hp" aria-hidden="true">Leave this empty <input name="website" type="text" tabindex="-1" autocomplete="off"></label>' +
        '<input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@company.com" aria-label="Work email">' +
        '<button class="cta" type="submit">Join the waitlist</button>' +
      '</form>' +
      '<div class="team-pop-foot">' +
        '<a class="team-pop-more">Tell us more about your team</a>' +
        '<button type="button" class="team-pop-later">Not now</button>' +
      '</div>' +
    '</div>';
  dialog.querySelector('form').action = new URL('/api/waitlist', canonical.href).href;
  var more = dialog.querySelector('.team-pop-more');
  more.href = team.getAttribute('href');
  var close = function () { dialog.close(); };
  dialog.querySelector('.team-pop-close').addEventListener('click', close);
  dialog.querySelector('.team-pop-later').addEventListener('click', close);
  more.addEventListener('click', close);
  // A click on the dimmed backdrop lands on the dialog element itself.
  dialog.addEventListener('click', function (e) { if (e.target === dialog) close(); });
  document.body.appendChild(dialog);

  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var scene = relayScene(dialog.querySelector('.team-pop-scene'), calm);
  dialog.addEventListener('close', scene.stop);
  // It counts as seen only once it has actually opened, so leaving the page
  // before the delay does not use it up.
  var open = function () {
    if (location.hash === '#team') { seen(); return; }
    // Do not cover the mobile menu; try again once it has had time to close.
    var burger = document.querySelector('.burger');
    if (burger && burger.getAttribute('aria-expanded') === 'true') { setTimeout(open, 2000); return; }
    dialog.showModal();
    scene.start();
    seen();
  };
  setTimeout(open, calm ? 800 : 2500);

  // ---- the ASCII relay room -------------------------------------------------
  // A canvas drawn as a grid of monospace cells. Three agents sit on your
  // machine and two in the cloud, on either side of the gateway. Every message
  // travels sender → relay → receiver as a bright head with a fading trail,
  // amber on your machine and cyan once it has crossed the gateway. Bodies are
  // shaded spheres rasterised through a density ramp. Under reduced motion it
  // settles for a few seconds off-screen and shows one still frame.
  function relayScene(canvas, still) {
    var ctx = canvas.getContext('2d');
    var css = getComputedStyle(document.documentElement);
    var token = function (name, fallback) { return css.getPropertyValue(name).trim() || fallback; };
    var COLORS = ['#f2f2f4', token('--amber', '#ffb240'), token('--cyan', '#5cc8ff'), '#4a4a50'];
    var INK = 0, AMBER = 1, CYAN = 2, DIM = 3;
    var RAMP = ' .:-=+*%#@';
    var TRAIL = ' .-~=*';
    var family = getComputedStyle(canvas).fontFamily || 'ui-monospace, monospace';
    var EVENTS = ['claim src/api.ts', 'ack', 'handover: flaky test', 'msg: rebase done?', 'claim branch feat/auth', 'release build slot', 'roadmap 3/5 done', 'msg: review my diff', 'claim docs/', 'ack'];
    var AGENTS = [
      {name: 'claude code', short: 'claude', cloud: false, fx: .11, fy: .32},
      {name: 'opencode', short: 'opencode', cloud: false, fx: .11, fy: .64},
      {name: 'pi', short: 'pi', cloud: false, fx: .30, fy: .64},
      {name: 'codex cloud', short: 'codex', cloud: true, fx: .86, fy: .32},
      {name: 'openai agent', short: 'openai', cloud: true, fx: .86, fy: .64}
    ];
    var hub = {fx: .45, fy: .38};
    var cw = 7, ch = 13, cols = 0, rows = 0, w = 0, h = 0, gx = 0, radius = 0, hubR = 0;
    var trail, tint, packets = [], ripples = [], time = 0, nextSend = .3, gateFlash = 0, log = null, raf = 0, last = 0, running = false, count = 0;

    function resize() {
      var rect = canvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width; h = rect.height;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cw = w < 520 ? 6 : 7; ch = w < 520 ? 11 : 13;
      cols = Math.floor(w / cw); rows = Math.floor(h / ch);
      trail = new Float32Array(cols * rows); tint = new Uint8Array(cols * rows);
      gx = Math.round(cols * .64);
      radius = Math.min(ch * 2.3, w * (w < 520 ? .075 : .05)); hubR = radius * 1.3;
      AGENTS.forEach(function (a) { a.x = a.fx * w; a.y = a.fy * h; a.flash = a.flash || 0; });
      hub.x = hub.fx * w; hub.y = hub.fy * h;
      packets = []; ripples = [];
      return true;
    }

    // A message route: a gentle curve from the sender to the relay and on to the
    // receiver, through the gateway whenever a cloud agent is at either end.
    function route(from, to) {
      var stops = [from];
      if (from.cloud) stops.push({x: gx * cw, y: (from.y + hub.y) / 2});
      stops.push(hub);
      if (to.cloud) stops.push({x: gx * cw, y: (to.y + hub.y) / 2});
      stops.push(to);
      var points = [];
      for (var i = 0; i < stops.length - 1; i++) {
        var a = stops[i], b = stops[i + 1], bend = (i % 2 ? -1 : 1) * .18;
        var mx = (a.x + b.x) / 2 - (b.y - a.y) * bend, my = (a.y + b.y) / 2 + (b.x - a.x) * bend;
        for (var s = 0; s < 24; s++) {
          var t = s / 24, u = 1 - t;
          points.push({x: u * u * a.x + 2 * u * t * mx + t * t * b.x, y: u * u * a.y + 2 * u * t * my + t * t * b.y});
        }
      }
      points.push({x: to.x, y: to.y});
      return points;
    }

    function send() {
      var from = AGENTS[Math.floor(Math.random() * AGENTS.length)], to = from;
      while (to === from) to = AGENTS[Math.floor(Math.random() * AGENTS.length)];
      var label = EVENTS[count++ % EVENTS.length];
      if (label === 'ack') label = 'ack #' + (40 + count);
      packets.push({points: route(from, to), at: 0, to: to, color: from.cloud ? CYAN : AMBER});
      from.flash = Math.max(from.flash, .6);
      log = {text: (w < 520 ? from.short : from.name) + ' → ' + (w < 520 ? to.short : to.name) + '  ' + label, born: time};
    }

    function deposit(x, y, color) {
      var c = Math.floor(x / cw), r = Math.floor(y / ch);
      if (c < 0 || r < 0 || c >= cols || r >= rows) return;
      var i = r * cols + c;
      trail[i] = 1; tint[i] = color;
    }

    function step(dt) {
      time += dt;
      var fade = Math.exp(-dt * 1.3);
      for (var i = 0; i < trail.length; i++) trail[i] *= fade;
      gateFlash *= Math.exp(-dt * 3);
      AGENTS.forEach(function (a) { a.flash *= Math.exp(-dt * 2.4); });
      if (time >= nextSend) { send(); nextSend = time + .55 + Math.random() * .7; }
      packets = packets.filter(function (p) {
        var before = p.points[Math.floor(p.at)];
        p.at += dt * 34;
        var end = p.points.length - 1;
        for (var k = Math.floor(before ? p.at - dt * 34 : 0); k <= Math.min(end, Math.floor(p.at)); k++) {
          var pt = p.points[Math.max(0, k)];
          if (pt.x >= gx * cw && p.color === AMBER) p.color = CYAN;
          else if (pt.x < gx * cw && p.color === CYAN && p.points[end].x < gx * cw) p.color = AMBER;
          deposit(pt.x, pt.y, p.color);
        }
        var now = p.points[Math.min(end, Math.floor(p.at))];
        if (before && (before.x < gx * cw) !== (now.x < gx * cw)) gateFlash = 1;
        if (p.at >= end) { p.to.flash = 1; ripples.push({x: p.to.x, y: p.to.y, age: 0, color: p.to.cloud ? CYAN : AMBER}); return false; }
        p.head = now;
        return true;
      });
      ripples = ripples.filter(function (rp) {
        rp.age += dt;
        var rr = radius * (1.15 + rp.age * 2.2);
        for (var a = 0; a < 6.283; a += .22) deposit(rp.x + Math.cos(a) * rr, rp.y + Math.sin(a) * rr, rp.color);
        return rp.age < .35;
      });
    }

    // Brightness of a shaded sphere at a cell centre, or -1 outside it.
    function sphere(px, py, cx, cy, r) {
      var nx = (px - cx) / r, ny = (py - cy) / r, d2 = nx * nx + ny * ny;
      if (d2 >= 1) return -1;
      var nz = Math.sqrt(1 - d2);
      return .18 + .82 * Math.max(0, -.45 * nx - .55 * ny + .7 * nz);
    }

    function text(str, col, row, color, alpha) {
      ctx.globalAlpha = alpha; ctx.fillStyle = COLORS[color];
      for (var i = 0; i < str.length; i++) {
        var c = col + i;
        if (c < 0 || c >= cols || row < 0 || row >= rows || str[i] === ' ') continue;
        ctx.fillText(str[i], c * cw + cw / 2, row * ch + ch / 2 + 1);
      }
    }

    function draw() {
      ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
      ctx.font = '600 ' + Math.round(ch * .82) + 'px ' + family;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var hubCol = Math.round(hub.x / cw);
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          var px = (c + .5) * cw, py = (r + .5) * ch, i = r * cols + c, glyph = '', color = INK, alpha = 1;
          // The relay: a turning ring of amber around a white relay cross.
          var hb = sphere(px, py, hub.x, hub.y, hubR);
          if (hb >= 0) {
            var dx = px - hub.x, dy = py - hub.y, d = Math.sqrt(dx * dx + dy * dy) / hubR;
            if (d > .74) {
              if (Math.sin(5 * Math.atan2(dy, dx) - time * 2.2) > -.2) { glyph = '#'; color = AMBER; alpha = .95; }
            } else if ((Math.abs(dx) < cw * .9 || Math.abs(dy) < ch * .5) && d < .58) {
              glyph = '@'; alpha = 1;
            } else { glyph = RAMP[1 + Math.floor(hb * 3)]; color = DIM; alpha = .9; }
          }
          // The agents: lit spheres that brighten when they send or receive.
          if (!glyph) for (var k = 0; k < AGENTS.length; k++) {
            var a = AGENTS[k], s = sphere(px, py, a.x, a.y, radius);
            if (s < 0) continue;
            var lit = Math.min(1, s * (.8 + .5 * a.flash));
            glyph = RAMP[Math.max(1, Math.min(RAMP.length - 1, Math.round(lit * (RAMP.length - 1))))];
            var edge = Math.hypot(px - a.x, py - a.y) / radius;
            color = a.flash > .25 && edge > .7 ? (a.cloud ? CYAN : AMBER) : INK;
            alpha = .55 + .45 * lit;
            // Two eyes, which blink every few seconds on each agent's own clock.
            var ex = Math.abs(px - a.x) - radius * .34, ey = py - (a.y - radius * .12);
            if (Math.abs(ex) < cw * .6 && Math.abs(ey) < ch * .5) {
              glyph = (time + k * 1.37) % 4 < .14 ? '-' : 'o';
              color = a.cloud ? CYAN : AMBER; alpha = 1;
            }
            break;
          }
          if (!glyph && trail[i] > .05) {
            glyph = TRAIL[Math.min(TRAIL.length - 1, 1 + Math.floor(trail[i] * (TRAIL.length - 1)))];
            color = tint[i]; alpha = Math.min(1, .25 + trail[i] * 1.1);
          }
          if (!glyph && c === gx && r > 0 && r < rows - 1) {
            glyph = r % 2 ? ':' : '.'; color = gateFlash > .1 ? CYAN : DIM; alpha = .5 + .5 * gateFlash;
          }
          if (!glyph && c % 4 === 0 && r % 2 === 1) {
            var tw = .5 + .5 * Math.sin(time * 1.3 + c * 1.7 + r * 2.9);
            if (tw > .55) { glyph = '.'; color = DIM; alpha = .35 * tw; }
          }
          if (glyph) {
            ctx.globalAlpha = alpha; ctx.fillStyle = COLORS[color];
            ctx.fillText(glyph, px, r * ch + ch / 2 + 1);
          }
        }
      }
      packets.forEach(function (p) { if (p.head) text('@', Math.floor(p.head.x / cw), Math.floor(p.head.y / ch), INK, 1); });
      // Labels: the two sides, the gateway, the relay and each agent.
      var narrow = w < 520;
      text(narrow ? 'LOCAL' : 'LOCAL · your machine', 2, 1, AMBER, .9);
      text(narrow ? 'CLOUD' : 'CLOUD · remote', gx + 3, 1, CYAN, .9);
      text('gateway', gx - 3, 0, gateFlash > .1 ? CYAN : DIM, .6 + .4 * gateFlash);
      var relay = narrow ? 'relay' : 'relay · 127.0.0.1';
      text(relay, hubCol - Math.floor(relay.length / 2), Math.round((hub.y + hubR) / ch) + 1, INK, .75);
      AGENTS.forEach(function (a) {
        var label = narrow ? a.short : a.name;
        text(label, Math.round(a.x / cw) - Math.floor(label.length / 2), Math.round((a.y + radius) / ch) + 1, a.cloud ? CYAN : INK, .85);
      });
      if (log) {
        var shown = log.text.slice(0, Math.floor((time - log.born) * 45));
        text('> ' + shown + (Math.floor(time * 2) % 2 ? '_' : ' '), 2, rows - 1, INK, .55);
      }
      ctx.globalAlpha = 1;
    }

    function frame(now) {
      var dt = Math.min(.1, (now - last) / 1000);
      last = now;
      step(dt);
      draw();
      raf = requestAnimationFrame(frame);
    }

    var observer = window.ResizeObserver ? new ResizeObserver(function () { if (running && resize() && still) settle(); }) : null;
    function settle() { for (var i = 0; i < 200; i++) step(1 / 60); draw(); }

    return {
      start: function () {
        if (running) return;
        running = true;
        if (!resize()) return;
        if (observer) observer.observe(canvas);
        // Canvas text cannot trigger a font load; redraw the still frame once it is in.
        if (still) { settle(); if (document.fonts) document.fonts.ready.then(draw); return; }
        last = performance.now();
        raf = requestAnimationFrame(frame);
      },
      stop: function () {
        running = false;
        cancelAnimationFrame(raf);
        if (observer) observer.disconnect();
      }
    };
  }
})();
