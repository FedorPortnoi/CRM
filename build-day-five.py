#!/usr/bin/env python3
"""
Builds day-five-concept.html — DAY's closing beat, third approach.

The first two studies were rejected and both failed the same way: they were
quiet paper compositions, a thing printed beside some text. The CAPS decision
of 2026-08-07 says what this owner actually picks — caps-concept-3, whose own
note reads "Not a metaphor printed next to a feature list — the actual solid":
night, lit from behind, real grain, a real object, a real mechanism. The two
editorial/print concepts were passed over. So is a paper beat five.

Approach here: THE DAY ENDS. The section's ground has been warming pale morning
to deep evening for four beats; the fifth completes it into --night, the app's
own lacquer, and the only thing still lit is the phone the whole day happened
on. The picture problem dissolves — the screen IS the light source, so the beat
that never had a photograph does not need one.

Same rules as the other studies: everything inlined, opens with no server, and
the output stays OUT of website/ because that directory is public.
"""
import base64
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent
CSS = ROOT / 'website' / 'css' / 'base.css'
FONTS = ROOT / 'website' / 'fonts'
OUT = ROOT / 'day-five-concept.html'


def inlined_faces(css_text: str) -> str:
    blocks = re.findall(r'@font-face\s*\{[^}]*\}', css_text)
    if not blocks:
        raise SystemExit('no @font-face blocks found in base.css')

    def swap(match):
        data = (FONTS / match.group(1)).read_bytes()
        return ("url(data:font/woff2;base64,"
                + base64.b64encode(data).decode('ascii') + ") format('woff2')")

    out = []
    for block in blocks:
        if not any(f in block for f in ('Exo 2', 'Zen Old Mincho', 'JetBrains Mono')):
            continue
        if 'weight: 500' in block:
            continue
        out.append(re.sub(r"url\('/fonts/([^']+)'\)\s*format\('woff2'\)", swap, block))
    return '\n'.join(out)


def root_tokens(css_text: str) -> str:
    m = re.search(r':root\s*\{.*?\n\}', css_text, re.S)
    if not m:
        raise SystemExit('no :root block found in base.css')
    return m.group(0)


# Every label and figure below is already on the live page — the three beat
# headings, and the totals off the 19:05 card's .day-stage. Nothing invented.
LOG = [('09:40', 'Звонок в дороге'), ('14:15', 'Сделка сдвинулась'),
       ('19:05', 'Итоги без отчётов')]
TOTALS = [('3', 'Закрыто за день'), ('1', 'Просрочено')]
# The 14:15 card's own stage. Without it the screen ran out of content a third
# of the way down and the device read as an empty slab rather than a live app.
FUNNEL = [('Новый лид', '4', False), ('Переговоры', '7', True),
          ('Счёт отправлен', '2', False)]


def clock(text):
    """Same fixed cells as every other beat — Exo 2's tabular figures are not
    equal (4 is .619em, 8 is .613em against .620em), so the colon cannot be
    left to the font."""
    return ''.join(
        f'<span{"" if ch.isdigit() else " class=\"sep\""}>{ch}</span>' for ch in text)


def log_rows():
    return '\n'.join(
        f'''            <li style="--n:{i}"><time>{t}</time>{label}</li>'''
        for i, (t, label) in enumerate(LOG))


def funnel():
    return '\n'.join(
        f'''            <li{' class="is-on"' if live else ''}>'''
        f'''<i></i>{label}<b>{n}</b></li>''' for label, n, live in FUNNEL)


def totals():
    return '\n'.join(
        f'''            <div><b>{n}</b><span>{label}</span></div>'''
        for n, label in TOTALS)


