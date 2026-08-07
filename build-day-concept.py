#!/usr/bin/env python3
"""Builds a standalone concept file for the DAY section.

Everything is inlined as data URIs so the result opens from the filesystem with
no server and no network. Kept out of website/ on purpose: that directory is
served publicly at 4kub.ru.
"""
import base64, pathlib

WEB = pathlib.Path(__file__).parent / 'website'
OUT = pathlib.Path(__file__).parent / 'day-concept.html'


def data_uri(rel, mime):
    raw = (WEB / rel).read_bytes()
    return 'data:%s;base64,%s' % (mime, base64.b64encode(raw).decode('ascii'))


FONTS = {
    'EXO_CYR':  data_uri('fonts/exo2-cyrillic.woff2', 'font/woff2'),
    'EXO_LAT':  data_uri('fonts/exo2-latin.woff2', 'font/woff2'),
    'ZEN_CYR':  data_uri('fonts/zenoldmincho-400-cyrillic.woff2', 'font/woff2'),
    'ZEN_LAT':  data_uri('fonts/zenoldmincho-400-latin.woff2', 'font/woff2'),
    'MONO_CYR': data_uri('fonts/jetbrainsmono-cyrillic.woff2', 'font/woff2'),
    'MONO_LAT': data_uri('fonts/jetbrainsmono-latin.woff2', 'font/woff2'),
}
IMGS = {
    'IMG_CALL':  data_uri('img/day-call.webp', 'image/webp'),
    'IMG_DEAL':  data_uri('img/day-deal.webp', 'image/webp'),
    'IMG_CLOSE': data_uri('img/day-close.webp', 'image/webp'),
}

CYR = 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116'
LAT = ('U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, '
       'U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, '
       'U+2212, U+2215, U+FEFF, U+FFFD')

HTML = r"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>4КУБ — «Один день», концепт секции</title>
<style>
/* ── fonts ─────────────────────────────────────────────────────────────── */
@font-face{font-family:'Exo 2';font-weight:200 600;font-display:swap;src:url(__EXO_CYR__) format('woff2');unicode-range:__CYR__}
@font-face{font-family:'Exo 2';font-weight:200 600;font-display:swap;src:url(__EXO_LAT__) format('woff2');unicode-range:__LAT__}
@font-face{font-family:'Zen Old Mincho';font-weight:400;font-display:swap;src:url(__ZEN_CYR__) format('woff2');unicode-range:__CYR__}
@font-face{font-family:'Zen Old Mincho';font-weight:400;font-display:swap;src:url(__ZEN_LAT__) format('woff2');unicode-range:__LAT__}
@font-face{font-family:'JetBrains Mono';font-weight:400 600;font-display:swap;src:url(__MONO_CYR__) format('woff2');unicode-range:__CYR__}
@font-face{font-family:'JetBrains Mono';font-weight:400 600;font-display:swap;src:url(__MONO_LAT__) format('woff2');unicode-range:__LAT__}

:root{
  --paper:#F4EADC; --rice:#FBF6EE;
  --ink:#241D16; --ink-soft:#4A3D30; --ash:#6E5E4C;
  --line:#CDB99D; --line-strong:#B49C7C; --hair:rgba(36,29,22,.13);
  --accent:#CC785C; --accent-ink:#974329;
  --display:'Exo 2',system-ui,sans-serif;
  --serif:'Zen Old Mincho',Georgia,serif;
  --mono:'JetBrains Mono',ui-monospace,monospace;
  --shell:1400px; --gut:clamp(1.25rem,4vw,3rem);
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--serif);
  font-size:clamp(1rem,.97rem + .16vw,1.0625rem);line-height:1.8;-webkit-font-smoothing:antialiased}

/* ── the section ───────────────────────────────────────────────────────────
   ONE DAY, read as a schedule. The light travels top to bottom — pale at
   09:40, warm at 14:15, deep at 19:05 — so the section is a single passage of
   time rather than three cards that happen to have clocks on them. */
