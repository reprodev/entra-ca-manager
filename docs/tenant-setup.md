# Tenant Setup

## Default (no tenant setup required)

By default, the app runs demo-first:

- tenant: `Kontoso Managed Services`
- domain: `kontoso.com`
- mode: demo

This is ideal for:

- service desk training
- whitelabel forks
- process validation before live tenant onboarding

## Enable live tenant mode

Set:

```env
ENABLE_LIVE_GRAPH=true
```

Then configure either:

### Option A - App registration credentials

```env
AZURE_TENANT_ID=
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
TENANT_NAME=
TENANT_DOMAIN=
```

### Option B - Static token (short-lived/testing)

```env
AZURE_TENANT_ID=
GRAPH_ACCESS_TOKEN=
```

## Multi-tenant setup

Use `TENANTS_JSON`:

```json
[
  {
    "id": "tenant-a",
    "name": "Tenant A",
    "domain": "tenanta.onmicrosoft.com",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "clientId": "11111111-1111-1111-1111-111111111111",
    "clientSecret": "replace-me",
    "isDemo": false
  }
]
```

## Calendar sync setup (optional)

To allow Outlook reminder creation:

```env
ENABLE_CALENDAR_INTEGRATION=true
CALENDAR_TARGET_USER=manager@yourdomain.com
```

Calendar sync uses:

- `GET /api/management/reminders?sync=true`

## SSO and RBAC setup (recommended)

```env
ENABLE_SSO_LOGIN=true
SSO_TENANT_ID=<tenant-id-or-common>
SSO_CLIENT_ID=
SSO_CLIENT_SECRET=
SSO_REDIRECT_URI=https://ca.yourmspdomain.com/auth/callback
AUTH_REQUIRE_LOCAL_USER_FOR_SSO=true
AUTH_REQUIRE_GROUPS=true
AUTH_ADMIN_GROUP_IDS=<entra-group-id-for-admins>
AUTH_ANALYST_GROUP_IDS=<entra-group-id-for-analysts>
```

With this enabled:

- users sign in at `/login`
- analysts can access day-to-day operations pages
- setup validation endpoints/pages are admin-only
- SSO sign-in is denied unless the user exists in local directory

## Local credential setup (optional)

```env
ENABLE_LOCAL_LOGIN=true
LOCAL_BOOTSTRAP_ADMIN_NAME=Local Administrator
LOCAL_BOOTSTRAP_ADMIN_EMAIL=admin@kontoso.com
LOCAL_BOOTSTRAP_ADMIN_PASSWORD=ChangeMeNow123!
AUTH_LOCKOUT_MAX_ATTEMPTS=5
AUTH_LOCKOUT_WINDOW_SECONDS=900
AUTH_LOCKOUT_DURATION_SECONDS=900
AUTH_PASSWORD_MIN_LENGTH=12
```

Then:

- sign in to `/login` using bootstrap admin credentials
- complete forced first-login password reset
- open **Admin** page to create users
- choose per-user sign-in mode (`sso`, `local`, or `either`)
- use admin actions to unlock users and issue reset passwords

## Required Graph permissions

- `Policy.Read.All`
- `Policy.ReadWrite.ConditionalAccess`
- `Directory.Read.All`
- `AuditLog.Read.All`
- `Calendars.ReadWrite` (for reminder sync)

See `graph-permissions.md` for registration steps.
