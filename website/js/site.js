/* ============================================================================
   4КУБ — site behaviour. No dependencies, no external requests.
   Three jobs: reveal sequencing, nav scrolled-state, and the mobile disclosure.
   No scroll loop — both scroll-linked effects are done by the browser (the nav
   via an IntersectionObserver marker, the progress bar via scroll-timeline).

   SHAPE OF THIS FILE: two halves, split by WHEN they may run.
   The synchronous half only WRITES (class lists, custom properties, listener
   registration) — nothing in it reads layout. Everything that measures —
   offsetWidth, offsetTop, getBoundingClientRect, getComputedStyle, and even
   touching document.fonts.ready, which forces a full style+layout pass in
   Chromium all by itself — lives in initDeferred(), scheduled one frame after
   first paint. Run synchronously, those reads welded HTML parse, script and a
   full-document layout into one multi-second main-thread task on a throttled
   phone, with first paint queued behind it. Nothing measured here is needed
   before the first frame: every custom property the scroll timelines consume
   has a workable default, and at scroll position 0 every timeline is holding
   its `from` frame regardless of where its range ends.
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
        kids[k].style.setProperty('--d', (k * 90) + 'ms');
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

  /* ---- local sequencing ------------------------------------------------- */

  var sequenceGroups = document.querySelectorAll('.asst-chat, .team-table tbody, .day-stage');
  for (var s = 0; s < sequenceGroups.length; s++) {
    var sequenceItems = sequenceGroups[s].children;
    for (var q = 0; q < sequenceItems.length; q++) {
      sequenceItems[q].style.setProperty('--seq', q);
    }
  }

  /* ---- mobile disclosure -------------------------------------------------- */
  /* Stays synchronous: it is the only piece a reader can interact with in the
     first fraction of a second, and it neither reads nor invalidates layout. */

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

  /* Distance from the top of the DOCUMENT. Walks the offsetParent chain rather
     than reading offsetTop directly: base.css sets `body > * { position:
     relative }`, which makes <main> the offsetParent, so a bare offsetTop is
     measured from <main> and silently omits everything above it. */
  function documentTop(el) {
    var y = 0;
    while (el) { y += el.offsetTop; el = el.offsetParent; }
    return y;
  }

  /* ═══ DEFERRED HALF — everything below runs one frame after first paint ═══ */

  function initDeferred() {

    /* ---- hero pin + curtain geometry -------------------------------------- */

    /* The hero is held at the top of the viewport until .day reaches it, then the
       halves part to uncover it. Those two distances cannot be written in CSS:
       the hero is taller than one viewport (its own content decides how much), and
       whether an intro spacer sits above it changes where it starts. Hard-coding
       200vh left .day still a third of a screen down when the curtains finished.

       offsetTop, not getBoundingClientRect: the hero is mid-transform while this
       runs, and a rect would report where it is drawn rather than where it lives.

       This block runs BEFORE the intro flight on purpose, and the order is a
       read/write discipline rather than taste: on fonts.ready the two callbacks
       fire back-to-back in registration order. This one only reads layout and
       writes custom properties nothing lays out against, so the flight's reads
       land on a still-clean tree — flight-first meant its writes (left/top on
       the fixed lockup, the intro-ready class) dirtied layout and this block's
       documentTop walk forced a second full pass in the same task. */

    var heroEl = document.querySelector('.hero');
    var dayEl = document.querySelector('.day');
    var measureHero = null;

    if (heroEl && dayEl) {
      measureHero = function () {
        var heroTop = documentTop(heroEl);
        var dayTop = documentTop(dayEl);
        var heroH = heroEl.offsetHeight;
        var vh = window.innerHeight;
        if (dayTop <= heroTop) return;

        /* SETTLE is the scroll position where the hero's own bottom reaches the
           bottom of the viewport. Holding the hero before that point strands
           whatever does not fit — pinning it at the top from the very start made
           the buttons and the meta row permanently unreachable, because the reader
           cannot scroll to something that is being held still. So: arrive, then
           scroll normally until the whole hero has been seen, and only then hold.
           On a viewport taller than the hero this collapses to heroTop and the
           free-scroll phase simply has zero length. */
        var settle = Math.max(heroTop, heroTop + heroH - vh);

        var root = document.documentElement.style;
        root.setProperty('--hero-arrive-from', -heroTop + 'px');
        root.setProperty('--hero-arrive-end', heroTop + 'px');
        root.setProperty('--hero-settle', settle + 'px');
        root.setProperty('--hero-pin-end', dayTop + 'px');
        root.setProperty('--hero-hold-to', (dayTop - settle) + 'px');
        /* The hold is split in two so the acts do not collide: the curtains clear
           over the first ~55% of it, and only then does .day begin to appear.
           Overlapping them (the fade used to start at 34%) meant the hero was
           still a third on screen while the next section was already surfacing
           through the gap, and the two read as one muddled layer. */
        var hold = dayTop - settle;
        root.setProperty('--hero-part-end', Math.round(settle + hold * 0.55) + 'px');
        // .day is held at the top of the viewport across the whole span and fades
        // in there, so it is uncovered rather than delivered by scrolling.
        root.setProperty('--day-from', (settle - dayTop) + 'px');
        root.setProperty('--day-fade-start', Math.round(settle + hold * 0.6) + 'px');
      };
      measureHero();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureHero);
      window.addEventListener('resize', measureHero);
    }

    /* ---- intro lockup flight ---------------------------------------------- */

    /* The travel itself is a CSS scroll timeline. This only measures the two ends
       and publishes them, because CSS cannot ask how wide a word is or where the
       nav mark landed inside a centred, padded shell.
         --fly-dx/--fly-dy  offset that puts the big lockup in the viewport centre
         --fly-end          scale that shrinks it to nav-mark width
         --mark-x/--mark-y  where it comes to rest
       Measured with offsetWidth (layout size, unaffected by the transform the
       animation is applying) and the nav mark's own rect, which is untransformed. */

    var introEl = document.querySelector('.intro');
    var introMark = document.querySelector('.intro-mark');
    var navMarkEl = document.querySelector('.nav-mark');
    var introSeen = document.documentElement.classList.contains('intro-seen');

    if (introEl && introMark && navMarkEl && !introSeen) {
      var measureFlight = function () {
        var flyW = introMark.offsetWidth;
        var flyH = introMark.offsetHeight;
        if (!flyW || !flyH) return;
        var mark = navMarkEl.getBoundingClientRect();
        var root = document.documentElement.style;
        // Scale is set from WIDTH, so the landed height rarely equals the nav
        // mark's (the lockup's glyph-to-gap ratio differs). Centre it on that
        // height instead of top-aligning, or it comes to rest a couple of pixels
        // high and the hand-off shows.
        var endScale = mark.width / flyW;
        root.setProperty('--mark-x', mark.left + 'px');
        root.setProperty('--mark-y', (mark.top + (mark.height - flyH * endScale) / 2) + 'px');
        root.setProperty('--fly-end', endScale);
        root.setProperty('--fly-dx', ((window.innerWidth - flyW) / 2 - mark.left) + 'px');
        root.setProperty('--fly-dy', ((window.innerHeight - flyH) / 2 - mark.top) + 'px');
        document.documentElement.classList.add('intro-ready');
      };

      // Fonts first: the lockup is type, so its width is wrong until they load.
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(measureFlight);
      } else {
        measureFlight();
      }
      // Not a scroll loop — resize only, and the geometry genuinely changes.
      window.addEventListener('resize', measureFlight);
    }

    /* ---- day: five beats, one screen each ---------------------------------- */

    /* The section stops being something you scroll past and becomes five frames
       shown one at a time, centred, each replacing the last:
         0  the heading + lede        1..3  each moment on its own        4  the row

       Scroll-driven, never timed. Stop scrolling and the current frame stays up
       for as long as you want to read it; scroll continuously and each gets about
       --day-beat worth of travel, which at a normal wheel speed is roughly two
       seconds. It cannot be exactly two seconds for everyone — a trackpad flick
       covers the same distance several times faster — so --day-beat is the single
       number to turn if it feels wrong.

       The three solo cards are CLONES of the real ones and are hidden from
       assistive tech; the row in the final beat is the original markup. One source
       of truth, so an edit to a card can never apply to only half the section.

       Built only when it can actually run. No JS, reduced motion, no scroll
       timelines, or a narrow screen (where the row would not fit one frame) all
       fall through to the ordinary section that is in the HTML.

       Scheduled at idle (capped), not in this frame: the build clones DOM,
       reads getComputedStyle and re-walks offsets — deep below-the-fold work.
       A reader cannot reach .day before idle arrives; the hero pin above holds
       the first 200vh of scroll regardless, published from defaults-safe vars. */

    var dayCinema = document.querySelector('.day');
    var canCinema = !reduceMotion &&
                    window.CSS && CSS.supports && CSS.supports('animation-timeline: scroll()') &&
                    window.innerWidth >= 860;

    var buildCinema = function () {
      var shell = dayCinema.querySelector('.shell');
      var dayHead = dayCinema.querySelector('.day-head');
      var dayRail = dayCinema.querySelector('.day-rail');
      var dayCards = dayRail ? dayRail.querySelectorAll('.day-card') : [];

      if (!(shell && dayHead && dayRail && dayCards.length === 3)) return;

      var reel = document.createElement('div');
      reel.className = 'day-reel';
      var frame = document.createElement('div');
      frame.className = 'day-frame';
      reel.appendChild(frame);

      var beats = [];
      var addBeat = function (node, solo) {
        var b = document.createElement('div');
        b.className = 'day-beat' + (solo ? ' is-solo' : '');
        if (solo) {
          b.setAttribute('aria-hidden', 'true');
          // The picture is hoisted off the card and onto the beat, because the
          // beat is the whole screen and that is what now carries it.
          // Stashed as data, not set as the property: the moment --card-img
          // lands on a rendered beat the browser fetches the file, and that is
          // 219 KB the first screen never shows. The observer below applies it
          // when the reel is two viewports out.
          var img = node.style.getPropertyValue('--card-img');
          if (img) b.setAttribute('data-card-img', img);
          /* Split the time into characters so each can roll on its own slightly
             later window — the whole block moving as one reads as a slide, the
             cascade reads as digits turning over. Clones only, so the row at
             the end keeps plain selectable text. */
          var clock = node.querySelector('.day-time');
          if (clock) {
            var glyphs = clock.textContent.trim().split('');
            clock.textContent = '';
            for (var q = 0; q < glyphs.length; q++) {
              /* Two elements per glyph, and the pair is the whole trick: the
                 outer cell is one line tall and clips, the inner one rolls
                 inside it. A single element cannot do both, and when the clip
                 sat on .day-time instead it did nothing in the >=900px grid,
                 where the clock spans 20 rows to reach the margin and its box
                 is ~337px tall — so the digits slid up into place in plain
                 view rather than turning over behind an edge. */
              var sp = document.createElement('span');
              sp.className = 'day-glyph';
              sp.style.setProperty('--i', q);
              // Separators get their own narrower cell; every digit shares one
              // fixed width so the clock lands identically on all three beats.
              if (!/[0-9]/.test(glyphs[q])) sp.className += ' is-sep';
              var roll = document.createElement('i');
              roll.textContent = glyphs[q];
              sp.appendChild(roll);
              clock.appendChild(sp);
            }
          }
        }
        var inner = document.createElement('div');
        inner.className = 'day-beat-in';
        inner.appendChild(node);
        b.appendChild(inner);
        frame.appendChild(b);
        beats.push(b);
      };

      /* Read a card's drawn stage back out as data. The finale is built FROM
         the cards rather than from its own copy, for the same reason the solo
         beats clone them: the HTML stays the one place any of this is written,
         and a card edit cannot apply to only half the section. */
      var readStage = function (card) {
        var rows = card.querySelectorAll('.day-stage-row');
        var out = [];
        for (var i = 0; i < rows.length; i++) {
          var value = rows[i].querySelector('span');
          var label = '';
          var kids = rows[i].childNodes;
          for (var j = 0; j < kids.length; j++) {
            if (kids[j] !== value) label += kids[j].textContent;
          }
          out.push({
            label: label.replace(/\s+/g, ' ').trim(),
            value: value ? value.textContent : '',
            live: !!rows[i].querySelector('b'),
          });
        }
        return out;
      };
      var el = function (tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      };

      /* THE CLOSE — the day ends. Everything above is paper warming towards
         evening; this beat leaves paper for --night, the app's own lacquer, and
         the only lit thing is the device the day happened on. It is also why
         the finale never needed the photograph it never had: a lit screen IS
         the light. Built here, not in index.html, because it exists only in
         cinema mode — below 860px the ordinary three-card section stands. */
      var buildClose = function (cards) {
        var close = el('div', 'day-close');
        close.setAttribute('aria-hidden', 'true');   // the real cards ride along below

        var last = cards[cards.length - 1];
        var copy = el('div', 'day-close-copy');
        copy.appendChild(el('p', 'eyebrow', 'Один день'));
        copy.appendChild(el('h2', 'h2', last.querySelector('h3').textContent));
        copy.appendChild(el('p', 'lede', last.querySelector('p:not(.day-time)').textContent));
        close.appendChild(copy);

        var wrap = el('div', 'day-dev-wrap');
        var dev = el('div', 'day-dev');
        var scr = el('div', 'day-scr');

        var top = el('div', 'day-scr-top');
        top.appendChild(el('span', null, 'Итоги'));
        top.appendChild(el('span', null, last.querySelector('.day-time').textContent));
        scr.appendChild(top);

        var tots = el('div', 'day-scr-tots');
        var totals = readStage(last);
        for (var t = 0; t < totals.length; t++) {
          var cell = el('div');
          cell.appendChild(el('b', null, totals[t].value));
          cell.appendChild(el('span', null, totals[t].label));
          tots.appendChild(cell);
        }
        scr.appendChild(tots);

        // The three times have sat in the left margin for three beats. Here
        // they are rows in the app, in order, with the current one lit.
        var log = el('ul', 'day-scr-log');
        for (var i = 0; i < cards.length; i++) {
          var li = el('li');
          li.style.setProperty('--n', i);
          if (i === cards.length - 1) li.className = 'is-on';
          li.appendChild(el('time', null, cards[i].querySelector('.day-time').textContent));
          li.appendChild(el('span', null, cards[i].querySelector('h3').textContent));
          log.appendChild(li);
        }
        scr.appendChild(log);

        // Without the middle card's funnel the screen ran out of content a
        // third of the way down and the device read as an empty slab.
        if (cards.length > 1) {
          scr.appendChild(el('p', 'day-scr-h', 'Воронка'));
          var funnel = el('ul', 'day-scr-funnel');
          var stages = readStage(cards[1]);
          for (var s = 0; s < stages.length; s++) {
            var row = el('li', stages[s].live ? 'is-on' : null);
            row.appendChild(el('i'));
            row.appendChild(el('span', null, stages[s].label));
            row.appendChild(el('b', null, stages[s].value));
            funnel.appendChild(row);
          }
          scr.appendChild(funnel);
        }

        var tabs = el('div', 'day-scr-tabs');
        for (var k = 0; k < 4; k++) tabs.appendChild(el('i', k === 3 ? 'is-on' : null));
        scr.appendChild(tabs);

        dev.appendChild(scr);
        wrap.appendChild(dev);
        close.appendChild(wrap);
        return close;
      };

      addBeat(dayHead, false);
      for (var c = 0; c < dayCards.length; c++) {
        var clone = dayCards[c].cloneNode(true);
        addBeat(clone, true);
      }

      addBeat(buildClose(dayCards), false);
      var closeBeat = beats[beats.length - 1];
      closeBeat.classList.add('is-close');
      /* The solo beats are aria-hidden clones, so the rail is the only copy of
         this section a screen reader ever had. It keeps riding in the last
         beat — now visually hidden — rather than being dropped for the device,
         which would have silently deleted the whole section from AT. */
      dayRail.classList.add('day-sr');
      closeBeat.querySelector('.day-beat-in').appendChild(dayRail);
      // The closing line belongs to the finale, not to a section that no longer
      // has a normal flow to sit in.
      var dayFoot = dayCinema.querySelector('.day-foot');
      if (dayFoot) closeBeat.querySelector('.day-close-copy').appendChild(dayFoot);

      // The beat's own fade is the only thing driving opacity here, so the
      // scroll-into-view reveal must not also be holding these at 0.
      var stale = frame.querySelectorAll('.reveal, .reveal-group');
      for (var v = 0; v < stale.length; v++) {
        stale[v].classList.remove('reveal');
        stale[v].classList.remove('reveal-group');
      }

      // Straight onto the section, NOT into .shell: a beat is a full-bleed screen
      // and cannot be born inside a 1400px centred column. Each beat re-applies
      // the shell's width and padding to its own contents instead.
      dayCinema.appendChild(reel);
      if (!shell.children.length) shell.remove();
      dayCinema.classList.add('is-cinema');

      /* The three plates, fetched on the first scroll instead of at load. The
         reel cannot be intersection-observed for this: day-arrive holds .day
         translated to the top of the viewport behind the hero from the very
         first frame, so its VISUAL rect always overlaps the viewport and an
         observer fires immediately. Scroll is the honest signal — the first
         solo beat is ~3 viewports of travel past the first scroll event, so
         the pixels always win the race. A {once} listener, not a scroll loop:
         it runs a single time and unregisters itself. The originals keep
         their inline --card-img untouched — no selector outside cinema mode
         ever reads it, so nothing downloads on narrow screens or without
         JavaScript either way. */
      var applyCardImgs = function () {
        for (var i = 0; i < beats.length; i++) {
          var u = beats[i].getAttribute('data-card-img');
          if (u) beats[i].style.setProperty('--card-img', u);
        }
      };
      if (window.scrollY > 0) applyCardImgs();
      else window.addEventListener('scroll', applyCardImgs, { once: true, passive: true });

      var measureBeats = function () {
        var beatPx = parseFloat(getComputedStyle(dayCinema).getPropertyValue('--day-beat')) || 1200;
        // Height = every beat's travel plus one screen, which is exactly how
        // long the sticky frame stays pinned.
        reel.style.height = (beats.length * beatPx + window.innerHeight) + 'px';
        var reelTop = documentTop(reel);
        /* Each beat starts a fade-length EARLY so its fade-in overlaps the
           previous beat's fade-out. Butted up exactly, the outgoing frame hit
           zero at the same scroll position the incoming one started from, and
           every transition flashed an empty screen. */
        var fade = beatPx * 0.12;
        for (var i = 0; i < beats.length; i++) {
          var lead = i === 0 ? 0 : fade;
          beats[i].style.setProperty('--beat-in', (reelTop + i * beatPx - lead) + 'px');
          beats[i].style.setProperty('--beat-out', (reelTop + (i + 1) * beatPx) + 'px');
        }
      };
      measureBeats();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureBeats);
      window.addEventListener('resize', measureBeats);
      // The hero's exit ends where .day begins, and .day just got much taller.
      if (typeof measureHero === 'function' && measureHero) measureHero();
    };

    if (dayCinema && canCinema) {
      if ('requestIdleCallback' in window) requestIdleCallback(buildCinema, { timeout: 1500 });
      else setTimeout(buildCinema, 200);
    }

    /* ---- nav ------------------------------------------------------------- */

    var nav = document.querySelector('.nav');
    if (nav && 'IntersectionObserver' in window) {
      // A tiny non-visual marker gives the fixed nav its scrolled state without a
      // handler running on every scroll frame.
      var navMarker = document.createElement('span');
      navMarker.setAttribute('aria-hidden', 'true');
      navMarker.style.cssText = 'position:absolute;top:12px;left:0;width:1px;height:1px;pointer-events:none';
      document.body.prepend(navMarker);

      var navObserver = new IntersectionObserver(function (entries) {
        nav.setAttribute('data-scrolled', entries[0].isIntersecting ? 'false' : 'true');
      }, { threshold: 0 });
      navObserver.observe(navMarker);
    }
  }

  /* One frame, then a task of its own: the rAF lands just before the first
     paint, the nested setTimeout just after it. requestIdleCallback is wrong
     for THIS hop — idle can arrive seconds late on a busy phone, and the hero
     pin geometry should be real before anyone has meaningfully scrolled. */
  if ('requestAnimationFrame' in window) {
    requestAnimationFrame(function () { setTimeout(initDeferred, 0); });
  } else {
    setTimeout(initDeferred, 0);
  }
})();
