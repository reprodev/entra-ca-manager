# Docker Deployment Guide

Audience: MSP admins and platform engineers deploying `entra-ca-manager` in containers.

---

## 1) Prerequisites

- Docker Engine and Docker Compose plugin installed
- Access to this repository
- A prepared `.env` file with deployment values

Optional but recommended for production:

- Reverse proxy with TLS termination (Nginx, Traefik, IIS ARR, or Azure front end)
- External Redis for multi-instance session/rate-limit state

---

## 2) Quick start (single container)

From the repository root:

```bash
docker build -t entra-ca-manager:latest .
docker run --name entra-ca-manager --detach \
  -p 3000:3000 \
  --env-file .env \
  -e NODE_ENV=production \
  -v entra_ca_data:/app/data \
  entra-ca-manager:latest
```

Verify service health:

```bash
curl http://127.0.0.1:3000/health
```

---

## 3) Preferred local/prod workflow (Docker Compose)

Start with compose:

```bash
docker compose --env-file .env up -d --build
```

Inspect status:

```bash
docker compose ps
docker compose logs -f
```

Stop services:

```bash
docker compose down
```

The compose file mounts persistent app data to `/app/data` using volume `entra_ca_data`.

---

## 4) Environment configuration

Container defaults:

- `HOST=0.0.0.0`
- `PORT=3000`
- `NODE_ENV=production`

Minimum production settings (example baseline):

```env
ENABLE_SSO_LOGIN=true
SSO_TENANT_ID=<entra-tenant-id>
SSO_CLIENT_ID=<app-client-id>
SSO_CLIENT_SECRET=<app-client-secret>
SSO_REDIRECT_URI=https://<your-fqdn>/auth/callback
SESSION_SECRET=<long-random-secret>
SESSION_COOKIE_SECURE=true
AUTH_REQUIRE_GROUPS=true
AUTH_ADMIN_GROUP_IDS=<admin-group-object-id>
AUTH_ANALYST_GROUP_IDS=<analyst-group-object-id>
AUDIT_LOG_ENABLED=true
AUDIT_LOG_SECRET=<long-random-secret>
```

For multi-instance or horizontal scale:

```env
REDIS_ENABLED=true
REDIS_REQUIRED=true
REDIS_URL=rediss://<redis-endpoint>:6380
REDIS_KEY_PREFIX=cam-prod
```

---

## 5) Persistence and backup

The app writes runtime state under `/app/data`:

- `local-users.json` (local auth directory)
- `audit/auth-admin-audit.log.jsonl` (tamper-aware audit log chain)

Backup guidance:

- snapshot Docker volume `entra_ca_data` on a schedule
- keep secure backups of `.env` and secrets outside source control
- periodically run `npm run audit:verify` on a trusted clone to validate audit chain integrity

---

## 6) Upgrade procedure

When pulling a newer image/build:

```bash
docker compose pull
docker compose up -d --build
```

Or if you build locally each release:

```bash
docker compose up -d --build
```

Post-upgrade checks:

1. `docker compose ps` shows `healthy` status.
2. `GET /health` returns expected auth/runtime mode.
3. Admin and analyst sign-in paths still function.

---

## 7) Troubleshooting

- Container exits immediately:
  - run `docker compose logs` and check startup error output
  - verify required env vars are present in `.env`

- Port binding failure on `3000`:
  - another process is already using host port `3000`
  - remap host port (example `-p 3001:3000`) and retest

- Login/session issues behind reverse proxy:
  - ensure HTTPS is used for clients
  - ensure proxy forwards `X-Forwarded-Proto=https`
  - confirm `SESSION_COOKIE_SECURE=true` in production HTTPS deployments

- Local auth data not persisting:
  - verify `/app/data` is mounted to a persistent Docker volume
  - check container has write access to that mount

---

## 8) Security notes

- Do not bake secrets into images.
- Use `--env-file` or platform secret stores.
- Restrict management access and protect admin credentials.
- Rotate `SSO_CLIENT_SECRET`, `SESSION_SECRET`, and `AUDIT_LOG_SECRET` regularly.
