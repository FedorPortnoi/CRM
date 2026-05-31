const { PrismaClient } = require('./node_modules/@prisma/client');
const db = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://postgres.tiufcjxeiorvteuypaxl:HofstraNY2026@aws-1-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connect_timeout=10'
    }
  }
});
db.$connect()
  .then(() => { console.log('CONNECTED OK'); return db.$queryRaw`SELECT 1 as n`; })
  .then(r => { console.log('QUERY OK', r); return db.$disconnect(); })
  .catch(e => { console.error('FAILED:', e.message.split('\n')[0]); process.exit(1); });
