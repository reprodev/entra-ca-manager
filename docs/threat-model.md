# Threat Model (Current State)

## Scope

Application components:

- browser UI (`login.html`, `index.html`)
- Node API server (`src/server.js`)
- auth/session logic (`src/api/sessionAuth.js`)
- local user store (`src/api/localUsers.js`)
- optional Redis backend (sessions + rate limits)
- optional Key Vault secret hydration

## Assets

- authentication state (sessions, login decisions)
- local user directory metadata
- tenant operation capability (policy/travel/admin actions)
- app secrets and tenant credentials
- audit logs

## Trust boundaries

1. Internet/client to reverse proxy
2. Reverse proxy to app server
3. App server to external services (Graph, Redis, Key Vault)
4. App server to local filesystem (`data/`)

## Primary threat scenarios

- credential stuffing/brute-force on local login
- unauthorized SSO sign-in from unprovisioned users
- stale session reuse after user permission changes
- replay/cache exposure of sensitive auth responses
- secret leakage via repository/history/logs
- tampering with auth/admin logs to hide malicious changes

## Implemented mitigations

- local lockout and strong password policy
- enforced SSO directory guard
- admin mutation and auth route rate limits
- no-store cache headers for auth/session pages/routes
- secure response header baseline + HSTS on HTTPS
- session invalidation on account status/auth/password changes
- tamper-aware audit hash chain for auth/admin actions
- CI security gate (hardening tests, dependency audit, secret scan)
- optional Redis for distributed session/rate-limit consistency
- optional managed identity + Key Vault secret hydration

## Residual risks / backlog

- local user store remains file-based (single write target)
- no dedicated SIEM pipeline yet for audit forwarding
- Redis outage fallback currently degrades to local behavior unless marked required
- CSP remains permissive for inline scripts (UI technical debt)

## Next hardening backlog

- SIEM shipping with alerting on high-risk audit events
- stronger CSP migration (nonce/hash) for inline script removal
- optional encrypted-at-rest local user store
- dedicated threat tests for reverse-proxy misconfiguration