.day{
  position:relative;
  padding-block:clamp(4.5rem,9vw,8rem);
  border-block:1px solid var(--line);
  background:linear-gradient(180deg,#F7F0E6 0%,#F3E8D8 34%,#EFDFC9 68%,#E9D4B7 100%);
  overflow:hidden;
}
.shell{width:100%;max-width:var(--shell);margin-inline:auto;padding-inline:var(--gut)}

.eyebrow{font-family:var(--mono);font-size:.6875rem;letter-spacing:.18em;
  text-transform:uppercase;font-weight:600;color:var(--accent-ink);margin:0 0 1.4rem}
.h2{font-family:var(--display);font-size:clamp(1.85rem,1.15rem + 2.7vw,3.4rem);
  line-height:1.06;letter-spacing:.005em;text-transform:uppercase;font-weight:250;margin:0;text-wrap:balance}
.lede{font-size:clamp(1.02rem,.98rem + .3vw,1.2rem);line-height:1.75;color:var(--ink-soft);
  max-width:52ch;margin:1.3rem 0 0}
.day-head{max-width:54rem}

/* ── the log ──────────────────────────────────────────────────────────────
   Full-bleed rows. The copy column re-applies the shell's left gutter so it
   stays aligned with the header, while the picture column runs off the right
   edge of the screen. Text NEVER sits on a picture — that separation is the
   whole point, and it is why nothing here needs a scrim. */
.log{list-style:none;margin:3.6rem 0 0;padding:0}
.entry{position:relative;border-top:1px solid var(--line)}
.entry:last-child{border-bottom:1px solid var(--line)}

.entry-in{
  display:grid;grid-template-columns:1fr;
  gap:1.4rem;
  padding:clamp(2rem,4vw,3.2rem) var(--gut);
  max-width:var(--shell);margin-inline:auto;
}
.entry-time{
  font-family:var(--display);font-weight:200;line-height:1;
  font-size:clamp(2.6rem,1.6rem + 3.4vw,4.6rem);
  letter-spacing:.01em;color:var(--accent-ink);margin:0;
}
.entry-body h3{
  font-family:var(--display);font-weight:400;text-transform:uppercase;
  letter-spacing:.05em;line-height:1.16;
  font-size:clamp(1.15rem,1rem + .8vw,1.6rem);margin:0 0 .7rem;
}
.entry-body p{margin:0 0 .9rem;color:var(--ink-soft);max-width:52ch;line-height:1.75}
.entry-body p:last-of-type{margin-bottom:0}

/* the drawn product fragment — a strip, never a screenshot */
.strip{display:grid;gap:.45rem;margin-top:1.5rem;max-width:26rem}
.strip-row{display:flex;align-items:center;gap:.7rem;background:var(--rice);
  border:1px solid var(--hair);border-radius:3px;padding:.62rem .78rem;
  font-family:var(--mono);font-size:.7rem;letter-spacing:.03em}
.strip-row b{font-weight:600}
.strip-row span{margin-left:auto;font-size:.66rem;color:var(--ash)}
.strip-row i{width:6px;height:6px;border-radius:50%;background:var(--accent);flex:none}
.strip-row i.q{background:var(--line-strong)}

/* the world, running as a strip down the right edge. Its inner edge dissolves
   into the paper; percentages here are of the element's own box and the mask
   reaches transparent at 0%, so there is no rectangle to see. */
.entry-art{display:none}

@media (min-width:980px){
  .entry-in{
    grid-template-columns:minmax(7rem,10rem) minmax(0,1fr);
    column-gap:clamp(1.6rem,3vw,3rem);
    padding-right:calc(38% + var(--gut));
  }
  .entry-time{text-align:right;padding-top:.15rem}
  .entry-body{position:relative;border-left:1px solid var(--line);padding-left:clamp(1.6rem,3vw,3rem)}
  /* the dot that makes the rule read as a timeline rather than a divider */
  .entry-body::before{content:'';position:absolute;left:-4.5px;top:.62em;
    width:9px;height:9px;border-radius:50%;background:var(--accent);
    box-shadow:0 0 0 4px #F3E8D8}
  .entry-art{
    display:block;position:absolute;top:0;bottom:0;right:0;width:38%;
    background-image:var(--img);background-size:cover;background-position:center;
    /* TWO masks, intersected. Horizontal dissolves the inner edge into the
       paper; vertical separates each frame from the one above and below.
       Without the vertical one the bands butt together and a car cuts straight
       into a warehouse on a hard line — they read as one torn collage rather
       than three frames of the same day. */
    -webkit-mask-image:
      linear-gradient(90deg,transparent 0%,rgba(0,0,0,.55) 22%,#000 55%),
      linear-gradient(180deg,transparent 0%,#000 14%,#000 86%,transparent 100%);
    mask-image:
      linear-gradient(90deg,transparent 0%,rgba(0,0,0,.55) 22%,#000 55%),
      linear-gradient(180deg,transparent 0%,#000 14%,#000 86%,transparent 100%);
    -webkit-mask-composite:source-in;
    mask-composite:intersect;
  }
}

/* below the breakpoint the picture becomes a band above the copy — still no
   text on top of it */
@media (max-width:979px){
  .entry-art{display:block;height:9rem;margin:0 calc(var(--gut) * -1) 1.4rem;
    background-image:var(--img);background-size:cover;background-position:center;
    -webkit-mask-image:linear-gradient(180deg,#000 55%,transparent 100%);
    mask-image:linear-gradient(180deg,#000 55%,transparent 100%);
    order:-1}
  .entry-in{padding-top:0}
}

/* closing line — the day totalled, in the same schedule voice */
.day-foot{display:flex;flex-wrap:wrap;gap:.6rem 2.6rem;margin-top:2.4rem;
  padding-top:1.5rem;border-top:1px solid var(--line);
  font-family:var(--mono);font-size:.6875rem;letter-spacing:.18em;
  text-transform:uppercase;color:var(--ash)}
.day-foot b{color:var(--ink);font-weight:600}

/* ── concept note, not part of the design ─────────────────────────────── */
.note{max-width:var(--shell);margin:0 auto;padding:2.5rem var(--gut) 3.5rem;
  font-family:var(--mono);font-size:.72rem;line-height:2;letter-spacing:.04em;color:var(--ash)}
.note b{color:var(--accent-ink)}
.note-h{font-size:.6875rem;letter-spacing:.18em;text-transform:uppercase;
  color:var(--accent-ink);font-weight:600;margin:0 0 1rem}
</style>
</head>
<body>

<section class="day">
  <div class="shell">
    <header class="day-head">
      <p class="eyebrow">Один день</p>
      <h2 class="h2">Как это выглядит в работе</h2>
      <p class="lede">Не список функций, а три момента, которые случаются каждый день у любого, кто продаёт.</p>
    </header>
  </div>

  <ol class="log">
    <li class="entry">
      <div class="entry-art" style="--img:url(__IMG_CALL__)" aria-hidden="true"></div>
      <div class="entry-in">
        <p class="entry-time">09:40</p>
        <div class="entry-body">
          <h3>Звонок в дороге</h3>
          <p>Номер незнакомый. 4КУБ показывает, кто это, о чём договаривались в прошлый раз и что вы обещали.</p>
          <p>Разговор кончился — заметка и задача уже привязаны к карточке. Пропала связь в тоннеле: запись останется на телефоне и уйдёт на сервер сама.</p>
          <div class="strip" aria-hidden="true">
            <div class="strip-row"><i></i><b>Входящий звонок</b><span>сейчас</span></div>
            <div class="strip-row"><i class="q"></i>Обещали смету<span>12 дней</span></div>
          </div>
        </div>
      </div>
    </li>

    <li class="entry">
      <div class="entry-art" style="--img:url(__IMG_DEAL__)" aria-hidden="true"></div>
      <div class="entry-in">
        <p class="entry-time">14:15</p>
        <div class="entry-body">
          <h3>Сделка сдвинулась</h3>
          <p>Перетащили карточку на следующий этап. История, задачи и сумма поехали вместе с ней, дублировать ничего не нужно.</p>
          <p>Руководитель видит движение сразу — просить «обновите статус» больше не приходится.</p>
          <div class="strip" aria-hidden="true">
            <div class="strip-row"><i class="q"></i>Новый лид<span>4</span></div>
            <div class="strip-row"><i></i><b>Переговоры</b><span>7</span></div>
            <div class="strip-row"><i class="q"></i>Счёт отправлен<span>2</span></div>
          </div>
        </div>
      </div>
    </li>

    <li class="entry">
      <div class="entry-art" style="--img:url(__IMG_CLOSE__)" aria-hidden="true"></div>
      <div class="entry-in">
        <p class="entry-time">19:05</p>
        <div class="entry-body">
          <h3>Итоги без отчётов</h3>
          <p>Сколько закрыли, что просрочено, кому не позвонили. Один экран вместо вечерней переписки с командой.</p>
          <p>Цифры собираются сами из того, что происходило за день. Завтрашние задачи уже в списке, просроченные подсвечены.</p>
          <div class="strip" aria-hidden="true">
            <div class="strip-row"><i></i><b>Закрыто за день</b><span>3</span></div>
            <div class="strip-row"><i class="q"></i>Просрочено<span>1</span></div>
          </div>
        </div>
      </div>
    </li>
  </ol>

  <div class="shell">
    <p class="day-foot">
      <span>Один день · <b>3 момента</b></span>
      <span>Ни одного отчёта</span>
      <span>Ни одной выгрузки в Excel</span>
    </p>
  </div>
</section>

<div class="note">
  <p class="note-h">Что здесь другое</p>
  <p><b>Это расписание, а не карточки.</b> Время вынесено в поле слева, вдоль записей идёт волосяная линия с точками — секция читается как один день, а не как три плитки с часами на них.</p>
  <p><b>Свет идёт сверху вниз.</b> Фон светлеет и теплеет от 09:40 к 19:05. День показан самой секцией, а не подписан.</p>
  <p><b>Текст никогда не лежит на картинке.</b> Снимки собраны в полосу вдоль правого края, их внутренний край растворяется в бумаге. Поэтому здесь не нужна ни одна затемняющая подложка — и нечему ломать читаемость.</p>
</div>

</body>
</html>
"""

out = HTML
for k, v in {**FONTS, **IMGS}.items():
    out = out.replace('__%s__' % k, v)
out = out.replace('__CYR__', CYR).replace('__LAT__', LAT)
OUT.write_text(out, encoding='utf-8')
print('wrote %s  (%.0f KB)' % (OUT, OUT.stat().st_size / 1024))
