# Service Desk Analyst Runbook (1st Line)

Audience: 1st line service desk analysts using CA Manager in daily operations.

## Purpose

Use this runbook to:

1. check tenant Conditional Access policy health
2. generate management reminder plans
3. safely use demo mode for training and whitelabel handover
4. understand when to escalate to 2nd line/security engineering

---

## Before you start

You need:

- Node.js 18+
- local clone of this repository
- terminal access (PowerShell or equivalent)

Start the app:

```bash
npm install
npm run dev
```

Open:

- `http://127.0.0.1:3000/login` (SSO environments)
- `http://127.0.0.1:3000` (demo-only environments with SSO disabled)

Access expectations:

- analysts can use daily operations pages
- setup/onboarding pages are admin-only when RBAC is enabled
- login method may be SSO, local credentials, or either (as assigned by admin)
- if using local credentials, lockout policy is `5 attempts / 15 minutes`
- SSO access requires that your account is provisioned in the local directory
- if admin disables your account or resets auth mode, active session is revoked immediately

---

## Step-by-step daily workflow

## Step 1 - Confirm service health

Open:

- `GET /health`

Expected result:

- `ok: true`
- `status: "healthy"`
- `mode: "demo"` for default setup

If unhealthy:

- escalate to engineering with screenshot + timestamp

## Step 2 - Check tenant list

Open:

- `GET /api/tenants`

Expected in default mode:

- tenant domain `kontoso.com`
- mode `demo`

If live mode is enabled, verify the target tenant appears correctly by name/domain.

## Step 3 - Review policy state

Open:

- `GET /api/policies`

Review:

- `policyCount`
- policy `stateLabel` values (`Enabled`, `Report only`, `Disabled`)
- policy summaries for unusual spikes in `Report only` or `Disabled`

## Step 4 - Review management overview

Open:

- `GET /api/management/overview`

Check:

- total policy count
- enabled/report-only/disabled counts
- whether the numbers align with expected tenant posture

## Step 5 - Preview reminders (no calendar writes)

Open:

- `GET /api/management/reminders`

Review:

- `totalReminders`
- reminder titles and dates
- `calendarSync.requested = false` (preview mode)

## Step 6 - (Optional) trigger reminder sync

Only do this when authorized and live mode is enabled.

Open:

- `GET /api/management/reminders?sync=true`

Check response:

- `calendarSync.requested = true`
- `calendarSync.executed = true` (live + integration enabled)
- `createdCount` and `failedCount`

If `executed = false`, read `reason` for configuration or mode issue.

---

## Best practices for 1st line

1. **Preview before sync**
   - always run `/api/management/reminders` first
2. **Use demo mode for training**
   - keep `ENABLE_LIVE_GRAPH=false` outside approved change windows
3. **Treat calendar sync as change activity**
   - capture ticket/reference before running `sync=true`
4. **Escalate on repeated failures**
   - if `failedCount > 0` twice in a row, escalate with JSON response
5. **Do not expose secrets**
   - never share `.env` values in tickets or chat
6. **Use consistent timestamps**
   - include local time + UTC when documenting actions
7. **Handle lockout tickets correctly**
   - do not retry repeatedly after lockout
   - escalate to admin for unlock or reset-password issuance

---

## Escalation triggers

Escalate to 2nd line/security if any of the following happen:

- unknown policies appear unexpectedly
- policy count drops unexpectedly
- repeated calendar sync failures
- unauthorized tenant appears in `/api/tenants`
- live mode appears enabled outside approved window

When escalating, include:

- endpoint used
- full JSON response (redact secrets)
- local timestamp
- expected vs actual behavior

---

## Quick command checklist

```bash
npm run check
npm run e2e:demo
npm run e2e:management
```

Use before handing over to another analyst or before end-of-shift summary.
