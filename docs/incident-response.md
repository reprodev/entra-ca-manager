# Incident Response Notes

## Purpose

This runbook outlines first actions when CA Manager security, auth, or tenant-control behavior appears compromised.

## Severity guide

- **SEV-1**: active unauthorized access, credential compromise, or data exfiltration risk
- **SEV-2**: suspected auth bypass, repeated lockout abuse, or CI security gate critical failure
- **SEV-3**: isolated suspicious behavior without confirmed impact

## Immediate containment steps

1. Restrict ingress at reverse proxy/WAF if active abuse is ongoing.
2. Disable risky auth path if needed (`ENABLE_LOCAL_LOGIN=false` or `ENABLE_SSO_LOGIN=false`) while preserving access for responders.
3. Rotate affected secrets:
   - `SESSION_SECRET`
   - `SSO_CLIENT_SECRET`
   - any tenant app credentials
4. Force user session revocation:
   - update user records (`status` flip or reset-password flow) to invalidate sessions.

## Evidence collection

Collect and preserve:

- app logs
- CI workflow results
- `data/audit/auth-admin-audit.log.jsonl`
- reverse proxy access logs
- timestamps and request IDs from impacted flows

Do not modify original evidence files before copying a forensic snapshot.

## Audit log verification

Auth/admin actions are recorded with hash chaining for tamper awareness.

If tampering is suspected:

1. compare hash continuity between entries
2. validate chronology with reverse proxy logs
3. preserve both primary and backup files

## Recovery steps

1. Patch/fix root cause in `dev`.
2. Re-run hardening checks:
   - `npm run check`
   - `npm run e2e:auth:hardening`
3. Validate auth and admin behavior in staging.
4. Release via PR to `main` with incident context.
5. Communicate impact/remediation to stakeholders.

## Post-incident review

Within 5 business days capture:

- timeline
- contributing factors
- controls that worked/failed
- required backlog actions (tests, docs, monitoring, policy)
