# Outlook Calendar Integration Plan (Graph API)

## Objective

Provide management visibility by creating automated Outlook calendar reminders from Conditional Access policy state.

## Scope

- source: CA policy state from `/api/policies`
- output: calendar events in Outlook via Microsoft Graph
- audience: service desk + management reviewers

---

## Delivery phases

## Phase 1 - Foundation (implemented)

Status: ✅ Complete

Delivered:

1. reminder planning route:
   - `GET /api/management/reminders`
2. optional sync trigger:
   - `GET /api/management/reminders?sync=true`
3. live-mode guardrails:
   - sync skipped in demo mode
   - sync skipped when integration disabled
4. config-driven calendar behavior:
   - target mailbox/user
   - review cadence days
   - event time and duration
5. response telemetry:
   - created/failed counts
   - failure details

## Phase 2 - Operational hardening (next)

Status: ⏳ Planned

Planned improvements:

1. idempotent duplicate prevention against existing events
2. stronger retry/backoff policy specific to event create route
3. event correlation IDs for incident tracing
4. audit endpoint for last sync result

## Phase 3 - Analyst UX and governance (next)

Status: ⏳ Planned

Planned improvements:

1. explicit approval token for sync endpoint
2. service desk guided UI flow (preview -> approve -> sync)
3. management dashboard widget for reminder health
4. exportable sync report (CSV/JSON)

---

## Environment configuration

Core switches:

```env
ENABLE_LIVE_GRAPH=true
ENABLE_CALENDAR_INTEGRATION=true
CALENDAR_TARGET_USER=manager@yourdomain.com
```

Recommended baseline:

```env
CALENDAR_TIMEZONE=UTC
CALENDAR_STANDARD_REVIEW_DAYS=30
CALENDAR_REPORT_ONLY_REVIEW_DAYS=3
CALENDAR_DISABLED_REVIEW_DAYS=7
```

---

## Permissions checklist (Graph)

Minimum for current implementation:

- `Policy.Read.All` (policy read)
- `Policy.ReadWrite.ConditionalAccess` (future CRUD alignment)
- `Calendars.ReadWrite` (calendar event create/update)
- `Directory.Read.All` (tenant object context)

---

## Operational procedure

1. Preview reminders:
   - call `GET /api/management/reminders`
2. Validate reminder plan and counts
3. Trigger sync during approved window:
   - call `GET /api/management/reminders?sync=true`
4. Record `createdCount`, `failedCount`, and any failure messages
5. Escalate failures > 0 to 2nd line

---

## Success metrics

- 100% preview success in demo mode
- >95% successful calendar creates in live mode
- reduced missed policy review actions
- faster management visibility of policy posture changes
