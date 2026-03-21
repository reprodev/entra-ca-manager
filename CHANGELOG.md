# Changelog

All notable changes to this project will be documented in this file.

---

## [0.1.0] — 2026-03-21

### Added

**Core application**
- Multi-tenant dashboard for managing Azure Conditional Access policies across MSP client tenants
- Full CA policy CRUD wired to Microsoft Graph API (`/identity/conditionalAccess/policies`)
- Travel-based access rules — Named Location + CA policy enable/disable on departure/return schedule
- Demo-first mode with `kontoso.com` seed data; no credentials required to evaluate the app
- Live-mode opt-in via `ENABLE_LIVE_GRAPH=true` and Azure App Registration credentials

**Authentication**
- Microsoft Entra SSO (MSAL client-credential flow) with Entra group-to-role mapping
- Local auth (email/password) with scrypt hashing, lockout, and password-reset-on-first-login
- Session revocation on admin account mutation
- Per-route RBAC (`admin` / `analyst` roles)
- Tamper-aware JSONL audit log chain (HMAC integrity)

**Infrastructure**
- Optional Redis session store for distributed/multi-instance deployments
- Optional Azure Key Vault secret hydration at startup
- Auth and admin mutation rate limiting (Redis-backed or in-memory)
- Security headers, HSTS, no-store cache controls on sensitive routes
- `/health` endpoint for load balancer and container health checks

**Calendar integration**
- Duplicate-safe idempotent Outlook calendar sync via Microsoft Graph (`/users/{id}/events`)
- Policy reminder planning with configurable review windows

**Deployment**
- Docker image published to GHCR (`ghcr.io/reprodev/entra-ca-manager`)
  - `latest` tag tracks `main`; semver tags (`v0.1.0`) published on git tag push
  - Immutable `sha-<shortsha>` tags for commit-pinned deployments
  - `linux/amd64` target; SBOM and provenance attestation published
- Docker Compose workflows: local build and hosted-image (GHCR)
- RDS / Azure Virtual Desktop: RemoteApp deployment via Edge in app mode (no packaging required)

**CI / quality gates**
- CI Security Gate: syntax check, demo e2e, auth hardening e2e, dependency audit, Gitleaks secret scan
- All GitHub Actions pinned to commit SHA
- Automated GHCR publish on merge to `main` and on `v*` tag push

**Documentation**
- `docs/admin-deployment-guide.md` — full App Service and on-prem deployment walkthrough
- `docs/docker-deployment-guide.md` — Docker, Compose, GHCR, and release operations
- `docs/rds-remoteapp-deployment-guide.md` — RDS / AVD RemoteApp deployment
- `docs/service-desk-analyst-runbook.md` — 1st-line operations guide
- `docs/tenant-setup.md`, `docs/architecture.md`, `docs/threat-model.md`, `docs/incident-response.md`
- `docs/keyvault-rotation-runbook.md`, `docs/calendar-integration-plan.md`
- `graph-permissions.md` — Azure App Registration setup guide

---

[0.1.0]: https://github.com/reprodev/entra-ca-manager/releases/tag/v0.1.0
