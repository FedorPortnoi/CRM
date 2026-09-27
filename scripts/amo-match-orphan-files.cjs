// Usage: ORG_ID=<uuid> node scripts/amo-match-orphan-files.cjs <files.json> <entity-files.jsonl> <out.json>
// Read-only: propose a deal for each amo file that amo links to nothing, by name.
const fs = require('fs');
for (const l of fs.readFileSync('D:/crm/.env.localprod', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^(DATABASE_URL)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}
const { PrismaClient } = require(process.cwd() + '/node_modules/@prisma/client');
const db = new PrismaClient();
const ORG = process.env.ORG_ID; if (!ORG) throw new Error('set ORG_ID');
const [filesPath, linksPath, outPath] = process.argv.slice(2);

// Words that describe the document, not the client.
const STOP = new Set(`договор договора договору капсула капсулы капсульного капсульный капсульный старт баланс инфинити инфини лайт полный полн базовый
дизайн проект проекта приложению приложение сводный сметный расчет статье работы работа работ материал материалы ремонт ремонта ремонтa
подписан подписанный подписи подпись подписью задаток задатка предварительный просчет просчеты ведомость расходов выполненные альбом итог
визуализации визуализациями чертежи чертежей чертежная документация технический техническое задание photo scan скан сканирование docscan
document шаблон копия финал соглашение приемки приёмки согласия гарантия коллажи стилистические рабочие комплектация материалами заказчика
правок круг второй первый улица город квартира дома объединены готово готовый готовая signed скриншот снимок экрана монтаж электрики
демонтаж предварительный обрывной смета сметы расчеты расписка приходник клиента клиент новая новое новый pdf docx xlsx page
whatsapp image scanned команда агентский`.split(/\s+/));

const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е');
const words = (s) => norm(s).split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !STOP.has(w));
const stem = (w) => w.slice(0, Math.max(5, w.length - 2)); // crude Russian ending strip

(async () => {
  const files = JSON.parse(fs.readFileSync(filesPath, 'utf8'));
  const linked = new Set();
  for (const l of fs.readFileSync(linksPath, 'utf8').split('\n')) { try { for (const f of JSON.parse(l).files) linked.add(f); } catch {} }
  const orphans = files.filter((f) => !linked.has(f.uuid));

  const users = new Map((await db.amoEntityMap.findMany({ where: { organization_id: ORG, entity_type: 'user' } })).map((r) => [Number(r.amo_id), r.local_id]));
  const localUsers = await db.user.findMany({ where: { organization_id: ORG }, select: { id: true, name: true } });

  const deals = await db.deal.findMany({
    where: { organization_id: ORG },
    select: { id: true, title: true, custom_fields: true, assigned_to: true, created_at: true, contact: { select: { first_name: true, last_name: true, company: true, address: true } } },
  });
  const SKIP_CF = /utm|_ym|calltouch|phone|ID |Кампания|Объявление|Ключевое/i;
  const docs = deals.map((d) => {
    const cf = Object.entries(d.custom_fields ?? {}).filter(([k]) => !SKIP_CF.test(k)).map(([, v]) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
    const c = d.contact ?? {};
    const text = [d.title, cf, c.first_name, c.last_name, c.company, c.address && JSON.stringify(c.address)].join(' ');
    return { d, stems: new Set(words(text).map(stem)) };
  });
  const df = new Map();
  for (const x of docs) for (const s of x.stems) df.set(s, (df.get(s) ?? 0) + 1);
  const idf = (s) => Math.log(docs.length / (1 + (df.get(s) ?? 0)));

  const out = [];
  for (const f of orphans) {
    const toks = [...new Set(words(f.name).map(stem))].filter((s) => df.has(s));
    if (!toks.length) { out.push({ f, why: 'no distinctive words' }); continue; }
    const scored = [];
    for (const x of docs) {
      let s = 0, hit = 0, rare = false;
      for (const t of toks) if (x.stems.has(t)) { s += idf(t); hit++; if ((df.get(t) ?? 0) <= 5) rare = true; }
      if (hit) scored.push({ x, s, hit, rare });
    }
    scored.sort((a, b) => b.s - a.s || (b.x.d.created_at - a.x.d.created_at));
    const [a, b] = scored;
    const uploader = users.get(f.created_by?.id) ?? localUsers.find(() => false)?.id;
    // Confident: every distinctive word found, at least one rare word, and a clear winner
    // (or a tie broken by the deal belonging to the manager who uploaded the file).
    let pick = null, why = '';
    if (!a) why = 'no deal shares a word';
    else if (a.hit < toks.length) why = `partial (${a.hit}/${toks.length})`;
    else if (!a.rare) why = 'only common words';
    else if (!b || a.s - b.s > 1.0) pick = a;
    else {
      const tied = scored.filter((y) => y.hit === toks.length && a.s - y.s <= 1.0);
      const mine = tied.filter((y) => y.x.d.assigned_to === uploader);
      if (mine.length === 1) pick = mine[0], why = 'tie → uploader\'s deal';
      else why = `ambiguous (${tied.length} deals)`;
    }
    out.push({ f, toks, pick: pick?.x.d, score: pick?.s, why });
  }

  const matched = out.filter((o) => o.pick);
  console.log(`orphans ${orphans.length}, matched ${matched.length}, unmatched ${orphans.length - matched.length}`);
  for (const o of matched) console.log(`  ✓ ${o.f.name}  →  ${o.pick.title}  [${o.toks.join(',')}] ${o.why}`);
  const reasons = {};
  for (const o of out.filter((o) => !o.pick)) reasons[o.why.replace(/\(.*\)/, '')] = (reasons[o.why.replace(/\(.*\)/, '')] ?? 0) + 1;
  console.log('unmatched by reason', reasons);
  fs.writeFileSync(outPath, JSON.stringify(out.map((o) => ({ uuid: o.f.uuid, name: o.f.name, deal_id: o.pick?.id ?? null, deal: o.pick?.title ?? null, why: o.why, toks: o.toks }))));
  await db.$disconnect();
})();
