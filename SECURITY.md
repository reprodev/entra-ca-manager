# Security Policy

## Supported versions

Releases are published from `main`. Feature work is done on short-lived branches and merged via PR.

Security fixes are applied to the latest `main` release.

## Reporting a vulnerability

Please do **not** open public GitHub issues for sensitive findings.

Use one of these channels:

1. Open a private security advisory in GitHub (preferred).
2. Contact the repository maintainers directly via your MSP security contact path.

When reporting, include:

- affected version/commit
- reproduction steps
- impact assessment
- suggested mitigation (if available)

## Response targets

- Initial triage acknowledgement: within 2 business days
- Severity classification and owner assignment: within 5 business days
- Remediation timeline:
  - Critical: immediate hotfix planning
  - High: next scheduled patch or sooner
  - Medium/Low: planned backlog with mitigation guidance

## Security controls currently in place

- Demo-first defaults with auth disabled unless explicitly enabled
- Directory-guarded dual auth (`SSO` + `local`)
- Local password policy + lockout
- Auth/admin rate limiting
- Security headers + no-store cache controls on sensitive routes
- Tamper-aware auth/admin audit logging chain
- Session revocation on admin account mutation
- CI security gate (check + hardening e2e + dependency audit + secret scan)
