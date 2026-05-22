# Supabase to Yandex Managed PostgreSQL Migration Runbook

## 1. Prerequisites

- Install and authenticate the Yandex Cloud CLI:
  ```bash
  curl -sSL https://storage.yandexcloud.net/yandexcloud-yc/install.sh | bash
  yc init
  ```
- Use a `pg_dump` and `psql` client version that matches the source Supabase PostgreSQL major version.
- Download the Yandex Managed PostgreSQL root CA:
  ```bash
  curl -o ./certs/yandex-ca.pem https://storage.yandexcloud.net/cloud-certs/CA.pem
  ```
- Keep the existing Supabase database live and writeable until verification is complete.

## 2. Export From Supabase

Run the export from a machine that can reach Supabase:

```bash
pg_dump "postgresql://postgres:<supabase-password>@<supabase-host>:5432/postgres?sslmode=require" \
  --format=custom \
  --no-owner \
  --no-acl \
  --schema=public \
  --file=crm_supabase_public.dump
```

## 3. Create Yandex Managed PostgreSQL Cluster

Create the cluster with the Yandex Cloud CLI:

```bash
yc managed-postgresql cluster create crm-postgres \
  --environment=production \
  --network-name=<network-name> \
  --host zone-id=<zone-id>,subnet-id=<subnet-id>,assign-public-ip=true \
  --postgresql-version=16 \
  --resource-preset=s3-c2-m8 \
  --disk-type=network-ssd \
  --disk-size=50 \
  --backup-window-start=02:00:00 \
  --deletion-protection
```

Adjust `postgresql-version`, resource preset, disk size, zone, and subnet to match the production sizing plan.

## 4. Set Up User And Database

In the Yandex Cloud console:

1. Open the new Managed PostgreSQL cluster.
2. Create a database named `crm_db`.
3. Create an application user with a strong password.
4. Grant that user ownership or full privileges on `crm_db`.
5. Confirm the cluster host name ends with `.mdb.yandexcloud.net` and note port `6432`.

## 5. Restore To Yandex

Restore using SSL and the Yandex CA:

```bash
PGSSLROOTCERT=./certs/yandex-ca.pem pg_restore \
  --dbname="postgresql://<user>:<password>@<cluster-host>.mdb.yandexcloud.net:6432/crm_db?sslmode=require" \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  crm_supabase_public.dump
```

If you exported a plain SQL file instead of custom format, restore with:

```bash
PGSSLROOTCERT=./certs/yandex-ca.pem psql \
  "postgresql://<user>:<password>@<cluster-host>.mdb.yandexcloud.net:6432/crm_db?sslmode=require" \
  --file=crm_supabase_public.sql
```

## 6. Verify

Compare row counts between Supabase and Yandex for key tables:

```sql
SELECT count(*) FROM "organizations";
SELECT count(*) FROM "User";
SELECT count(*) FROM "Contact";
SELECT count(*) FROM "Deal";
SELECT count(*) FROM "Task";
SELECT count(*) FROM "Message";
SELECT count(*) FROM "CalendarEvent";
SELECT count(*) FROM "Pipeline";
SELECT count(*) FROM "PipelineStage";
SELECT count(*) FROM "Workflow";
SELECT count(*) FROM "WorkflowRun";
SELECT count(*) FROM "PendingCapture";
```

Also run a basic application smoke check against the Yandex connection string before switching production traffic.

## 7. Update `.env`

Set the new URLs:

```bash
DATABASE_URL="postgresql://<user>:<password>@<cluster-host>.mdb.yandexcloud.net:6432/crm_db?sslmode=require&sslrootcert=/absolute/path/to/yandex-ca.pem"
DIRECT_URL="postgresql://<user>:<password>@<cluster-host>.mdb.yandexcloud.net:6432/crm_db?sslmode=require&sslrootcert=/absolute/path/to/yandex-ca.pem"
YANDEX_DB_SSL_CA="/absolute/path/to/yandex-ca.pem"
```

Alternatively, set `PGSSLROOTCERT=/absolute/path/to/yandex-ca.pem` before starting the backend and keep `sslmode=require` in both URLs.

## 8. Regenerate Prisma Client

After updating environment variables, regenerate Prisma:

```bash
npm run db:generate
```

## 9. Rollback Plan

- Keep Supabase live for at least 48 hours after cutover.
- Keep the Supabase connection string available but disabled in production config.
- Compare row counts and spot-check recent records during the 48-hour window.
- If rollback is needed, point `DATABASE_URL` and `DIRECT_URL` back to Supabase, restart the backend, and pause writes to Yandex until the divergence is reconciled.
