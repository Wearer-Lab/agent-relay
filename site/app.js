// Agent Relay landing page. Progressive enhancement only: theme toggle, install tabs and copy, dashboard view tabs, reveal on scroll.
// No network access, no analytics, no cookies.
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  var KEY = 'agent-relay-site-theme';
  function $(s, c) { return (c || doc).querySelector(s); }
  function $$(s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); }

  // ---- theme -----------------------------------------------------------------
  var dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function effective() { return root.dataset.theme || (dark && dark.matches ? 'dark' : 'light'); }
  var toggle = $('#theme-toggle');
  function label() { if (toggle) toggle.setAttribute('aria-label', effective() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'); }
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = effective() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch (e) {}
      label();
    });
    label();
    if (dark && dark.addEventListener) dark.addEventListener('change', label);
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
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!('IntersectionObserver' in window) || calm) {
    rv.forEach(function (e) { e.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    rv.forEach(function (e) { io.observe(e); });
  }

  // ---- current section in the nav ---------------------------------------------
  var links = $$('.nav ul a[href^="#"]');
  if ('IntersectionObserver' in window && links.length) {
    var map = {};
    links.forEach(function (a) { var id = a.getAttribute('href').slice(1); var s = doc.getElementById(id); if (s) map[id] = a; });
    var so = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a) { a.removeAttribute('aria-current'); });
        var a = map[en.target.id]; if (a) a.setAttribute('aria-current', 'true');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(map).forEach(function (id) { so.observe(doc.getElementById(id)); });
  }
})();
