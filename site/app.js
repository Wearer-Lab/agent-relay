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
    '<div class="team-pop-body">' +
      '<button class="team-pop-close" type="button" aria-label="Close">&times;</button>' +
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
  // It counts as seen only once it has actually opened, so leaving the page
  // before the delay does not use it up.
  var open = function () {
    if (location.hash === '#team') { seen(); return; }
    // Do not cover the mobile menu; try again once it has had time to close.
    var burger = document.querySelector('.burger');
    if (burger && burger.getAttribute('aria-expanded') === 'true') { setTimeout(open, 2000); return; }
    dialog.showModal();
    seen();
  };
  setTimeout(open, calm ? 800 : 2500);
})();
