-- Employees join via company code + username, so email becomes optional and
-- usernames are unique per-organization.

-- Email is no longer required (employees start without one until first login).
ALTER TABLE "User" ALTER COLUMN email DROP NOT NULL;

-- Username employees log in with; unique only within their organization.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS username CITEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS must_change_email BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "User_organization_id_username_key"
  ON "User" (organization_id, username);

-- Rotating company join code lives on the organization.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS join_code TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS join_code_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS "organizations_join_code_key"
  ON organizations (join_code);
