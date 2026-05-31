CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    GROUP BY lower(trim(email))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot normalize User.email because case-insensitive duplicates exist';
  END IF;
END $$;

UPDATE "User"
SET email = lower(trim(email))
WHERE email <> lower(trim(email));

ALTER TABLE "User"
ALTER COLUMN email TYPE CITEXT
USING lower(trim(email))::citext;
