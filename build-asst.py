#!/usr/bin/env python3
"""
Builds asst-concept.html — a standalone study of the «ИИ-ассистент» section,
rebuilt LIGHT.

Same rules as the other studies: everything inlined, opens with no server, out of
website/ because that directory is public, fonts and :root lifted from base.css.

WHY LIGHT. The band is currently --night, and by now DAY ends on night and CAPS
is a full night section — three dark fields in a row, with the paper world only
resuming afterwards. Light here is also the honest reading of the section: the
night surfaces on this site mean "the product showing through the poster", and
this section is not a product screen. It is a claim about what the product may
and may not read.

THE IDEA. What separates this from any chat box is not that it answers — it is
WHAT IT IS ALLOWED TO READ. So the section is built around provenance:

  1. THE READ COMES BEFORE THE ANSWER. The live page prints question, answer,
     then a footnote saying which data was touched. That is the order a citation
     appears in, not the order the thing works in — and it makes the grounding an
     afterthought. Here the tool call sits BETWEEN the question and the answer,
     where it actually happens, so "ответ по вашим данным" is something you watch
     rather than something you are promised.

  2. THE SOURCES ARE OBJECTS. «контакты, сделки» stops being a comma-separated
     tail and becomes two chips that light as they are read.

  3. THE THREE GUARANTEES ARE THE RULES OF THAT READING, so they sit under the
     exchange as a numbered colophon rather than floating beside it as a tick
     list — every one of them is a limit, and limits belong under the thing they
     limit.
"""
import base64
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent
CSS = ROOT / 'website' / 'css' / 'base.css'
FONTS = ROOT / 'website' / 'fonts'
OUT = ROOT / 'asst-concept.html'


def inlined_faces(css_text: str) -> str:
    blocks = re.findall(r'@font-face\s*\{[^}]*\}', css_text)
    if not blocks:
        raise SystemExit('no @font-face blocks in base.css')

    def swap(m):
        data = (FONTS / m.group(1)).read_bytes()
        return ("url(data:font/woff2;base64,"
                + base64.b64encode(data).decode('ascii') + ") format('woff2')")

    out = []
    for b in blocks:
        if not any(f in b for f in ('Exo 2', 'Zen Old Mincho', 'JetBrains Mono')):
            continue
        if 'weight: 500' in b:
            continue
        out.append(re.sub(r"url\('/fonts/([^']+)'\)\s*format\('woff2'\)", swap, b))
    return '\n'.join(out)


def root_tokens(css_text: str) -> str:
    m = re.search(r':root\s*\{.*?\n\}', css_text, re.S)
    if not m:
        raise SystemExit('no :root block in base.css')
    return m.group(0)


# ── verbatim from website/index.html ─────────────────────────────────────────
QUESTION = 'С кем из клиентов давно не связывались?'
ANSWER = ('Четыре контакта без активности больше 30 дней. '
          'У двух из них открытые сделки на этапе «Переговоры».')
TOOL = 'Обращения к данным CRM'
SOURCES = ['контакты', 'сделки']          # the existing tail, split into objects
# Read off the answer itself — "Четыре контакта", "у двух из них", "больше 30
# дней". Not a new claim; the same sentence, counted.
STATS = [('4', 'контакта'), ('2', 'сделки'), ('30+', 'дней')]
# Rule 01 names four domains and one exclusion. The rail renders that list as
# objects and lights the two this answer actually used — so "может читать" and
# "прочитал" are visibly different things.
SCOPE = [('контакты', True), ('сделки', True), ('задачи', False), ('календарь', False)]
RULES = [
    'Читает ваши контакты, сделки, задачи и календарь, а не интернет.',
    'Права ровно ваши. Ассистент не покажет и не изменит того, что вам не разрешено.',
    'Российский провайдер. Телефоны и email клиентов в модель не передаются.',
]


def chips():
    return '\n'.join(
        f'            <li style="--n:{i}">{s}</li>' for i, s in enumerate(SOURCES))


def scope():
    return '\n'.join(
        f'''          <li{' class="is-on"' if on else ''}><i></i>{w}</li>'''
        for w, on in SCOPE)


def stats():
    return '\n'.join(
        f'        <li><b>{n}</b><span>{w}</span></li>' for n, w in STATS)


