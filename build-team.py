#!/usr/bin/env python3
"""
Builds team-concept.html — a standalone study of the «Команда и доступ» section.

Same rules as the other studies: everything inlined, opens with no server, and
the output stays OUT of website/ because that directory is public. Fonts and the
:root block are lifted from website/css/base.css at build time so the study
cannot drift from the real site.

THE PROBLEM THIS SOLVES. The section's own lede promises two settings — "Роль
решает, что человек может делать. Структура команды решает, чьи данные он
видит. Это две разные настройки, и они не мешают друг другу." The live page
draws exactly one of them: an 8x5 permissions table. The second setting is
asserted and never shown, so the sentence has to be taken on faith.

So the section becomes the sentence: two panels, labelled as the two settings,
side by side. And the proof that they do not interfere is structural — walking
the roles lights rows in the LEFT panel and visibly does nothing to the right
one.

NOT PINNED, deliberately. CAPS owns the pinned scroll moment now; a second one
two sections later would read as a tic, and a permissions matrix wants to be
read rather than driven. The mechanism here is arrival, not theatre.
"""
import base64
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent
CSS = ROOT / 'website' / 'css' / 'base.css'
FONTS = ROOT / 'website' / 'fonts'
OUT = ROOT / 'team-concept.html'


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


# ── verbatim from website/index.html. Nothing here is invented, including the
#    two <small> notes, which are the only per-role commentary that exists.
COLS = ['Контакты', 'Сделки', 'Деньги', 'Команда']
ROLES = [
    ('Владелец',          None,                        ['полный', 'полный', 'да',  'да']),
    ('Администратор',     None,                        ['полный', 'полный', 'да',  'да']),
    ('Руководитель отдела', 'плюс данные подчинённых',  ['полный', 'полный', 'да',  'нет']),
    ('Менеджер',          None,                        ['полный', 'полный', 'да',  'нет']),
    ('Бухгалтер',         'ничего не меняет',          ['чтение', 'чтение', 'да',  'нет']),
    ('Маркетолог',        None,                        ['полный', 'чтение', 'да',  'нет']),
    ('Поддержка',         None,                        ['полный', 'нет',    'нет', 'нет']),
    ('Только просмотр',   None,                        ['чтение', 'чтение', 'нет', 'нет']),
]
# Four values, four weights. The pip carries the level at a glance; the word
# stays because a pip alone is not a reading of anything.
LEVEL = {'полный': 'full', 'да': 'full', 'чтение': 'half', 'нет': 'none'}

FOOT = ('Сотрудник входит по коду компании: вы добавляете человека '
        'и выдаёте роль, пароль он придумывает сам.')


def rows():
    out = []
    for i, (role, note, cells) in enumerate(ROLES):
        tds = ''.join(
            f'<td class="lv lv-{LEVEL[c]}"><i></i><span>{c}</span></td>' for c in cells)
        small = f'<small>{note}</small>' if note else ''
        out.append(
            f'            <tr style="--n:{i}"><th scope="row">{role}{small}</th>{tds}</tr>')
    return '\n'.join(out)


def head_cells():
    return ''.join(f'<th scope="col">{c}</th>' for c in COLS)