PAGE = '''<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>4КУБ — DAY, пятый такт</title>
<style>
__FACES__

__ROOT__

/* ══════════════════════════════════════════════════════════════════════════
   DAY — beat five. THE DAY ENDS.

   Four beats of paper that warm from pale morning to deep evening, and then
   the light goes out. This beat is --night: not a new dark theme, the app's
   own lacquer, the same surface .asst, .day-stage and the accepted CAPS cube
   already sit on. It also means DAY no longer hands off to a dark CAPS with a
   jolt — the sections now meet on the same ground.

   THE OBJECT, NOT A PANEL. The previous two studies drew a rectangle next to
   some copy. Here the day's own device is the subject, held at an angle, lit,
   and it is the only light in the frame. That is what retires the section's
   oldest open problem: the finale never had a photograph and four attempts at
   one were turned down — a lit screen needs none, because it IS the light.

   THE DAY COLLAPSES INTO IT. 09:40, 14:15 and 19:05 have lived in the left
   margin for three beats. Here they are rows in the app, in order, and they
   arrive one after another as the beat comes up. The times keep the clock's
   instrument — Exo 2 200, tabular — but on night the accent must be
   --accent-lift, never --accent, which is a FILL and measures 1.8:1 here.
   ══════════════════════════════════════════════════════════════════════════ */

* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--night);
  color: var(--night-ink);
  font-family: var(--font-serif);
  -webkit-font-smoothing: antialiased;
}
:root { color-scheme: dark; --night-line-soft: rgba(239, 230, 216, 0.09);
        --night-deep: #0D0B09; }

.label {
  background: #000;
  color: var(--night-muted);
  font-family: var(--font-mono);
  font-size: var(--t-label);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  padding: 0.85rem clamp(1.25rem, 4vw, 3rem);
  display: flex; gap: 1.4rem; align-items: baseline;
}
.label b { color: var(--night-ink); font-weight: 600; letter-spacing: 0.18em; }
.label i { font-style: normal; margin-left: auto; opacity: 0.7; text-transform: none;
           letter-spacing: 0.06em; }

/* ── the frame ───────────────────────────────────────────────────────────── */
.beat {
  position: relative;
  height: 100dvh;
  min-height: 38rem;
  display: flex;
  align-items: center;
  /* Lit from behind the device — the only source in the frame, so the object
     reads as the thing being looked at. Same construction as the CAPS band. */
  background:
    radial-gradient(58% 46% at 72% 50%, rgba(204, 120, 92, 0.20), transparent 66%),
    radial-gradient(80% 60% at 72% 46%, rgba(239, 230, 216, 0.05), transparent 72%),
    var(--night);
  overflow: clip;   /* NOT hidden — hidden makes this a scroll container */
}
/* Fine lacquer grain, so a large flat dark field is never plastic. */
.beat::before {
  content: '';
  position: absolute; inset: 0; pointer-events: none; z-index: 0;
  opacity: 0.4; mix-blend-mode: soft-light;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23g)' opacity='0.3'/%3E%3C/svg%3E");
}
.in {
  position: relative; z-index: 1;
  width: 100%;
  max-width: var(--shell);
  margin-inline: auto;
  padding: clamp(2rem, 5vh, 3.4rem) clamp(1.25rem, 4vw, 3rem);
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(19rem, 34%, 26rem);
  gap: clamp(2rem, 6vw, 6rem);
  align-items: center;
}

/* ── the copy ────────────────────────────────────────────────────────────── */
.eyebrow {
  font-family: var(--font-mono); font-size: var(--t-label); letter-spacing: 0.18em;
  text-transform: uppercase; font-weight: 600; color: var(--accent-lift); margin: 0 0 1.3rem;
}
.copy h2 {
  margin: 0;
  font-family: var(--font-display);
  font-weight: 250;
  font-size: var(--t-h2);
  line-height: 1.06;
  letter-spacing: 0.005em;
  text-transform: uppercase;
  text-wrap: balance;
}
.copy .lede {
  font-family: var(--font-serif);
  font-size: clamp(1.02rem, 0.98rem + 0.3vw, 1.2rem);
  line-height: 1.75;
  color: var(--night-muted);
  max-width: 44ch;
  margin: 1.3rem 0 0;
}
.foot {
  display: flex; flex-wrap: wrap; gap: 0.6rem 2.4rem;
  margin: clamp(1.8rem, 4.5vh, 3rem) 0 0;
  padding-top: 1.3rem;
  border-top: 1px solid var(--night-line);
  font-family: var(--font-mono);
  font-size: var(--t-label);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--night-muted);
}
.foot b { color: var(--night-ink); font-weight: 600; }

/* ── the object ──────────────────────────────────────────────────────────── */
/* Long lens. At 1500px the near edge fisheyes and the screen stops being
   readable — the lesson the cube already paid for. */
.dev-wrap { perspective: 2400px; display: grid; place-items: center; }
.dev {
  position: relative;
  width: min(20rem, 100%);
  aspect-ratio: 41 / 84;
  border-radius: 2.1rem;
  padding: 0.5rem;
  transform: rotateY(-15deg) rotateX(4deg);
  transform-style: preserve-3d;
  background: linear-gradient(150deg, #3A3129 0%, #171310 42%, #0B0908 100%);
  box-shadow:
    0 0 0 1px rgba(239, 230, 216, 0.10),
    0 50px 90px -40px rgba(0, 0, 0, 0.95),
    /* the screen's own spill onto the dark */
    0 24px 120px -30px rgba(204, 120, 92, 0.32);
}
/* a single specular sweep, so the body reads as a solid and not a flat swatch */
.dev::after {
  content: '';
  position: absolute; inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: linear-gradient(118deg, rgba(239, 230, 216, 0.16) 0%, transparent 26%,
                              transparent 74%, rgba(239, 230, 216, 0.06) 100%);
}

.scr {
  height: 100%;
  border-radius: 1.7rem;
  background: var(--night-deep);
  border: 1px solid rgba(239, 230, 216, 0.07);
  padding: 1.15rem 1rem 0.9rem;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.scr-top {
  display: flex; justify-content: space-between; align-items: baseline;
  font-family: var(--font-mono); font-size: 0.58rem; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--night-muted);
  padding-bottom: 0.8rem; border-bottom: 1px solid var(--night-line-soft);
}

.scr-tots { display: flex; gap: 1.5rem; padding: 1.05rem 0 0.95rem; }
.scr-tots div { display: grid; gap: 0.1rem; }
/* the clock's instrument, carried into the payoff */
.scr-tots b {
  font-family: var(--font-display); font-weight: 200; font-size: 2.5rem;
  line-height: 1; letter-spacing: 0.01em; font-variant-numeric: tabular-nums;
  color: var(--accent-lift);
}
.scr-tots span {
  font-family: var(--font-mono); font-size: 0.5rem; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--night-muted);
}

.scr-log { list-style: none; margin: 0; padding: 0.85rem 0 0;
           border-top: 1px solid var(--night-line-soft); display: grid; gap: 0.4rem; }
.scr-log li {
  display: flex; align-items: baseline; gap: 0.7rem;
  background: rgba(239, 230, 216, 0.035);
  border: 1px solid var(--night-line-soft);
  border-radius: var(--radius);
  padding: 0.5rem 0.6rem;
  font-family: var(--font-mono); font-size: 0.575rem; letter-spacing: 0.02em;
  color: var(--night-ink);
}
.scr-log time {
  font-family: var(--font-display); font-weight: 200; font-size: 0.86rem;
  font-variant-numeric: tabular-nums; letter-spacing: 0.01em;
  color: var(--accent-lift); flex: none;
}
.scr-log li:last-child { background: rgba(204, 120, 92, 0.12);
                         border-color: rgba(204, 120, 92, 0.34); }

.scr-h {
  margin: 1.05rem 0 0.5rem;
  font-family: var(--font-mono); font-size: 0.5rem; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--night-muted);
}
.scr-funnel { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.34rem; }
.scr-funnel li {
  display: flex; align-items: center; gap: 0.55rem;
  padding: 0.42rem 0.6rem;
  border: 1px solid var(--night-line-soft);
  border-radius: var(--radius);
  font-family: var(--font-mono); font-size: 0.55rem; letter-spacing: 0.02em;
  color: var(--night-muted);
}
.scr-funnel li.is-on { color: var(--night-ink); border-color: rgba(204, 120, 92, 0.3); }
.scr-funnel i { width: 5px; height: 5px; border-radius: 50%; flex: none;
                background: rgba(239, 230, 216, 0.28); }
.scr-funnel li.is-on i { background: var(--accent); }
.scr-funnel b { margin-left: auto; font-weight: 400; font-variant-numeric: tabular-nums; }

/* the app's own tab bar, one lit — the same tell the cube faces use */
.scr-tabs { margin-top: auto; padding-top: 0.9rem; display: flex; gap: 0.42rem;
            justify-content: center; }
.scr-tabs i { width: 22px; height: 3px; border-radius: 2px;
              background: rgba(239, 230, 216, 0.16); }
.scr-tabs i.is-on { background: var(--accent); width: 30px; }

/* ── the assembly, driven by scroll ──────────────────────────────────────── */
/* The device rises and the day's rows land one after another as the beat comes
   up. Gated exactly like the CAPS pin: enhancement only, and the composed
   frame above is what everyone else gets. */
@media (min-width: 1000px) and (prefers-reduced-motion: no-preference) {
  @supports (animation-timeline: view()) {
    .dev {
      animation: dev-rise linear both;
      animation-timeline: view();
      animation-range: entry 12% cover 42%;
    }
    .scr-log li {
      animation: row-land linear both;
      animation-timeline: view();
      animation-range: calc(entry 26% + var(--n) * 90px) calc(cover 46% + var(--n) * 90px);
    }
  }
}
@keyframes dev-rise {
  from { opacity: 0; transform: rotateY(-15deg) rotateX(4deg) translateY(38px) scale(0.985); }
  to   { opacity: 1; transform: rotateY(-15deg) rotateX(4deg) translateY(0) scale(1); }
}
@keyframes row-land {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}

@media (max-width: 859px) {
  .beat { height: auto; padding-block: 3.5rem; }
  .in { grid-template-columns: 1fr; gap: 2.6rem; }
  .dev { width: min(17rem, 100%); transform: none; }
}
</style>
</head>
<body>

<div class="label"><b>E</b> Вечер · день заканчивается <i>--night, лакировка приложения · объект, а не панель · экран — единственный свет</i></div>
<section class="beat">
  <div class="in">
    <div class="copy">
      <p class="eyebrow">Один день</p>
      <h2>Итоги без отчётов</h2>
      <p class="lede">Сколько закрыли, что просрочено, кому не позвонили. Один экран вместо вечерней переписки с командой.</p>
      <p class="foot">
        <span>Один день · <b>3 момента</b></span>
        <span>Ни одного отчёта</span>
        <span>Ни одной выгрузки в Excel</span>
      </p>
    </div>

    <div class="dev-wrap" aria-hidden="true">
      <div class="dev">
        <div class="scr">
          <div class="scr-top"><span>Итоги</span><span>__CLOCK__</span></div>
          <div class="scr-tots">
__TOTALS__
          </div>
          <ul class="scr-log">
__LOG__
          </ul>
          <p class="scr-h">Воронка</p>
          <ul class="scr-funnel">
__FUNNEL__
          </ul>
          <div class="scr-tabs"><i></i><i></i><i></i><i class="is-on"></i></div>
        </div>
      </div>
    </div>
  </div>
</section>

</body>
</html>
'''


def main():
    css_text = CSS.read_text(encoding='utf-8')
    page = (PAGE
            .replace('__FACES__', inlined_faces(css_text))
            .replace('__ROOT__', root_tokens(css_text))
            .replace('__TOTALS__', totals())
            .replace('__LOG__', log_rows())
            .replace('__FUNNEL__', funnel())
            .replace('__CLOCK__', '19:05'))
    OUT.write_text(page, encoding='utf-8')
    print(f'wrote {OUT}  ({len(page.encode("utf-8")) / 1024:.0f} KB, self-contained)')


if __name__ == '__main__':
    main()
