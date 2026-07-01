'use strict';

// Load .env manually
const fs = require('fs');

const envFile = fs.readFileSync('/home/fedor/CRM/.env', 'utf8');
for (const line of envFile.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx < 0) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  let val = trimmed.slice(eqIdx + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!process.env[key]) process.env[key] = val;
}

const { PrismaClient } = require('/home/fedor/CRM/node_modules/.prisma/client');
const bcrypt = require('/home/fedor/CRM/node_modules/bcryptjs');

const prisma = new PrismaClient();

const ORG_ID = 'b4640ecd-ad53-451f-a3bb-53a6b6134eae';
const OWNER_ID = '900ee543-177d-4249-a428-bd2b6ac030a3';

const FIRST_NAMES_M = [
  'Александр','Алексей','Андрей','Антон','Артём','Борис','Вадим','Валентин','Василий','Виктор',
  'Виталий','Владимир','Владислав','Вячеслав','Геннадий','Георгий','Григорий','Даниил','Денис','Дмитрий',
  'Евгений','Иван','Игорь','Илья','Кирилл','Константин','Леонид','Максим','Михаил','Никита',
  'Николай','Олег','Павел','Пётр','Роман','Руслан','Сергей','Степан','Тимур','Фёдор',
  'Филипп','Юрий','Яков','Артур','Богдан','Вениамин','Глеб','Егор','Захар','Марк'
];
const FIRST_NAMES_F = [
  'Александра','Алина','Анастасия','Анна','Валентина','Валерия','Вероника','Виктория','Галина','Дарья',
  'Диана','Екатерина','Елена','Елизавета','Жанна','Зинаида','Ирина','Карина','Кристина','Ксения',
  'Лариса','Людмила','Маргарита','Марина','Мария','Надежда','Наталья','Нина','Оксана','Ольга',
  'Полина','Светлана','София','Тамара','Татьяна','Ульяна','Юлия','Яна','Алёна','Вера',
  'Лидия','Любовь','Милена','Наталия','Регина','Снежана','Тамила','Эльвира','Юлиана','Злата'
];
const LAST_NAMES_M = [
  'Иванов','Петров','Сидоров','Смирнов','Кузнецов','Попов','Васильев','Соколов','Михайлов','Новиков',
  'Фёдоров','Морозов','Волков','Алексеев','Лебедев','Семёнов','Егоров','Павлов','Козлов','Степанов',
  'Николаев','Орлов','Андреев','Макаров','Никитин','Захаров','Зайцев','Соловьёв','Борисов','Яковлев',
  'Григорьев','Романов','Воробьёв','Герасимов','Тихонов','Баранов','Ковалёв','Белов','Алёхин','Тарасов',
  'Комаров','Крылов','Марков','Королёв','Антонов','Осипов','Терентьев','Горбунов','Филиппов','Кириллов',
  'Портной','Беляев','Гусев','Ефимов','Панов','Давыдов','Быков','Дроздов','Щербаков','Лазарев'
];
const LAST_NAMES_F = [
  'Иванова','Петрова','Сидорова','Смирнова','Кузнецова','Попова','Васильева','Соколова','Михайлова','Новикова',
  'Фёдорова','Морозова','Волкова','Алексеева','Лебедева','Семёнова','Егорова','Павлова','Козлова','Степанова',
  'Николаева','Орлова','Андреева','Макарова','Никитина','Захарова','Зайцева','Соловьёва','Борисова','Яковлева',
  'Григорьева','Романова','Воробьёва','Герасимова','Тихонова','Баранова','Ковалёва','Белова','Алёхина','Тарасова',
  'Комарова','Крылова','Маркова','Королёва','Антонова','Осипова','Терентьева','Горбунова','Филиппова','Кириллова',
  'Портная','Белякова','Гусева','Ефимова','Панова','Давыдова','Быкова','Дроздова','Щербакова','Лазарева'
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randomRussianName() {
  const male = Math.random() < 0.55;
  const first = male ? pick(FIRST_NAMES_M) : pick(FIRST_NAMES_F);
  const last = male ? pick(LAST_NAMES_M) : pick(LAST_NAMES_F);
  return { first, last, fullName: first + ' ' + last };
}

function randomPhone() {
  const num = Math.floor(Math.random() * 9000000000) + 1000000000;
  return '+7' + num;
}

function transliterate(s) {
  const map = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i',
    'й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t',
    'у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'',
    'э':'e','ю':'yu','я':'ya'
  };
  return s.toLowerCase().split('').map(c => map[c] !== undefined ? map[c] : c).join('').replace(/[^a-z0-9]/g,'');
}

