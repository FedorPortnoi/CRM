-- Make the invite claim code unique, and therefore indexed.
--
-- WHY
-- ---
-- `POST /auth/invites/lookup` accepts a six-character claim code from an
-- unauthenticated caller and resolves it with a bare match on "claim_hash". With
-- no uniqueness the query could match rows in more than one organisation, and
-- the handler took the first — so a collision did not fail, it silently minted
-- an accept token for the WRONG TENANT and the invitee would have joined a
-- company that never invited them. With no index it was also a sequential scan
-- over the whole table, on a public endpoint.
--
-- One unique index fixes both: it makes "at most one invite answers to a given
-- claim code" a constraint instead of an assumption about 2^30 values, and a
-- unique index is an index.
--
-- SAFE ON A LIVE DATABASE
-- -----------------------
-- Everything below is additive or a no-op on rows that are already dead, and
-- every statement is re-runnable. The two UPDATEs exist because CREATE UNIQUE
-- INDEX is not additive if the data already violates it: they clear exactly the
-- digests that cannot be redeemed anyway, which is the only way to guarantee the
-- index build succeeds rather than aborting the deploy.

-- 1. Retire claim codes that can no longer be spent.
--
--    A claim code is only redeemable while claim_expires_at is in the future and
--    the invite is neither consumed nor revoked; `accept` already nulls it on
--    success but nothing ever cleared the expired ones, so every code the
--    product has ever minted was still sitting in this column competing for the
--    same 2^30 values. Clearing them changes no behaviour — none of these could
--    have redeemed — and it is what keeps the collision space proportional to
--    LIVE invites instead of to all invites ever opened.
--
--    Timestamps here are naive TIMESTAMP(3) holding UTC, so compare against UTC
--    explicitly rather than letting the session TimeZone decide. This database
--    ran three hours off once; it is not going to be the thing that decides
--    which invites survive.
UPDATE "Invite"
SET "claim_hash" = NULL,
    "claim_expires_at" = NULL
WHERE "claim_hash" IS NOT NULL
  AND (
    "claim_expires_at" IS NULL
    OR "claim_expires_at" <= (NOW() AT TIME ZONE 'UTC')
    OR "consumed_at" IS NOT NULL
    OR "revoked_at" IS NOT NULL
  );

-- 2. Anything still duplicated is a live collision — the exact bug. Keep one and
--    clear the rest.
--
--    Keeping the newest is deliberate: it is the one whose holder most recently
--    saw the code on screen, and the losers are invites whose LINK is still good
--    for its full 24 hours, so their recipients recover by re-opening the
--    landing page for a fresh code. Resolving the ambiguity in favour of nobody
--    would have been defensible too; resolving it in favour of an arbitrary row
--    is what this migration exists to stop.
UPDATE "Invite" AS i
SET "claim_hash" = NULL,
    "claim_expires_at" = NULL
WHERE i."claim_hash" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "Invite" AS j
    WHERE j."claim_hash" = i."claim_hash"
      AND (j."created_at", j."id") > (i."created_at", i."id")
  );

-- 3. Now the constraint holds; make it structural.
--
--    Nullable and unique together mean "many rows may hold no claim code, no two
--    may hold the same one" — Postgres does not treat NULLs as equal, which is
--    what allows the column to stay optional. Named to match what Prisma
--    generates for @unique on this model, so `prisma migrate diff` sees no drift.
CREATE UNIQUE INDEX IF NOT EXISTS "Invite_claim_hash_key" ON "Invite"("claim_hash");
