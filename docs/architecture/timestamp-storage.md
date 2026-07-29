# Timestamp Storage and the Session TimeZone

Status: settled 2026-07-28. Read this before "fixing" any timestamp column type.

## The rule

`schema.prisma` is the source of truth for column types. It declares every temporal
field as a bare `DateTime` and contains **zero** `@db.Timestamptz` annotations, so the
intended Postgres type everywhere is `timestamp(3)` — *without* time zone.

The shipped migration history matches: `schema.prisma` declares **90** `DateTime`
fields, and after `20260727120000_reconcile_schema_drift` there are **no** `timestamptz`
columns left in the Prisma-managed schema. (The migrations contain 94 textual
`TIMESTAMP(3)` occurrences, but three are in `add_notifications.sql`, which was never
applied, and two are the `SET DATA TYPE` retypes rather than column declarations — so
count columns from `schema.prisma`, not by grepping the SQL.)

The hand-written SQL under `backend/db/schema/*.sql` is full of `TIMESTAMPTZ`. That
directory is pre-Prisma legacy and is not applied by anything. Do not use it as a
reference for live column types. `docs/architecture/data-models.md` is a design-era
document with the same problem; its column types are aspirational, not observed.

## The reported hazard, and why it is not one

`20260727120000_reconcile_schema_drift/migration.sql` lines 29 and 32 retype
`User.locked_until` and `organizations.join_code_expires_at` from `timestamptz` to
`TIMESTAMP(3)` with no `USING` clause:

```sql
ALTER COLUMN "locked_until" SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "organizations" ALTER COLUMN "join_code_expires_at" SET DATA TYPE TIMESTAMP(3);
```

Postgres casts `timestamptz -> timestamp` through the session `TimeZone`, so on a
non-UTC connection this rewrites every stored value by the UTC offset. Read literally
that is a real defect pattern. It did not fire here, for four independent reasons.

**1. It never ran on production.** The migration was marked applied with
`migrate resolve --applied` after every statement in it was verified already-true
against the live schema. Both columns are already `timestamp without time zone`,
precision 3, on the production cluster. The `ALTER` was never executed there.

**2. On a fresh database it runs against empty tables.** Migrations run in
lexicographic order and insert no rows. When `20260727120000` executes, `User` and
`organizations` were created eleven migrations earlier and are still empty. Zero rows,
zero shift.

**3. No database exists in the dangerous middle state.** The shift needs a database
that still has these columns as `timestamptz`, holds real rows, and has not yet applied
`20260727120000`. Production is resolved-as-applied. The old Yandex cluster that once
held hand-applied DDL is gone. CI, smoke (`SMOKE_DATABASE_URL`) and local databases are
built from the migration history, so they land in case 2.

**4. At runtime these two columns round-trip exactly, whatever the session TimeZone.**
Both are written only as bound Prisma parameters and read only through Prisma:

| Path | Site |
|---|---|
| write | `auth.ts:121`, `auth.ts:233` (bound `${join_code_expires_at}`, not `NOW()`), `auth.ts:645`, `auth.ts:174`, `auth.ts:180`, `scheduler.ts:249` |
| read | `auth.ts:115`, `auth.ts:155`, `auth.ts:586`, `scheduler.ts:241` |

Neither column has a `DEFAULT`, and no server-side expression ever writes them. When the
driver applies the same transform on write and its inverse on read, the round-trip is
exact even if the session `TimeZone` is not UTC. The expiry comparison at `auth.ts:586`
and the lockout comparison at `auth.ts:155` are both JS-side `Date` comparisons on
Prisma-read values, so they stay self-consistent.

## Decision: no data migration

None is written, and none should be.

A corrective migration would also be **impossible to make safe**, which is the more
important half of this decision:

- After `20260727120000` — whether executed or resolved — both columns are
  `timestamp` in every reachable state. Any new migration is ordered after it and would
  therefore always find the type already converted. The column type was the only marker
  distinguishing "converted cleanly" from "converted with an offset", and it is already
  consumed. There is nothing left to test for, so the migration cannot be made
  idempotent in any meaningful sense.
- The offset that would need undoing is unknown. It is a function of the session
  `TimeZone` of an operation that never happened on production and ran against empty
  tables everywhere else.
- Applying `AT TIME ZONE 'UTC'` to values that are already correct **introduces** the
  exact corruption the report was trying to prevent, at full offset magnitude, on every
  row.

