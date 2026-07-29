-- Add the business roles to UserRole.
--
-- Purely additive: no existing row changes, no column is rewritten, and every
-- current value (owner/admin/member/viewer) keeps its meaning. Adding an enum
-- label is not reversible in Postgres without recreating the type, so this
-- migration is deliberately one-way.
--
-- IF NOT EXISTS guards a re-run against a database where an earlier partial
-- apply already added some labels.
--
-- Note on transactions: PostgreSQL 12+ permits ALTER TYPE ... ADD VALUE inside a
-- transaction block provided the new label is not USED in that same
-- transaction. Nothing here writes a row with these values, so it is safe under
-- Prisma's transactional migration runner. The cluster is PostgreSQL 16.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'head';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'accountant';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'marketer';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'support';
