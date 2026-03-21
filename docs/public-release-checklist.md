# Public Release Checklist

Use this quick checklist before changing the repository visibility to public.

## 1) Security and data hygiene

- [x] Confirm `.env`, key files, and credential artifacts are gitignored.
- [x] Run a secret scan against the full git history — manual pattern scan clean; CI workflow runs `gitleaks` on every push/PR.
- [x] Confirm no customer tenant IDs, domains, emails, or policy names are committed.
- [x] Keep demo defaults enabled (`ENABLE_LIVE_GRAPH=false`).
- [x] Keep auth defaults demo-safe (`ENABLE_SSO_LOGIN=false`, `ENABLE_LOCAL_LOGIN=false`).
- [ ] Set a non-default `AUDIT_LOG_SECRET` and `SESSION_SECRET` for non-demo deployments. _(deployer responsibility — documented in `.env.example`)_

## 2) Repository hygiene

- [x] Ensure `README.md` setup steps work on a clean machine.
- [x] Keep `LICENSE` present and aligned with `README.md`.
- [x] Ensure docs reflect demo-first behavior and live mode is clearly opt-in.
- [x] Remove or redact any internal-only notes before release.
- [x] Keep `SECURITY.md`, `docs/incident-response.md`, and `docs/threat-model.md` current.

## 3) Quality gates

- [x] Run `npm run check`.
- [x] Run `npm run e2e:demo`.
- [x] Run `npm run e2e:policies`.
- [x] Run `npm run e2e:management`.
- [ ] Run `npm run e2e:calendar:live` only when live test prerequisites are available.
- [x] Run `npm run e2e:auth:hardening`.
- [x] Run `npm run audit:verify` (audit chain integrity check).
- [x] Verify auth/cache/session hardening behavior in e2e output (session revocation + no-store headers + password reuse block).

## 4) GitHub hardening

- [ ] Enable branch protection on `main` (PR required, no direct pushes).
- [ ] Require at least one review for merges to `main`.
- [ ] Enable Dependabot security updates and alerts.
- [ ] Enable the CI Security Gate workflow as a required check.

## 5) Release handoff

- [ ] Create PR from your feature branch to `main` with validation output attached.
- [ ] Add release notes summarizing demo mode, live mode, and calendar sync behavior.
- [ ] After merge to `main`, confirm `ghcr.io/reprodev/entra-ca-manager:latest` is pullable.
- [ ] After merge to `main`, confirm `ghcr.io/reprodev/entra-ca-manager:sha-<shortsha>` is pullable.
- [ ] Push a semver tag from `main` to publish the versioned image (for example: `git tag v0.1.0 && git push origin v0.1.0`).
- [ ] Confirm `ghcr.io/reprodev/entra-ca-manager:v0.1.0` is pullable after the tag workflow completes.
- [ ] Run `docker buildx imagetools inspect ghcr.io/reprodev/entra-ca-manager:v0.1.0` to confirm provenance/SBOM metadata is present.