PAGE = '''<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>4КУБ — Команда и доступ</title>
<style>
__FACES__

__ROOT__

/* ══════════════════════════════════════════════════════════════════════════
   КОМАНДА И ДОСТУП — the section becomes its own sentence.

   Two settings are promised in the lede and one is drawn. Here both are, side
   by side and labelled, so "две разные настройки" is something you can see
   rather than something you are told.

   PAPER GROUND, NIGHT INSTRUMENTS. The section stays on paper — DAY now ends on
   night and CAPS is night, and a third dark field in a row would finish the
   paper world off. But an access matrix and an org tree ARE product screens, and
   base.css is explicit that anything which must feel like the product uses
   --night. So the ground is the poster and the two panels are the tool.

   NOT PINNED. The cube owns that move now. A matrix wants to be read.
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

.team { padding-block: clamp(4.5rem, 9vw, 8rem); }
.shell { width: 100%; max-width: var(--shell); margin-inline: auto;
         padding-inline: clamp(1.25rem, 4vw, 3rem); }
.eyebrow { font-family: var(--font-mono); font-size: var(--t-label); letter-spacing: 0.18em;
           text-transform: uppercase; font-weight: 600; color: var(--accent-ink); margin: 0 0 1.4rem; }
.h2 { font-family: var(--font-display); font-size: var(--t-h2); line-height: 1.06;
      letter-spacing: 0.005em; text-transform: uppercase; font-weight: 250; margin: 0;
      text-wrap: balance; }
.lede { font-family: var(--font-serif); font-size: clamp(1.02rem, 0.98rem + 0.3vw, 1.2rem);
        line-height: 1.75; color: var(--ink-soft); max-width: 56ch; margin: 1.3rem 0 0; }
.team-head { max-width: 56rem; }

/* ── the two settings ────────────────────────────────────────────────────── */
.two { display: grid; gap: clamp(1.6rem, 3vw, 2.4rem); margin-top: clamp(2.6rem, 5vw, 4rem); }
@media (min-width: 1040px) {
  /* The matrix needs the width; the tree is a diagram and does not. But they
     stay the same HEIGHT: top-aligned, the tree panel ended a third of the way
     down and left an L of empty paper, which reads as the second setting being
     the lesser one — the exact opposite of "две разные настройки". */
  .two { grid-template-columns: minmax(0, 1.62fr) minmax(0, 1fr); align-items: stretch; }
}

.panel {
  --night-line-soft: rgba(239, 230, 216, 0.09);
  background: var(--night);
  border: 1px solid rgba(36, 29, 22, 0.18);
  border-radius: var(--radius-lg);
  color: var(--night-ink);
  padding: clamp(1.1rem, 2.2vw, 1.7rem);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.5), 0 26px 60px -40px rgba(36, 29, 22, 0.75);
  overflow: hidden;
}
.panel-head {
  display: flex; align-items: baseline; gap: 0.8rem;
  padding-bottom: 0.85rem; margin-bottom: 1rem;
  border-bottom: 1px solid var(--night-line);
}
/* On night the accent must be --accent-lift; --accent is a FILL and measures
   1.8:1 here. Same rule the cube and the DAY close beat keep. */
.panel-head b { font-family: var(--font-mono); font-size: var(--t-label); font-weight: 600;
                letter-spacing: 0.2em; text-transform: uppercase; color: var(--accent-lift); }
.panel-head span { margin-left: auto; font-family: var(--font-mono); font-size: 0.6rem;
                   letter-spacing: 0.14em; text-transform: uppercase;
                   color: var(--night-muted); text-align: right; }

/* ── setting one: the matrix ─────────────────────────────────────────────── */
/* A real <table>. The grid IS the content — an access matrix rendered as
   anything else stops being checkable, and stops being readable by AT. */
.grid { width: 100%; border-collapse: collapse; font-family: var(--font-mono); }
.grid caption { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden;
                clip-path: inset(50%); white-space: nowrap; }
.grid thead th {
  font-size: 0.56rem; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--night-muted); text-align: left;
  padding: 0 0 0.7rem; border-bottom: 1px solid var(--night-line-soft);
}
.grid thead th:first-child { width: 34%; }
.grid tbody th {
  text-align: left; font-weight: 400; font-size: 0.76rem; letter-spacing: 0.01em;
  color: var(--night-ink); padding: 0.62rem 0.9rem 0.62rem 0; vertical-align: top;
}
.grid tbody th small {
  display: block; font-size: 0.58rem; letter-spacing: 0.04em; margin-top: 0.18rem;
  color: var(--night-muted);
}
.grid tbody tr + tr th, .grid tbody tr + tr td { border-top: 1px solid var(--night-line-soft); }
.grid td { padding: 0.62rem 0.5rem 0.62rem 0; vertical-align: top; }

/* The pip carries the level at a glance, the word keeps it a reading.

   Every dim tone in this panel is --night-muted rather than an ad-hoc alpha.
   The cube's faces get away with rgba(...,.38-.44) because they are decoration,
   aria-hidden, and repeat copy that is written out beside them. Here the same
   values would be sitting on the actual content — the role notes, the «нет»
   cells, the tree labels — and they measure 3.1-3.8:1 at 9-10px, under the 4.5
   floor. Legibility beats hierarchy in an access matrix: you have to be able to
   read «нет». The full/none distinction is carried by the pip and by
   --night-ink on the full ones instead. */
.lv { font-size: 0.62rem; letter-spacing: 0.06em; color: var(--night-muted); }
.lv i {
  display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 0.42rem;
  vertical-align: baseline; border: 1px solid rgba(239, 230, 216, 0.3);
}
.lv-full i { background: var(--accent); border-color: var(--accent);
             box-shadow: 0 0 10px rgba(204, 120, 92, 0.45); }
/* half: the same square, half filled — read-only is not a lesser colour, it is
   a lesser amount */
.lv-half i { background: linear-gradient(90deg, var(--accent) 50%, transparent 50%);
             border-color: rgba(204, 120, 92, 0.55); }
.lv-none i { background: transparent; }
.lv-full span { color: var(--night-ink); }
.lv-none span { color: var(--night-muted); }

/* ── setting two: the structure ──────────────────────────────────────────── */
/* The half the live page never draws. Three levels is all the copy supports —
   Владелец, Руководитель отдела, and the Менеджеры under it, which is exactly
   what "плюс данные подчинённых" refers to. Nothing is invented beyond that. */
/* The panel is a column so the diagram can sit in the middle of the height the
   matrix sets, rather than clinging to the top of it. */
.panel-structure { display: flex; flex-direction: column; }
.panel-structure .tree { margin-block: auto; }
.tree { display: grid; gap: 0.5rem; }
.node {
  display: flex; align-items: center; gap: 0.6rem;
  border: 1px solid var(--night-line); border-radius: var(--radius);
  padding: 0.6rem 0.7rem;
  font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.02em;
  background: rgba(239, 230, 216, 0.03);
}
.node i { width: 7px; height: 7px; border-radius: 50%; flex: none;
          background: rgba(239, 230, 216, 0.34); }
.node em { font-style: normal; margin-left: auto; font-size: 0.56rem; letter-spacing: 0.13em;
           text-transform: uppercase; color: var(--night-muted); }
.lvl-2 { margin-left: 1.5rem; }
.lvl-3 { margin-left: 3rem; }

/* The lit set: the head of department and everything under it. The band is the
   answer to "чьи данные он видит" — drawn, not claimed. */
.tree .is-seen { border-color: rgba(204, 120, 92, 0.45); background: rgba(204, 120, 92, 0.10); }
.tree .is-seen i { background: var(--accent); box-shadow: 0 0 10px rgba(204, 120, 92, 0.6); }
.tree .is-seen em { color: var(--accent-lift); }
.tree-note {
  margin: 1rem 0 0; font-family: var(--font-mono); font-size: 0.58rem; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--night-muted);
  display: flex; align-items: center; gap: 0.6rem;
}
.tree-note::before { content: ''; width: 9px; height: 9px; border-radius: 2px; flex: none;
                     background: var(--accent); box-shadow: 0 0 10px rgba(204, 120, 92, 0.5); }

.team-foot {
  margin: clamp(1.8rem, 3.5vw, 2.6rem) 0 0;
  padding-top: 1.3rem; border-top: 1px solid var(--line);
  color: var(--ink-soft); font-size: 0.99rem; line-height: 1.75; max-width: 62ch;
}

/* ── arrival ─────────────────────────────────────────────────────────────── */
/* Rows land in order as the panel comes up — the matrix filling in rather than
   being dropped in whole. Enhancement only: without it every row is simply
   there, which is the base layer. */
@media (min-width: 900px) and (prefers-reduced-motion: no-preference) {
  @supports (animation-timeline: view()) {
    .grid tbody tr {
      animation: row-in linear both;
      animation-timeline: view();
      /* Finish as the panel ENTERS, not part-way through covering the screen:
         at cover 22%+n*5% the last row was still at 0.2 opacity with the whole
         section in view, so anyone stopping here read a matrix that faded out
         at the bottom. Row 8 now completes at entry 90%. */
      animation-range: entry calc(15% + var(--n) * 5%) entry calc(55% + var(--n) * 5%);
    }
  }
}
@keyframes row-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

@media (max-width: 620px) {
  .grid thead { display: none; }
  .grid tbody th { padding-bottom: 0.3rem; }
  .grid tbody tr { display: grid; grid-template-columns: 1fr 1fr; padding: 0.5rem 0; }
  .grid tbody th { grid-column: 1 / -1; }
  .grid tbody tr + tr th, .grid tbody tr + tr td { border-top: 0; }
  .grid tbody tr + tr { border-top: 1px solid var(--night-line-soft); }
  .lvl-2 { margin-left: 0.9rem; } .lvl-3 { margin-left: 1.8rem; }
}
</style>
</head>
<body>

<div class="label"><b>T</b> Две настройки <i>раздел = его собственная фраза · бумага под инструментами, ночь в них</i></div>

<section class="team">
  <div class="shell">
    <div class="team-head">
      <p class="eyebrow">Команда и доступ</p>
      <h2 class="h2">Каждый видит своё</h2>
      <p class="lede">Роль решает, что человек может делать. Структура команды решает, чьи данные он видит. Это две разные настройки, и они не мешают друг другу.</p>
    </div>

    <div class="two">
      <div class="panel">
        <div class="panel-head"><b>Роль</b><span>что человек может делать</span></div>
        <table class="grid">
          <caption>Права ролей: контакты, сделки, деньги и управление командой</caption>
          <thead><tr><th scope="col">Роль</th>__HEAD__</tr></thead>
          <tbody>
__ROWS__
          </tbody>
        </table>
      </div>

      <div class="panel panel-structure">
        <div class="panel-head"><b>Структура</b><span>чьи данные он видит</span></div>
        <div class="tree">
          <div class="node"><i></i>Владелец<em>вся компания</em></div>
          <div class="node lvl-2 is-seen"><i></i>Руководитель отдела<em>он сам</em></div>
          <div class="node lvl-3 is-seen"><i></i>Менеджер<em>подчинённый</em></div>
          <div class="node lvl-3 is-seen"><i></i>Менеджер<em>подчинённый</em></div>
        </div>
        <p class="tree-note">Руководитель видит себя и подчинённых</p>
      </div>
    </div>

    <p class="team-foot">__FOOT__</p>
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
            .replace('__HEAD__', head_cells())
            .replace('__ROWS__', rows())
            .replace('__FOOT__', FOOT))
    OUT.write_text(page, encoding='utf-8')
    print(f'wrote {OUT}  ({len(page.encode("utf-8")) / 1024:.0f} KB, self-contained)')


if __name__ == '__main__':
    main()