function randomEmail(first, last, idx) {
  const domains = ['gmail.com','mail.ru','yandex.ru','inbox.ru','bk.ru','list.ru','rambler.ru'];
  return transliterate(first) + '.' + transliterate(last) + idx + '@' + pick(domains);
}

const COMPANY_PREFIXES = ['ООО','АО','ИП','ПАО','ЗАО','НАО'];
const COMPANY_NAMES = [
  'Технологии','Строй','Торг','Инвест','Капитал','Ресурс','Сервис','Групп','Холдинг','Медиа',
  'Логистик','Консалт','Финанс','Трейд','Системы','Решения','Партнёр','Альянс','Прогресс','Инновации',
  'Перспектива','Горизонт','Вектор','Импульс','Контакт','Меркурий','Нептун','Орион','Сатурн','Квант'
];
const DEAL_TYPES = [
  'Поставка оборудования','Разработка ПО','Консультационные услуги','Аутсорсинг','Интеграция систем',
  'Техническое обслуживание','Лицензирование','Маркетинговые услуги','Обучение персонала','Аудит',
  'Модернизация инфраструктуры','Внедрение CRM','Поддержка серверов','Разработка приложения','SEO-продвижение'
];

function randomDealTitle() {
  return pick(COMPANY_PREFIXES) + ' ' + pick(COMPANY_NAMES) + ' — ' + pick(DEAL_TYPES);
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function main() {
  console.log('=== CRM Stress Seed Script ===');
  console.log('Org:', ORG_ID);
  console.log('');

  // 1. Create 200 users
  console.log('[1/4] Creating 200 employees...');
  const passwordHash = bcrypt.hashSync('Test1234!', 4);
  console.log('  Password hash generated.');

  const roles = [
    ...Array(10).fill('admin'),
    ...Array(130).fill('member'),
    ...Array(60).fill('viewer'),
  ];

  const existingUsernames = new Set();
  const existingRows = await prisma.user.findMany({
    where: { organization_id: ORG_ID },
    select: { username: true }
  });
  for (const u of existingRows) { if (u.username) existingUsernames.add(u.username.toLowerCase()); }

  const usersToCreate = [];
  for (let i = 0; i < 200; i++) {
    const { first, last, fullName } = randomRussianName();
    let username = fullName;
    let suffix = 1;
    while (existingUsernames.has(username.toLowerCase())) {
      username = fullName + suffix;
      suffix++;
    }
    existingUsernames.add(username.toLowerCase());

    usersToCreate.push({
      organization_id: ORG_ID,
      name: fullName,
      username: username,
      email: randomEmail(first, last, i + 1),
      password_hash: passwordHash,
      role: roles[i],
      is_active: true,
      is_verified: true,
      must_change_password: false,
      must_change_email: false,
      invited_by: OWNER_ID,
    });
  }

  const createdUserIds = [];
  const userChunks = chunkArray(usersToCreate, 50);
  for (let ci = 0; ci < userChunks.length; ci++) {
    const result = await prisma.user.createManyAndReturn({
      data: userChunks[ci],
      select: { id: true, role: true }
    });
    for (const u of result) createdUserIds.push(u);
    console.log('  Created batch ' + (ci+1) + '/' + userChunks.length + ' (' + userChunks[ci].length + ' users)');
  }

  const adminIds = createdUserIds.filter(u => u.role === 'admin').map(u => u.id);
  const memberIds = createdUserIds.filter(u => u.role === 'member').map(u => u.id);
  const viewerIds = createdUserIds.filter(u => u.role === 'viewer').map(u => u.id);
  const allNewIds = createdUserIds.map(u => u.id);

  console.log('  Total created: ' + createdUserIds.length + ' (admins: ' + adminIds.length + ', members: ' + memberIds.length + ', viewers: ' + viewerIds.length + ')');

  // 2. Set up hierarchy
  console.log('[2/4] Setting up manager hierarchy...');

  await prisma.user.updateMany({
    where: { id: { in: adminIds } },
    data: { manager_id: OWNER_ID }
  });
  console.log('  Admins assigned to owner.');

  const memberChunksForAdmin = chunkArray(memberIds, Math.ceil(memberIds.length / adminIds.length));
  for (let ai = 0; ai < adminIds.length; ai++) {
    const chunk = memberChunksForAdmin[ai];
    if (!chunk || !chunk.length) continue;
    await prisma.user.updateMany({
      where: { id: { in: chunk } },
      data: { manager_id: adminIds[ai] }
    });
  }
  console.log('  Members assigned to admins.');

  const viewersToAssign = viewerIds.slice(0, 30);
  for (const vid of viewersToAssign) {
    const mgr = pick(memberIds);
    await prisma.user.update({ where: { id: vid }, data: { manager_id: mgr } });
  }
  console.log('  30 viewers assigned to random members.');

  // 3. Add 622 contacts
  console.log('[3/4] Creating 622 contacts...');
  const contactTypes = ['lead','customer','partner','other'];

  const contactsToCreate = [];
  for (let i = 0; i < 622; i++) {
    const { first, last } = randomRussianName();
    const assignTo = pick(allNewIds);
    const createdBy = pick(allNewIds);
    contactsToCreate.push({
      organization_id: ORG_ID,
      first_name: first,
      last_name: last,
      phone: randomPhone(),
      email: randomEmail(first, last, 10000 + i),
      assigned_to: assignTo,
      created_by: createdBy,
      type: pick(contactTypes),
      status: 'active',
    });
  }

  const contactChunks = chunkArray(contactsToCreate, 50);
  for (let ci = 0; ci < contactChunks.length; ci++) {
    await prisma.contact.createMany({ data: contactChunks[ci] });
    if ((ci + 1) % 4 === 0 || ci === contactChunks.length - 1) {
      console.log('  Contact batch ' + (ci+1) + '/' + contactChunks.length + ' done');
    }
  }

  // 4. Add 390 deals
  console.log('[4/4] Creating 390 deals...');

  const pipelines = await prisma.pipeline.findMany({
    where: { organization_id: ORG_ID },
    include: { stages: true }
  });
  console.log('  Found ' + pipelines.length + ' pipelines');
  if (!pipelines.length) throw new Error('No pipelines found for this org!');

  const pipelineStages = [];
  for (const p of pipelines) {
    for (const s of p.stages) {
      pipelineStages.push({ pipeline_id: p.id, stage_id: s.id });
    }
  }
  console.log('  Available stage slots: ' + pipelineStages.length);

  const dealsToCreate = [];
  for (let i = 0; i < 390; i++) {
    const ps = pick(pipelineStages);
    const assignTo = pick(allNewIds);
    const createdBy = pick(allNewIds);
    const value = Math.floor(Math.random() * (5000000 - 50000 + 1)) + 50000;
    dealsToCreate.push({
      organization_id: ORG_ID,
      title: randomDealTitle(),
      pipeline_id: ps.pipeline_id,
      stage_id: ps.stage_id,
      value: value,
      currency: 'RUB',
      status: 'open',
      assigned_to: assignTo,
      created_by: createdBy,
    });
  }

  const dealChunks = chunkArray(dealsToCreate, 50);
  for (let ci = 0; ci < dealChunks.length; ci++) {
    await prisma.deal.createMany({ data: dealChunks[ci] });
    if ((ci + 1) % 2 === 0 || ci === dealChunks.length - 1) {
      console.log('  Deal batch ' + (ci+1) + '/' + dealChunks.length + ' done');
    }
  }

  // Final counts
  console.log('');
  console.log('=== FINAL COUNTS ===');
  const [totalUsers, totalContacts, totalDeals] = await Promise.all([
    prisma.user.count({ where: { organization_id: ORG_ID } }),
    prisma.contact.count({ where: { organization_id: ORG_ID } }),
    prisma.deal.count({ where: { organization_id: ORG_ID } }),
  ]);
  console.log('Total users in org:    ', totalUsers);
  console.log('Total contacts in org: ', totalContacts);
  console.log('Total deals in org:    ', totalDeals);
  console.log('');
  console.log('DONE.');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); }).finally(() => prisma.$disconnect());
