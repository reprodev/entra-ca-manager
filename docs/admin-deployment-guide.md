# Admin Deployment Guide (Azure + On-Prem)  

Audience: MSP platform admins deploying CA Manager for service desk users.

---

## 1) Target architecture

Use this role model:

- **Admin users**: onboarding, tenant setup, RBAC oversight, live-mode validation
- **Service Desk Analysts**: daily operations, policy/travel monitoring, reminder workflows

Authentication model:

- Microsoft SSO and/or local credential login at `/login`
- RBAC with `admins` and `analysts` access groups
- App session required before dashboard/API access

---

## 2) Prerequisites

- Node.js 18+
- Entra ID tenant with Global Admin or App Admin rights
- DNS record for your app FQDN (for example `ca.yourmspdomain.com`)
- TLS certificate for that FQDN
- This repository deployed to your host

---

## 3) Create Entra app registration (SSO)

1. Go to **Entra admin center → App registrations → New registration**.
2. Name it (example: `CA Manager MSP`).
3. Supported account type:
   - single tenant for internal MSP use
   - multi-tenant if you intentionally support external identities
4. Add redirect URI (Web):
   - `https://<your-fqdn>/auth/callback`
5. Create a client secret and copy the secret value.
6. Copy:
   - Tenant ID
   - Application (client) ID
   - Client secret value

---

## 4) Create RBAC groups and assign users

Create two security groups in Entra ID:

- `CA-Manager-Admins`
- `CA-Manager-Analysts`

Add users:

- Platform/security admins into `CA-Manager-Admins`
- Service desk users into `CA-Manager-Analysts`

Copy both group object IDs. These are used by:

- `AUTH_ADMIN_GROUP_IDS`
- `AUTH_ANALYST_GROUP_IDS`

---

## 5) Configure application settings

Use environment variables (or App Settings in Azure):

```env
ENABLE_SSO_LOGIN=true
SSO_TENANT_ID=<tenant-id-or-common>
SSO_CLIENT_ID=<app-client-id>
SSO_CLIENT_SECRET=<app-client-secret>
SSO_REDIRECT_URI=https://<your-fqdn>/auth/callback
SSO_POST_LOGOUT_REDIRECT_URI=https://<your-fqdn>/login
SESSION_SECRET=<long-random-secret>
SESSION_TTL_HOURS=8
SESSION_COOKIE_SECURE=true
AUTH_REQUIRE_GROUPS=true
AUTH_ADMIN_GROUP_IDS=<admin-group-object-id>
AUTH_ANALYST_GROUP_IDS=<analyst-group-object-id>
ENABLE_LOCAL_LOGIN=true
LOCAL_BOOTSTRAP_ADMIN_NAME=Local Administrator
LOCAL_BOOTSTRAP_ADMIN_EMAIL=admin@kontoso.com
LOCAL_BOOTSTRAP_ADMIN_PASSWORD=ChangeMeNow123!
AUTH_REQUIRE_LOCAL_USER_FOR_SSO=true
AUTH_LOCKOUT_MAX_ATTEMPTS=5
AUTH_LOCKOUT_WINDOW_SECONDS=900
AUTH_LOCKOUT_DURATION_SECONDS=900
AUTH_PASSWORD_MIN_LENGTH=12
AUTH_RATE_LIMIT_WINDOW_SECONDS=900
AUTH_RATE_LIMIT_LOCAL_LOGIN_MAX=12
AUTH_RATE_LIMIT_SSO_MAX=30
AUTH_RATE_LIMIT_ADMIN_MUTATION_MAX=45
AUTH_JSON_BODY_LIMIT_KB=64
AUDIT_LOG_ENABLED=true
AUDIT_LOG_SECRET=<long-random-secret>
```

Live tenant mode (optional):

```env
ENABLE_LIVE_GRAPH=true
AZURE_TENANT_ID=<tenant-id>
AZURE_CLIENT_ID=<graph-app-id>
AZURE_CLIENT_SECRET=<graph-app-secret>
```

Distributed/multi-instance mode (optional, recommended on Azure):

```env
REDIS_ENABLED=true
REDIS_URL=rediss://<redis-endpoint>:6380
REDIS_REQUIRED=true
REDIS_KEY_PREFIX=cam-prod
```

Managed identity + Key Vault secret hydration (optional):

