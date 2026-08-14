-- "Stay signed in" toggle (Settings). Read at every session-minting endpoint
-- to choose the JWT's lifetime: 90 days when true, the JWT_EXPIRES_IN default
-- (7 days) otherwise. See STAY_SIGNED_IN_EXPIRES_IN in backend/api/controllers/auth.ts.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "stay_signed_in" BOOLEAN NOT NULL DEFAULT false;