A guarded `DO $$ ... IF data_type = 'timestamp with time zone' ... $$` block was
considered and rejected. It is provably dead in every reachable state, it would be
recorded as applied on first run and so could never help a column that someone later
reverts by hand, and a future reader would mistake dead insurance for an active fix.

Even in the counterfactual where an offset had been applied, both columns are
self-clearing: `locked_until` has a 30-minute TTL and is set to `NULL` on any successful
login (`auth.ts:180`), and `join_code_expires_at` has a 7-day TTL with
`rotateExpiredJoinCodes` (`scheduler.ts:239`) overwriting it on the scheduler loop. The
blast radius of the worst case was bounded to at most 7 days of join codes and 30
minutes of lockouts, all of it now historical.

## Where the residual exposure actually is

The retype removed the last two odd columns out. It did not create the session-TimeZone
dependency — that dependency is already load-bearing across the schema, and it lives in
values generated **server-side** and then read back through Prisma:

- **34 columns declared `TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`.**
  `CURRENT_TIMESTAMP` is `timestamptz`; assigning it into a naive column casts it
  through the session `TimeZone` on every insert.
- **The registration CTE at `backend/api/controllers/auth.ts:229`** writes `NOW()` into
  five naive columns at lines 233, 238, 244, 250 and 261 (`organizations.updated_at`,
  `User.updated_at`, the owner-update `updated_at`, `Pipeline.updated_at`, and
  `PipelineStage.updated_at`).

These skew by the UTC offset if the session `TimeZone` is not UTC, because Prisma
applies its read transform to a value its write transform never touched. Nothing in the
repository currently pins the session `TimeZone`: there is no `SET TIME ZONE`, no
`options=-c timezone=UTC` in a connection string builder, and no `TZ`/`PGTZ` in any
config under source control.

This is a pre-existing condition, not a regression from the reconcile migration, and it
is out of scope for this note beyond recording it.

## The guard

**Pin the session TimeZone to UTC.** This closes the whole class at once: the two
flagged retypes, the 34 `DEFAULT CURRENT_TIMESTAMP` columns, and the `NOW()` writes in
registration all become exact.

Append to every connection URL — `DATABASE_URL`, `DIRECT_URL`, and the production pair
`CLOUD_DATABASE_URL` / `CLOUD_DIRECT_URL`:

```
?options=-c%20timezone%3DUTC
```

(or `&options=...` if the URL already carries `sslmode=` or `sslrootcert=`). Setting
`TZ=UTC` on the API process is not a substitute — that changes the Node process clock,
not the Postgres session. Verify with `SHOW TimeZone;` on the connection the API
actually uses.

**State as of 2026-07-28.** This was not a theoretical exposure. `DATABASE_URL` and
`DIRECT_URL` (local dev) already carried the option, but the production pair did not,
and the managed cluster reported `TimeZone = Europe/Moscow` — so
`SELECT now()::timestamp = (now() AT TIME ZONE 'UTC')` returned false, and every
server-generated timestamp on production was being stored three hours off what Prisma
reads back. The option has since been appended to `CLOUD_DATABASE_URL` and
`CLOUD_DIRECT_URL`, and the same query now returns true.

The reason this stayed invisible is worth keeping: dev was pinned and production was
not, so the skew could never reproduce locally. Check the connection that is actually
in use, not the one that is convenient to test.

**Review rule for future migrations.** Any `ALTER COLUMN ... SET DATA TYPE` that crosses
time-zone awareness in either direction must carry an explicit `USING` clause stating
the intended interpretation, even when the table is expected to be empty:

```sql
-- timestamptz -> timestamp: state the source zone explicitly
ALTER TABLE t ALTER COLUMN c TYPE TIMESTAMP(3) USING (c AT TIME ZONE 'UTC');

-- timestamp -> timestamptz: state how the naive value should be read
ALTER TABLE t ALTER COLUMN c TYPE TIMESTAMPTZ USING (c AT TIME ZONE 'UTC');
```

`prisma migrate diff` will not generate the `USING` clause for you. Add it by hand
before committing a generated migration, and check the table is empty at that point in
the history if you cannot.

**Do not** add `@db.Timestamptz` to `schema.prisma` to "fix" this. That inverts all 90
temporal fields and would generate exactly the unguarded mass retype this note is about.