# Each limit gets its own small drawn mark, so the three read as components
# rather than paragraphs. Abstract and aria-hidden — they restate the sentence
# beside them and must not be read out twice.
FIGURES = [
    # 01 — the four domains it may read, and the one it may not
    '<span class="asst-fig is-scope"><i></i><i></i><i></i><i></i><b></b></span>',
    # 02 — two bars of exactly equal length: «права ровно ваши»
    '<span class="asst-fig is-rights"><i></i><i></i></span>',
    # 03 — you and the provider, with what never travels struck off
    '<span class="asst-fig is-host"><i></i><u></u><i></i></span>',
]


def rules():
    return '\n'.join(
        f'''        <li style="--n:{i}">
          <div class="asst-rule-top">
            <p class="asst-rule-n" aria-hidden="true">0{i + 1}</p>
            {FIGURES[i]}
          </div>
          <p>{t}</p>
        </li>''' for i, t in enumerate(RULES))


PAGE = '''<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>4КУБ — ИИ-ассистент</title>
<style>
__FACES__

__ROOT__

/* ══════════════════════════════════════════════════════════════════════════
   ИИ-АССИСТЕНТ — light.

   Was a --night band. On this site night means "the product showing through the
   poster" (.asst, .day-stage, the cube, the DAY close beat). This section is not
   a product screen — it is a claim about what the product may read — and with
   DAY now ending on night and CAPS a full night section, it was the third dark
   field in a row.

   The subject is provenance, so the tool call sits BETWEEN question and answer,
   where it actually happens, instead of trailing the answer as a footnote.
   ══════════════════════════════════════════════════════════════════════════ */

* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--paper); color: var(--ink); font-family: var(--font-serif);
       -webkit-font-smoothing: antialiased; }

.label {
  background: var(--night); color: var(--night-muted);
  font-family: var(--font-mono); font-size: var(--t-label); letter-spacing: 0.18em;
  text-transform: uppercase; padding: 0.85rem clamp(1.25rem, 4vw, 3rem);
  display: flex; gap: 1.4rem; align-items: baseline;
}
.label b { color: var(--night-ink); font-weight: 600; letter-spacing: 0.18em; }
.label i { font-style: normal; margin-left: auto; opacity: 0.7; text-transform: none;
           letter-spacing: 0.06em; }

/* ══ THE BAND ══════════════════════════════════════════════════════════════
   Terracotta — the CTA's ground, taken deliberately. It costs the section its
   accent: --accent is now the FLOOR, so nothing on this band can use it to
   stand out. Hierarchy here is size, weight and tracking, never opacity —
   --button-ink on --accent measures 5.23:1, but the same ink at .72 alpha drops
   to 3.38:1, and the smallest labels are exactly the text that cannot afford
   that. So everything on the band is full-strength ink, and the accent survives
   only INSIDE the rice card, where it is a figure again.
   ═══════════════════════════════════════════════════════════════════════════ */
.asst {
  position: relative;
  padding-block: clamp(4.5rem, 9vw, 8rem);
  background: var(--accent);
  color: var(--button-ink);
  overflow: clip;
  isolation: isolate;
  --on-line: rgba(36, 23, 15, 0.26);
}
.asst-veil {
  position: absolute;
  left: 50%; bottom: -55%;
  translate: -50% 0;
  width: min(120vw, 900px);
  aspect-ratio: 1;
  z-index: -1;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(251, 246, 238, 0.30), transparent 68%);
}
@media (prefers-reduced-motion: no-preference) {
  .asst-veil { animation: asst-breathe 11s ease-in-out infinite; }
}
@keyframes asst-breathe {
  0%, 100% { opacity: 0.72; transform: scale(0.94); }
  50%      { opacity: 1;    transform: scale(1.06); }
}
.asst .shell { position: relative; z-index: 1; }
.asst .eyebrow, .asst .lede, .asst .asst-rule-n,
.asst .asst-rules p:last-child { color: var(--button-ink); }
.asst .lede { opacity: 1; }
.shell { width: 100%; max-width: var(--shell); margin-inline: auto;
         padding-inline: clamp(1.25rem, 4vw, 3rem); }
.eyebrow { font-family: var(--font-mono); font-size: var(--t-label); letter-spacing: 0.18em;
           text-transform: uppercase; font-weight: 600; color: var(--accent-ink); margin: 0 0 1.4rem; }
.h2 { font-family: var(--font-display); font-size: var(--t-h2); line-height: 1.06;
      letter-spacing: 0.005em; text-transform: uppercase; font-weight: 250; margin: 0;
      text-wrap: balance; }
.lede { font-family: var(--font-serif); font-size: clamp(1.02rem, 0.98rem + 0.3vw, 1.2rem);
        line-height: 1.75; color: var(--ink-soft); max-width: 54ch; margin: 1.3rem 0 0; }
.asst-head { max-width: 56rem; }

/* ── the top: the claim, and the thing doing it ──────────────────────────── */
/* The copy holds the left and the card the right, so the section reads as a
   statement answered by a demonstration rather than a heading with an exhibit
   underneath it. */
.asst-top { display: grid; gap: clamp(2rem, 4vw, 3.4rem); align-items: center; }
@media (min-width: 1080px) {
  .asst-top { grid-template-columns: minmax(0, 0.82fr) minmax(0, 1.18fr); }
}
.asst-head { max-width: 34rem; }

/* ── the stage ───────────────────────────────────────────────────────────── */
/* Asymmetric on purpose: a narrow rail of what the assistant MAY read, against
   the wide card of what it did. Stacked, the rail would read as a caption to the
   card; beside it, the two are a comparison. */
.asst-stage { margin-top: clamp(2.4rem, 5vw, 3.6rem); display: grid; gap: clamp(1.4rem, 3vw, 2.2rem); }
@media (min-width: 1100px) {
  .asst-stage { grid-template-columns: 15rem minmax(0, 1fr); align-items: start; }
}

/* A strip now, not a rail: full width under the exchange, so the four domains
   read as one row of things rather than a column of options. */
.asst-scope {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.8rem 1.5rem;
  margin-top: clamp(1.8rem, 3.5vw, 2.6rem);
  padding-top: 1.2rem;
  border-top: 1px solid var(--on-line);
}
.asst-scope-h {
  margin: 0;
  font-family: var(--font-mono); font-size: var(--t-label); font-weight: 600;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--button-ink);
}
.asst-scope ul { list-style: none; margin: 0; padding: 0;
                 display: flex; flex-wrap: wrap; gap: 0.5rem; }
.asst-scope li {
  display: flex; align-items: center; gap: 0.5rem;
  border: 1px solid var(--on-line); border-radius: var(--radius);
  padding: 0.3rem 0.6rem;
  font-family: var(--font-mono); font-size: 0.72rem; letter-spacing: 0.06em;
  color: var(--button-ink);
}
.asst-scope li i {
  width: 8px; height: 8px; border-radius: 2px; flex: none;
  border: 1px solid var(--on-line);
}
/* lit = read for THIS answer; outlined = in scope, not needed. On terracotta
   the "lit" state cannot be accent — it is rice, the card's own colour. */
.asst-scope li.is-on { background: rgba(251, 246, 238, 0.5); border-color: transparent; }
.asst-scope li.is-on i { background: var(--button-ink); border-color: var(--button-ink); }
.asst-scope-no {
  display: flex; align-items: center; gap: 0.5rem;
  margin: 0 0 0 auto;
  font-family: var(--font-mono); font-size: 0.72rem; letter-spacing: 0.06em;
  color: var(--button-ink); text-decoration: line-through;
  text-decoration-color: var(--button-ink); text-decoration-thickness: 1px;
}
.asst-scope-no i {
  width: 8px; height: 8px; border-radius: 2px; flex: none;
  border: 1px dashed var(--on-line);
}

/* ── the exchange ────────────────────────────────────────────────────────── */
/* Rice lifts it off the paper without becoming a second colour. A conversation
   wants a reading measure, so it is held at 52rem and set left rather than
   stretched across the shell. */
.asst-ex {
  /* ONE clock for everything inside. Each part used to run on its own view()
     timeline, which measures that element's own entry — and entry for a 5px row
     of dots is a 5px window of scroll, so the working state flashed past
     invisibly. Naming a timeline on the card makes every stage inside share the
     card's entry, so the ranges below are a real sequence instead of six
     unrelated ones. */
  view-timeline-name: --asst-card;
  view-timeline-axis: block;
  background-color: var(--rice);
  /* A fibre in the stock. Painted as a background-image it sits under the text,
     and multiply against rice only ever darkens — so it cannot cost contrast. */
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='p'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23p)' opacity='0.055'/%3E%3C/svg%3E");
  background-blend-mode: multiply;
  border: 1px solid rgba(36, 23, 15, 0.14);
  border-radius: var(--radius-lg);
  padding: clamp(1.5rem, 3vw, 2.4rem);
  /* It is an object ON the band now, not a panel in a page. */
  box-shadow: 0 30px 60px -34px rgba(36, 23, 15, 0.55);
}

/* The question carries the section's whole promise — "своими словами" — so it is
   set in the display face at reading size, not in a chat bubble. */
.asst-q {
  margin: 0;
  font-family: var(--font-display);
  font-weight: 250;
  font-size: clamp(1.3rem, 1.05rem + 1.05vw, 1.95rem);
  line-height: 1.28;
  letter-spacing: 0.005em;
  color: var(--ink);
  text-wrap: balance;
}

/* The card names itself and admits what it is. «пример» is the same disclosure
   the old role="img" label carried, made visible instead of only spoken. */
.asst-ex-head {
  display: flex; align-items: center; gap: 0.7rem;
  padding-bottom: 0.95rem; margin-bottom: clamp(1rem, 2vw, 1.4rem);
  border-bottom: 1px solid var(--line);
  font-family: var(--font-mono); font-size: var(--t-label);
  letter-spacing: 0.18em; text-transform: uppercase;
}
.asst-ex-head b { font-weight: 600; color: var(--ink); letter-spacing: 0.18em; }
.asst-mark {
  width: 13px; height: 13px; flex: none; border-radius: 2px;
  border: 1px solid var(--accent); position: relative;
}
.asst-mark::after {
  content: ''; position: absolute; inset: 3px; border-radius: 1px; background: var(--accent);
}
.asst-tag {
  margin-left: auto; color: var(--ash);
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: 0.2rem 0.45rem; letter-spacing: 0.14em;
}

/* The spine. Question, read, answer are one thread, so a line runs down them
   and each stage sits on it as a node — the accent stretch beside the answer is
   the same line, lit for its own segment. */
.asst-thread { position: relative; padding-left: 1.35rem; border-left: 1px solid var(--line); }
/* The spine fills as the sequence runs — one meter for the whole exchange,
   replacing the separate bar the answer used to carry. Two accent rules on the
   same axis is one rule too many. */
.asst-thread::after {
  content: '';
  position: absolute; left: -1px; top: 0; bottom: 0; width: 2px;
  background: var(--accent); border-radius: 1px;
  transform: scaleY(0); transform-origin: top;
}
.asst-read::before, .asst-a::after {
  content: ''; position: absolute; left: calc(-1.35rem - 4px);
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent);
}
.asst-read::before { top: 1.35rem; }
.asst-a::after { top: 0.5em; }

/* ── the ask surface ─────────────────────────────────────────────────────── */
/* A drawn field, never a real input: a focusable box that does nothing is worse
   than no box. Paper inset into the rice card so it reads as the place you
   type, with the accent rule under it standing in for focus. */
.asst-field {
  display: flex; align-items: flex-start; gap: 1rem;
  background: var(--paper);
  border: 1px solid var(--line);
  border-bottom-color: var(--accent);
  border-radius: var(--radius);
  padding: clamp(0.9rem, 1.8vw, 1.25rem) clamp(1rem, 2vw, 1.35rem);
}
.asst-key {
  flex: none; align-self: center;
  font-family: var(--font-mono); font-size: 0.78rem; line-height: 1;
  color: var(--ash);
  border: 1px solid var(--line-strong); border-bottom-width: 2px;
  border-radius: var(--radius);
  padding: 0.34rem 0.5rem;
  background: var(--rice);
}

/* The read. Between the question and the answer because that is when it
   happens — the live page has it trailing the answer like a citation.

   A <div>, not a <p>: it carries the source chips as a <ul>, and a <ul> inside a
   <p> is not nesting the parser honours — it closes the paragraph, hoists the
   list out as a sibling and leaves an empty <p> behind, which is exactly what
   the first build did. */
.asst-read {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem 0.75rem;
  margin: 0 0 clamp(1.1rem, 2.4vw, 1.5rem);
  padding: 0 0 0.85rem;
  border-bottom: 1px solid var(--line);
  font-family: var(--font-mono); font-size: var(--t-label);
  letter-spacing: 0.14em; text-transform: uppercase; color: var(--ash);
}
.asst-read svg { width: 14px; height: 14px; flex: none; color: var(--accent-ink); }
.asst-src { list-style: none; display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0; padding: 0; }
.asst-src li {
  border: 1px solid var(--accent);
  background: var(--accent-wash);
  color: var(--accent-ink);
  border-radius: var(--radius);
  padding: 0.2rem 0.5rem;
  letter-spacing: 0.12em;
}

/* Working. Present only between the read and the answer — it is a state, so it
   leaves when the state does. */
.asst-dots { display: inline-flex; gap: 0.28rem; align-items: center; margin-left: 0.1rem; }
.asst-dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); opacity: 0.35; }
@media (prefers-reduced-motion: no-preference) {
  .asst-dots i { animation: asst-blip 1s ease-in-out infinite; }
  .asst-dots i:nth-child(2) { animation-delay: 0.14s; }
  .asst-dots i:nth-child(3) { animation-delay: 0.28s; }
}
@keyframes asst-blip { 0%, 100% { opacity: 0.25; } 45% { opacity: 1; } }

.asst-a {
  margin: 0;
  font-family: var(--font-serif);
  font-size: clamp(1.02rem, 0.98rem + 0.3vw, 1.16rem);
  line-height: 1.78;
  color: var(--ink);
  max-width: 54ch;
}

/* The answer, counted. Same instrument as the DAY close beat and the clocks —
   Exo 2 200, terracotta, tabular — so a figure means the same thing everywhere
   on this site. */
.asst-stats {
  list-style: none; margin: 1.5rem 0 0; padding: 1.1rem 0 0;
  border-top: 1px solid var(--line);
  display: flex; flex-wrap: wrap; gap: 1.2rem 2.4rem;
}
.asst-stats li { display: flex; align-items: baseline; gap: 0.45rem; }
.asst-stats b {
  font-family: var(--font-display); font-weight: 200; font-size: 1.9rem; line-height: 1;
  letter-spacing: 0.01em; font-variant-numeric: tabular-nums; color: var(--accent-ink);
}
.asst-stats span {
  font-family: var(--font-mono); font-size: var(--t-label); letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--ash);
}

/* ── the rules of the reading ────────────────────────────────────────────── */
/* Under the exchange, not beside it: every one of the three is a LIMIT on what
   was just demonstrated, and a limit belongs under the thing it limits. */
.asst-rules {
  list-style: none; margin: clamp(2.4rem, 5vw, 3.6rem) 0 0; padding: 0;
  display: grid; gap: 1.8rem;
}
@media (min-width: 860px) {
  .asst-rules { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: clamp(1.6rem, 3vw, 2.8rem); }
}
.asst-rules li { border-top: 1px solid var(--line); padding-top: 1rem; }
.asst-rule-top { display: flex; align-items: center; justify-content: space-between;
                 gap: 1rem; margin-bottom: 0.65rem; }
/* Three small drawn marks. Abstract on purpose — a literal lock or flag would
   be a second, worse version of the sentence next to it. */
.asst-fig { display: inline-flex; align-items: center; gap: 3px; flex: none; }
.asst-fig i, .asst-fig b { display: block; }
.asst-fig.is-scope i { width: 7px; height: 7px; border-radius: 1px; background: var(--button-ink); }
.asst-fig.is-scope b {
  position: relative; width: 7px; height: 7px; border-radius: 1px;
  border: 1px solid var(--on-line); margin-left: 4px;
}
.asst-fig.is-scope b::before, .asst-fig.is-scope b::after {
  content: ''; position: absolute; inset: 50% -2px auto -2px; height: 1px;
  background: var(--button-ink);
}
.asst-fig.is-scope b::before { transform: rotate(45deg); }
.asst-fig.is-scope b::after  { transform: rotate(-45deg); }
/* equal length, which IS the point of «права ровно ваши» */
.asst-fig.is-rights { flex-direction: column; align-items: flex-end; gap: 4px; }
.asst-fig.is-rights i { width: 30px; height: 3px; border-radius: 2px; background: var(--on-line); }
.asst-fig.is-rights i:last-child { background: var(--button-ink); }
.asst-fig.is-host i { width: 8px; height: 8px; border-radius: 50%; background: var(--button-ink); }
.asst-fig.is-host i:last-child { background: transparent; border: 1px solid var(--button-ink); }
.asst-fig.is-host u { width: 16px; height: 1px; background: var(--on-line); text-decoration: none; }

.asst-rule-n {
  margin: 0 0 0;
  font-family: var(--font-mono); font-size: var(--t-label); font-weight: 600;
  letter-spacing: 0.18em; color: var(--accent-ink);
}
.asst-rules p:last-child {
  margin: 0; color: var(--ink-soft); font-size: 0.99rem; line-height: 1.75; max-width: 34ch;
}

/* ── the section, alive ──────────────────────────────────────────────────
   Every moving part below dramatises the section's own sequence — a question
   typed in plain words, the data being read, then the answer — rather than
   decorating it. All of it is scroll-driven and gated, so the base layer is the
   finished composition and nothing here is required to read the section.

   THE CARET. The one thing on a clock rather than on scroll: the question ends
   in a live cursor, because "своими словами" means it was typed, not chosen
   from a filter. It is the only ambient motion in the section.

   THE SCAN. A hairline runs the width of the read row once, between the
   question and the answer — the moment the assistant is actually in your data.

   THE BAR. The answer is drawn top-down by a rule down its left edge, so the
   reply arrives as a reply rather than as another paragraph.

   THE RULES DRAW. The three limits underline themselves in sequence.
   ────────────────────────────────────────────────────────────────────────── */

/* base layer: everything below is already in its finished state */
.asst-q::after {
  content: '';
  display: inline-block;
  width: 2px; height: 0.92em;
  margin-left: 0.16em;
  vertical-align: -0.13em;
  background: var(--accent);
}
@media (prefers-reduced-motion: no-preference) {
  .asst-q::after { animation: asst-caret 1.15s steps(1, end) infinite; }
}
@keyframes asst-caret { 0%, 54% { opacity: 1; } 55%, 100% { opacity: 0.1; } }

/* clip, NOT hidden. `hidden` makes this a scroll container, and view() on the
   chips inside then resolves against THIS box instead of the page — where they
   are permanently fully visible, so their animation reports `finished` at scroll
   zero and the stagger never runs. Exactly the trap the CAPS pin already paid
   for. `clip` clips without creating a scrolling box. */
.asst-read { position: relative; overflow: clip; }
.asst-read::after {
  content: '';
  display: none;                       /* only exists when it can travel */
  position: absolute; bottom: 0; left: 0;
  width: 38%; height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent) 50%, transparent);
}

.asst-a { position: relative; }

.asst-rules li { border-top: 0; position: relative; }
/* Dividers between the three, so they are three columns of one table rather
   than three loose blocks. */
@media (min-width: 860px) {
  .asst-rules li + li { padding-left: clamp(1.6rem, 3vw, 2.8rem); }
  .asst-rules li + li::after {
    content: ''; position: absolute; left: 0; top: 0.2rem; bottom: 0.2rem;
    width: 1px; background: var(--on-line);
  }
}
.asst-rules li::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 1px;
  background: var(--button-ink);
  transform-origin: left;
}

@media (min-width: 900px) and (prefers-reduced-motion: no-preference) {
  @supports (animation-timeline: view()) {
    .asst-src li, .asst-a, .asst-read::after, .asst-dots, .asst-stats li,
    .asst-thread::after {
      animation-timing-function: linear;
      animation-fill-mode: both;
      animation-timeline: --asst-card;      /* the card's clock, not their own */
    }
    .asst-rules li::before {                 /* outside the card, own entry */
      animation-timing-function: linear;
      animation-fill-mode: both;
      animation-timeline: view();
    }
    .asst-src li {
      animation-name: asst-chip-in;
      animation-range: entry calc(34% + var(--n) * 9%) entry calc(52% + var(--n) * 9%);
    }
    .asst-read::after {
      display: block;
      animation-name: asst-scan;
      animation-range: entry 30% entry 80%;
    }
    .asst-a { animation-name: asst-in; animation-range: entry 64% entry 88%; }
    .asst-dots { animation-name: asst-working; animation-range: entry 28% entry 76%; }
    .asst-stats li { animation-name: asst-in; animation-range: entry 78% entry 98%; }
    .asst-thread::after { animation-name: asst-bar; animation-range: entry 26% entry 88%; }
    .asst-rules li::before {
      animation-name: asst-draw;
      animation-range: entry calc(14% + var(--n) * 6%) entry calc(46% + var(--n) * 6%);
    }
  }
}
@keyframes asst-in   { from { opacity: 0; transform: translateY(6px); }
                       to   { opacity: 1; transform: none; } }
@keyframes asst-chip-in { from { opacity: 0; transform: translateY(4px) scale(0.92); }
                          to   { opacity: 1; transform: none; } }
@keyframes asst-bar  { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes asst-draw { from { transform: scaleX(0); } to { transform: scaleX(1); } }
/* the working state exists only while it is working */
@keyframes asst-working { 0% { opacity: 0; } 14%, 68% { opacity: 1; } 100% { opacity: 0; } }
@keyframes asst-scan {
  0%        { transform: translateX(-105%); opacity: 0; }
  12%, 84%  { opacity: 0.95; }
  100%      { transform: translateX(300%); opacity: 0; }
}

/* Study furniture only: the section is mid-page on the real site, so it needs
   room to ENTER — without it the view() entry phase is already complete before
   the first scroll and every arrival reads as "already there". */
.pad { height: 100vh; display: grid; place-items: center;
       font-family: var(--font-mono); font-size: var(--t-label); letter-spacing: 0.18em;
       text-transform: uppercase; color: var(--line-strong); }

.visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
</style>
</head>
<body>

<div class="label"><b>A</b> Ассистент на бумаге <i>сначала читает, потом отвечает · источники — объекты, а не хвост строки</i></div>

<div class="pad">прокрутите вниз</div>

<section class="asst">
  <!-- The CTA's own second sun, so the two terracotta bands are the same
       object seen twice rather than one colour used twice. -->
  <div class="asst-veil" aria-hidden="true"></div>
  <div class="shell">
    <div class="asst-top">
      <div class="asst-head">
        <p class="eyebrow">ИИ-ассистент</p>
        <h2 class="h2">Спросите своими словами</h2>
        <p class="lede">Вместо фильтров и отчётов: вопрос обычным языком, ответ по вашим данным.</p>
      </div>

      <div class="asst-ex">
        <div class="asst-ex-head">
          <span class="asst-mark" aria-hidden="true"></span>
          <b>ИИ-ассистент</b>
          <span class="asst-tag">пример</span>
        </div>

        <p class="visually-hidden">Пример диалога.</p>

        <div class="asst-field">
          <p class="asst-q">__QUESTION__</p>
          <span class="asst-key" aria-hidden="true">⏎</span>
        </div>
        <div class="asst-thread">
        <div class="asst-read">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        __TOOL__
        <ul class="asst-src">
__CHIPS__
        </ul>
        <span class="asst-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      </div>

      <p class="asst-a">__ANSWER__</p>

        </div>

        <ul class="asst-stats" aria-hidden="true">
__STATS__
        </ul>
      </div>
    </div>

    <!-- Scope, full width under the exchange: what it MAY read, with the two it
         actually used lit. Hidden from AT — rule 01 says it in a sentence. -->
    <aside class="asst-scope" aria-hidden="true">
      <p class="asst-scope-h">Читает</p>
      <ul>
__SCOPE__
      </ul>
      <p class="asst-scope-no"><i></i>не интернет</p>
    </aside>

    <ul class="asst-rules">
__RULES__
    </ul>
  </div>
</section>

<div class="pad"></div>

</body>
</html>
'''


def main():
    css_text = CSS.read_text(encoding='utf-8')
    page = (PAGE
            .replace('__FACES__', inlined_faces(css_text))
            .replace('__ROOT__', root_tokens(css_text))
            .replace('__QUESTION__', QUESTION)
            .replace('__ANSWER__', ANSWER)
            .replace('__TOOL__', TOOL)
            .replace('__CHIPS__', chips())
            .replace('__SCOPE__', scope())
            .replace('__STATS__', stats())
            .replace('__RULES__', rules()))
    OUT.write_text(page, encoding='utf-8')
    print(f'wrote {OUT}  ({len(page.encode("utf-8")) / 1024:.0f} KB, self-contained)')


if __name__ == '__main__':
    main()
