const { PrismaClient } = require('./node_modules/@prisma/client');
const db = new PrismaClient({
  datasources: { db: { url: 'postgresql://postgres.tiufcjxeiorvteuypaxl:HofstraNY2026@aws-1-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connect_timeout=10' } }
});
db.$connect()
  .then(() => db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)
  .then(rows => { console.log('Tables:', rows.map(r => r.tablename).join(', ')); return db.$disconnect(); })
  .catch(e => { console.error(e.message); process.exit(1); });
