/* ============================================================================
   4КУБ — site behaviour. No dependencies, no external requests.
   Three jobs only: reveal on scroll, nav scrolled state, mobile nav disclosure.
   ========================================================================== */
(function () {
  'use strict';

  // The .js class is set by a synchronous script in <head>, not here: it has to
  // land before first paint. If THIS file fails to load, .js is still set and
  // every .reveal would stay hidden, so the safety net is the IntersectionObserver
  // fallback below plus the reduced-motion override in base.css.
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- reveal ------------------------------------------------------------ */

  var targets = document.querySelectorAll('.reveal');

  if (reduceMotion || !('IntersectionObserver' in window)) {
    // No animation, but everything must still be visible.
    for (var i = 0; i < targets.length; i++) targets[i].classList.add('is-in');
  } else {
    // Stagger is set per group, scoped to that group's own children.
    var groups = document.querySelectorAll('.reveal-group');
    for (var g = 0; g < groups.length; g++) {
      var kids = groups[g].children;
      for (var k = 0; k < kids.length; k++) {
        kids[k].style.setProperty('--d', (k * 70) + 'ms');
      }
    }

    var io = new IntersectionObserver(function (entries) {
      for (var e = 0; e < entries.length; e++) {
        if (!entries[e].isIntersecting) continue;
        entries[e].target.classList.add('is-in');
        io.unobserve(entries[e].target);   // reveal once; no re-trigger on scroll up
      }
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

    for (var t = 0; t < targets.length; t++) io.observe(targets[t]);
  }

  /* ---- nav ------------------------------------------------------------- */

  var nav = document.querySelector('.nav');
  if (nav) {
    var onScroll = function () {
      nav.setAttribute('data-scrolled', window.scrollY > 12 ? 'true' : 'false');
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  var burger = document.querySelector('.nav-burger');
  var panel = document.getElementById('nav-panel');
  if (burger && panel) {
    burger.addEventListener('click', function () {
      var open = panel.getAttribute('data-open') === 'true';
      panel.setAttribute('data-open', open ? 'false' : 'true');
      burger.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    // Any in-page jump closes the panel, otherwise it covers the target.
    var links = panel.querySelectorAll('a');
    for (var l = 0; l < links.length; l++) {
      links[l].addEventListener('click', function () {
        panel.setAttribute('data-open', 'false');
        burger.setAttribute('aria-expanded', 'false');
      });
    }
  }
})();
