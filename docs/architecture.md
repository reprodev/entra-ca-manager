# Architecture

## Current topology

- `index.html` provides a lightweight local landing page
- `src/server.js` hosts API routes
- `src/api/*` modules contain domain logic
- demo seed data is provided by `src/api/demoData.js`

## Runtime modes

### Demo mode (default)

- no live credentials required
- `kontoso.com` demo tenant is auto-loaded
- policy and management routes operate on demo data

### Live mode (opt-in)

- enabled with `ENABLE_LIVE_GRAPH=true`
- uses tenant credentials or static token for Graph calls
- policy routes operate against real tenant data

### SSO + RBAC mode (opt-in, recommended for production)

- enabled with `ENABLE_SSO_LOGIN=true`
- login flow handled by Microsoft identity platform (`/login`, `/auth/login`, `/auth/callback`)
- in-app session cookie gates dashboard/API access
- SSO directory guard is enforced (user must exist in local directory)
- RBAC roles mapped from Entra group IDs:
  - `AUTH_ADMIN_GROUP_IDS`
  - `AUTH_ANALYST_GROUP_IDS`
- setup endpoints are admin-only (`/api/onboarding/validate`, `/api/admin/access-model`)

### Local credential mode (opt-in)

- enabled with `ENABLE_LOCAL_LOGIN=true`
- local users are provisioned by admins in-app
- per-user auth mode supports `sso`, `local`, or `either`
- user directory stored at `data/local-users.json` (gitignored)
- admin-only user management endpoints:
  - `GET /api/admin/users`
  - `POST /api/admin/users`
  - `PATCH /api/admin/users/:id`
  - `POST /api/admin/users/:id/reset-password`
- local login hardening defaults:
  - forced reset for bootstrap admin (`mustResetPassword`)
  - lockout `5 attempts / 15 min`, lock `15 min`
  - password policy minimum 12 chars with upper/lower/number/symbol

## Domain modules

- `auth.js` - token acquisition (MSAL/static token)
- `graphClient.js` - Graph requests with timeout/retry controls
- `tenants.js` - tenant normalization, dedupe, default resolution
- `policies.js` - policy fetch + normalization mapping
- `management.js` - policy summaries, reminder planning, calendar sync
- `runtimeConfig.js` - typed environment config parsing
- `localUsers.js` - local user storage, password hashing, auth mode + RBAC groups
- `sessionAuth.js` - SSO login, cookie sessions, role mapping, access checks
- `redisRuntime.js` - optional Redis connectivity for distributed auth/rate-limit state
- `rateLimiter.js` - in-memory/Redis-backed limiter abstraction
- `auditLog.js` - tamper-aware auth/admin audit log chain
- `keyVaultSecrets.js` - startup secret hydration from Azure Key Vault

## Management reminder flow

1. resolve tenant
2. read policy set
3. build policy summary and reminder plan
4. optionally sync reminders to Outlook via Graph

## Reliability controls

- configurable Graph timeout (`GRAPH_REQUEST_TIMEOUT_MS`)
- configurable retries (`GRAPH_MAX_RETRIES`)
- retries for HTTP `429` and `5xx`
- safe fallback to preview-only when calendar sync is not enabled
- optional Redis-backed distributed session + rate-limit state (`REDIS_ENABLED=true`)
- resilient local fallback when Redis is unavailable and not required

## Security controls

- global response security headers (CSP, frame, referrer, content-type, permissions)
- sensitive route cache controls (`no-store` for login/session/auth flows)
- HSTS emitted when requests are served over HTTPS or trusted `x-forwarded-proto=https`
- request size limit for auth/admin JSON mutation routes (`AUTH_JSON_BODY_LIMIT_KB`, default 64KB)
- auth/admin rate limits (in-memory by default, Redis-backed when enabled) for:
  - `/auth/local-login`
  - `/auth/login`
  - `/auth/callback`
  - admin user mutation routes
- local user store atomic write strategy (`temp + rename`) with backup fallback (`.bak`)
- local password reuse protection for user change/reset operations
- admin mutation events revoke active sessions for the target local user
- tamper-aware JSONL audit log hash chain for auth/admin events
- optional managed-identity Key Vault secret hydration at startup
