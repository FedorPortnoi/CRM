-- Give AssistantMessage a deterministic intra-turn order.
--
-- Every message produced by one assistant turn (user text, the assistant row
-- carrying tool_calls, the tool-result row, the final answer) is written inside a
-- single db.$transaction. PostgreSQL evaluates now()/CURRENT_TIMESTAMP once per
-- transaction, so all of those rows carry an IDENTICAL created_at, and the
-- primary key is a random gen_random_uuid() — neither can order them. Replay
-- (backend/services/assistant.ts) ordered by created_at alone, so intra-turn
-- order was arbitrary.
--
-- Harmless while the provider is YandexGPT. Fatal for the planned OpenAI swap:
-- OpenAI rejects a tool message whose tool_call_id does not correlate with the
-- immediately preceding assistant tool call, and those calls live in the
-- tool_calls Json column on this very table.
--
-- Fix: a BIGSERIAL "seq". nextval() is claimed per INSERT rather than per
-- transaction, so it records true insertion order. BIGSERIAL rather than SERIAL
-- because a chat-message table is the sort of table that outgrows int4, and the
-- column is never serialised to JSON (both read sites use an explicit select
-- that omits it), so the JS bigint mapping costs nothing.
--
-- Written by hand rather than generated so the backfill is deterministic:
-- 'ALTER TABLE ... ADD COLUMN seq BIGSERIAL NOT NULL' — what prisma migrate diff
-- emits — numbers existing rows in physical heap order, which is arbitrary.
--
-- Generated 2026-07-28.

-- AlterTable: add nullable first so the backfill controls the numbering.
ALTER TABLE "AssistantMessage" ADD COLUMN "seq" BIGINT;

-- Backfill every existing row. (created_at, id) is not the true insertion order
-- for rows that tied — that information was never recorded and cannot be
-- recovered — but it is total and stable, so the outcome is at least
-- reproducible and leaves no NULL behind.
WITH ordered AS (
    SELECT "id", row_number() OVER (ORDER BY "created_at" ASC, "id" ASC) AS rn
    FROM "AssistantMessage"
)
UPDATE "AssistantMessage" AS m
SET "seq" = ordered.rn
FROM ordered
WHERE m."id" = ordered."id";

ALTER TABLE "AssistantMessage" ALTER COLUMN "seq" SET NOT NULL;

-- Reproduce exactly what BIGSERIAL would have built: an owned bigint sequence
-- plus a nextval default, so Prisma introspects the column as
-- 'seq BigInt @default(autoincrement())' and reports no drift.
CREATE SEQUENCE "AssistantMessage_seq_seq" AS BIGINT OWNED BY "AssistantMessage"."seq";

-- is_called = false, so the next nextval() returns this value rather than the
-- one after it: max(seq) + 1 on a populated table, 1 on an empty one.
SELECT setval(
    '"AssistantMessage_seq_seq"',
    COALESCE((SELECT MAX("seq") FROM "AssistantMessage"), 0) + 1,
    false
);

ALTER TABLE "AssistantMessage"
    ALTER COLUMN "seq" SET DEFAULT nextval('"AssistantMessage_seq_seq"');

-- DropIndex: superseded. seq is monotonic with insertion time, so
-- (conversation_id, seq) serves every query the old index served, and unlike the
-- old one it actually breaks the intra-turn tie.
DROP INDEX "AssistantMessage_conversation_id_created_at_idx";

-- CreateIndex
CREATE INDEX "AssistantMessage_conversation_id_seq_idx" ON "AssistantMessage"("conversation_id", "seq");
