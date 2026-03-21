# Docker Deployment Guide

Audience: MSP admins and platform engineers deploying `entra-ca-manager` in containers.

---

## 1) Prerequisites

- Docker Engine and Docker Compose plugin installed
- A prepared `.env` file with deployment values
- Access to this repository only if you plan to build locally from source

Optional but recommended for production:

- Reverse proxy with TLS termination (Nginx, Traefik, IIS ARR, or Azure front end)
- External Redis for multi-instance session/rate-limit state

---

## 2) Quick start (single container)

### Option A: build locally from the repository

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

### Option B: run the published GHCR image

Use the published image when you want to deploy without cloning the repository:

```bash
docker pull ghcr.io/reprodev/entra-ca-manager:latest
docker run --name entra-ca-manager --detach \
  -p 3000:3000 \
  --env-file .env \
  -e NODE_ENV=production \
  -v entra_ca_data:/app/data \
  ghcr.io/reprodev/entra-ca-manager:latest
```

If the package is private, authenticate first:

```bash
docker login ghcr.io
```

Published GHCR images currently target `linux/amd64` and include provenance/SBOM metadata.

To pin to a release instead of the moving `:latest` tag, use a published version tag such as `:v0.1.0`. Immutable `:sha-<shortsha>` tags are also published for commit-specific pinning.

---

## 3) Docker Compose workflows

### Option A: repo-local build workflow

The tracked `docker-compose.yml` in the repository builds from the local checkout:

```bash
docker compose --env-file .env up -d --build
```

### Option B: hosted-image workflow

Save the following as `compose.ghcr.yml` on any target host:

```yaml
services:
  entra-ca-manager:
    image: ghcr.io/reprodev/entra-ca-manager:latest
    container_name: entra-ca-manager
    env_file:
      - .env
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: 3000
    volumes:
      - entra_ca_data:/app/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1));"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

volumes:
  entra_ca_data:
```

Start the hosted-image deployment:

```bash
docker compose -f compose.ghcr.yml pull
docker compose -f compose.ghcr.yml up -d
```

Inspect status:

```bash
docker compose -f compose.ghcr.yml ps
docker compose -f compose.ghcr.yml logs -f
```

Stop services:

```bash
docker compose -f compose.ghcr.yml down
```

Both compose options mount persistent app data to `/app/data` using volume `entra_ca_data`.

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

Hosted-image deployment:

```bash
docker compose -f compose.ghcr.yml pull
docker compose -f compose.ghcr.yml up -d
```

Local build deployment from a repo checkout:

```bash
docker compose up -d --build
```

Post-upgrade checks:

1. `docker compose ps` shows `healthy` status.
2. `GET /health` returns expected auth/runtime mode.
3. Admin and analyst sign-in paths still function.

---

## 7) Release operations and GHCR publishing

### Tag model

| Trigger | Tags produced | Notes |
| --- | --- | --- |
| Push to `main` | `latest`, `sha-<shortsha>` | `:latest` always tracks `main` HEAD |
| Push a `v*` git tag | `v<version>`, `sha-<shortsha>` | Version tag mirrors the git tag exactly |

All images currently target `linux/amd64`. Build provenance attestations and SBOM metadata are published with each image artifact.

### When to push a release tag

1. Merge the feature branch to `main` via PR (CI Security Gate must pass).
2. Confirm the `latest` image published correctly (see verification steps below).
3. Push a semver tag from `main` to trigger the versioned release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Do not push tags from feature branches — the workflow only produces a clean version image when the tag points to a commit already on `main`.

### Verifying published images

After a `main` push or version tag push, confirm the expected tags are pullable:

```bash
# latest (from main push)
docker pull ghcr.io/reprodev/entra-ca-manager:latest

# version tag (from vX.Y.Z tag push)
docker pull ghcr.io/reprodev/entra-ca-manager:v0.1.0

# immutable SHA tag (use the short SHA from the commit or workflow run)
docker pull ghcr.io/reprodev/entra-ca-manager:sha-c8b582f
```

To inspect the image manifest and confirm provenance/SBOM metadata is attached:

```bash
docker buildx imagetools inspect ghcr.io/reprodev/entra-ca-manager:latest
```

If the GHCR package is private, authenticate first:

```bash
docker login ghcr.io
```

To allow unauthenticated pulls, set the package visibility to **Public** in GitHub → Packages → Package settings after the first publish.

### Branch protection and publish gate

To prevent unreviewed code from publishing a new `:latest` image, enable branch protection on `main` (PR required, at least one review). The publish workflow only runs after merge.

---

## 8) Troubleshooting

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

## 9) Security notes

- Do not bake secrets into images.
- Use `--env-file` or platform secret stores.
- Restrict management access and protect admin credentials.
- Rotate `SSO_CLIENT_SECRET`, `SESSION_SECRET`, and `AUDIT_LOG_SECRET` regularly.