```env
ENABLE_KEYVAULT_SECRETS=true
KEYVAULT_URL=https://<your-vault>.vault.azure.net/
KEYVAULT_SECRET_MAPPINGS=SESSION_SECRET=ca-session-secret,SSO_CLIENT_SECRET=ca-sso-client-secret,AZURE_CLIENT_SECRET=ca-graph-client-secret
KEYVAULT_OVERRIDE_EXISTING=false
```

Local user directory notes:

- user records are stored in `data/local-users.json`
- this file is intentionally gitignored
- every provisioned user can be set to:
  - `sso` (Microsoft sign-in only)
  - `local` (email/password only)
  - `either` (both options)

---

## 6) Provision users (admin dashboard)

1. Sign in as bootstrap admin via `/login` using local credentials.
2. Complete the forced password reset.
3. Open **Admin** page.
4. Add users:
   - display name
   - email
   - access group (`admins` or `analysts`)
   - auth mode (`sso`, `local`, `either`)
   - password (required for `local`/`either`)
5. Use table actions to:
   - enable/disable users
   - force password reset
   - unlock locked users
   - issue admin reset passwords
6. For SSO users, keep email/UPN aligned with Entra account sign-in name.

---

## 7) Deploy option A (recommended): Azure App Service

1. Create an App Service (Linux, Node 18+ runtime).
2. Deploy code from GitHub or zip package.
3. Add all environment variables in **Configuration → Application settings**.
4. Configure custom domain:
   - `ca.yourmspdomain.com`
5. Bind managed TLS certificate or uploaded certificate.
6. Ensure reverse proxy/front-end sends `X-Forwarded-Proto=https` so HTTPS hardening headers are applied correctly.
7. Restart App Service.
8. Confirm:
   - `https://<your-fqdn>/login` loads
   - SSO redirect/callback succeeds
   - `GET /health` returns `ssoEnabled=true`

---

## 8) Deploy option B: On-prem VM (IIS/Nginx reverse proxy)

1. Build Windows/Linux VM on internal network.
2. Install Node.js 18+ and clone repo.
3. Set environment variables in system service config.
4. Run app behind reverse proxy (IIS ARR, Nginx, or Apache):
   - proxy `https://<fqdn>` to local Node port (default `3000`)
   - enforce HTTPS only
   - forward `X-Forwarded-Proto=https`
5. Install TLS cert on the proxy.
6. Ensure firewall allows only approved ingress.
7. Validate login path and callback URL on final FQDN.

---

## 9) Post-deployment validation checklist

1. Admin account can log in and see:
   - **Live Setup**
   - **Admin** page
2. Analyst account can log in and does **not** see admin-only setup pages.
3. Admin endpoint works for admin only:
   - `GET /api/admin/access-model`
4. Onboarding endpoint returns `403` for analysts:
   - `POST /api/onboarding/validate`
5. Main operations pages still work for analysts:
   - tenants/policies/travel/schedule/users/alerts

---

## 10) Ongoing admin operations

- Grant/revoke access using **Admin** page user provisioning.
- Keep Entra group assignments aligned for SSO-only users.
- Rotate `SSO_CLIENT_SECRET` and app secrets on schedule.
- Use admin reset-password flow for credential recovery.
- User status/auth-mode/password reset changes immediately revoke active sessions for that user.
- Backup `data/local-users.json` and `data/local-users.json.bak` in your ops rotation.
- Backup and monitor `data/audit/auth-admin-audit.log.jsonl`; validate chain with `npm run audit:verify`.
- Keep `main` branch protected; merge through PR only.
- Use `docs/public-release-checklist.md` before major release.
- For managed identity deployments, follow `docs/keyvault-rotation-runbook.md`.

---

## 11) Common issues

- **Login loop to `/login`**  
  Check `SSO_REDIRECT_URI` exactly matches app registration.

- **Access denied after sign-in**  
  Confirm user exists in local directory and auth mode allows selected sign-in method.

- **Local login fails for all users**  
  Check bootstrap/local user settings and confirm `data/local-users.json` is writable.

- **Cookie/session not sticking**  
  Ensure HTTPS is used when `SESSION_COOKIE_SECURE=true`.

- **Admin can’t use Live Setup**  
  Verify account includes admin RBAC group and refresh session (sign out/in).
