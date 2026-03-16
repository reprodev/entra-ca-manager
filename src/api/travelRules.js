const crypto = require("crypto");
const { getAccessToken } = require("./auth");
const { graphRequest } = require("./graphClient");
const { getLiveGraphEnabled } = require("./runtimeConfig");

// ── In-memory store ───────────────────────────────────────────────────────────

const ruleStore = [];
let storeSeeded = false;

const DEMO_RULES = [
  {
    id: "travel-demo-001",
    tenantId: "kontoso-demo-tenant",
    userId: "s.mitchell",
    userName: "Sarah Mitchell",
    userEmail: "s.mitchell@kontoso.com",
    fromCountry: "United Kingdom",
    toCountries: ["Spain"],
    departureDate: "2026-03-13",
    returnDate: "2026-03-20",
    policyIds: ["kontoso-policy-003"],
    travelAction: "enabled",
    revertAction: "enabledForReportingButNotEnforced",
    status: "active",
    activatedAt: "2026-03-13T09:00:00.000Z",
    completedAt: null,
    notes: "Conference travel"
  },
  {
    id: "travel-demo-002",
    tenantId: "kontoso-demo-tenant",
    userId: "t.reyes",
    userName: "Tom Reyes",
    userEmail: "t.reyes@kontoso.com",
    fromCountry: "United Kingdom",
    toCountries: ["UAE"],
    departureDate: "2026-03-10",
    returnDate: "2026-03-14",
    policyIds: ["kontoso-policy-003"],
    travelAction: "enabled",
    revertAction: "enabledForReportingButNotEnforced",
    status: "expiring",
    activatedAt: "2026-03-10T09:00:00.000Z",
    completedAt: null,
    notes: "Business trip"
  },
  {
    id: "travel-demo-003",
    tenantId: "kontoso-demo-tenant",
    userId: "y.tanaka",
    userName: "Yuki Tanaka",
    userEmail: "y.tanaka@kontoso.com",
    fromCountry: "United Kingdom",
    toCountries: ["Japan"],
    departureDate: "2026-03-12",
    returnDate: "2026-03-22",
    policyIds: ["kontoso-policy-003"],
    travelAction: "enabled",
    revertAction: "enabledForReportingButNotEnforced",
    status: "active",
    activatedAt: "2026-03-12T09:00:00.000Z",
    completedAt: null,
    notes: "Extended business travel"
  }
];

function ensureSeeded() {
  if (!storeSeeded) {
    for (const rule of DEMO_RULES) {
      ruleStore.push(Object.assign({}, rule));
    }
    storeSeeded = true;
  }
}

// Test helper — resets store to fresh seed state
function _resetStore() {
  ruleStore.length = 0;
  storeSeeded = false;
}

// ── Validation helpers ────────────────────────────────────────────────────────

const VALID_STATES = ["enabled", "disabled", "enabledForReportingButNotEnforced"];
const EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

function normalizeText(value) {
  return String(value || "").trim();
}

function toDateOnly(value) {
  const s = normalizeText(value);
  if (!s) return null;
  const d = new Date(s.length === 10 ? s + "T00:00:00Z" : s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function generateId() {
  return "travel-" + crypto.randomBytes(6).toString("hex");
}

// ── Status computation ────────────────────────────────────────────────────────

function computeLiveStatus(rule, now) {
  if (rule.status === "cancelled" || rule.status === "completed") {
    return rule.status;
  }

  const departure = new Date(rule.departureDate + "T00:00:00Z").getTime();
  const returnMs = new Date(rule.returnDate + "T00:00:00Z").getTime();
  const nowMs = now.getTime();

  if (nowMs >= returnMs) return "completed";
  if (nowMs >= departure) {
    return returnMs - nowMs <= EXPIRY_WARNING_MS ? "expiring" : "active";
  }
  return "scheduled";
}

function travelProgress(departureDate, returnDate, now) {
  const dep = new Date(departureDate + "T00:00:00Z").getTime();
  const ret = new Date(returnDate + "T00:00:00Z").getTime();
  const nowMs = now.getTime();
  if (nowMs <= dep) return 0;
  if (nowMs >= ret) return 100;
  return Math.round(((nowMs - dep) / (ret - dep)) * 100);
}

function toPublicRule(rule, now) {
  const base = {
    id: rule.id,
    tenantId: rule.tenantId,
    userId: rule.userId,
    userName: rule.userName,
    userEmail: rule.userEmail,
    fromCountry: rule.fromCountry,
    toCountries: rule.toCountries,
    departureDate: rule.departureDate,
    returnDate: rule.returnDate,
    policyIds: rule.policyIds,
    travelAction: rule.travelAction,
    revertAction: rule.revertAction,
    status: rule.status,
    activatedAt: rule.activatedAt,
    completedAt: rule.completedAt,
    notes: rule.notes
  };

  if (now) {
    base.progressPct = travelProgress(rule.departureDate, rule.returnDate, now);
  }

  return base;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

function listTravelRules({ tenantId } = {}, now = new Date()) {
  ensureSeeded();
  const rules = tenantId ? ruleStore.filter((r) => r.tenantId === tenantId) : ruleStore.slice();
  return rules.map((r) => toPublicRule(r, now));
}

function findRule(id) {
  ensureSeeded();
  return ruleStore.find((r) => r.id === id) || null;
}

function createTravelRule(input) {
  const departureDate = toDateOnly(input.departureDate);
  const returnDate = toDateOnly(input.returnDate);

  if (!normalizeText(input.tenantId)) {
    return { ok: false, error: "tenantId is required", statusCode: 400 };
  }
  if (!normalizeText(input.userEmail)) {
    return { ok: false, error: "userEmail is required", statusCode: 400 };
  }
  if (!departureDate) {
    return { ok: false, error: "departureDate is required (YYYY-MM-DD)", statusCode: 400 };
  }
  if (!returnDate) {
    return { ok: false, error: "returnDate is required (YYYY-MM-DD)", statusCode: 400 };
  }
  if (returnDate <= departureDate) {
    return { ok: false, error: "returnDate must be after departureDate", statusCode: 400 };
  }

  const travelAction = normalizeText(input.travelAction) || "enabled";
  const revertAction = normalizeText(input.revertAction) || "enabledForReportingButNotEnforced";

  if (!VALID_STATES.includes(travelAction)) {
    return { ok: false, error: `travelAction must be one of: ${VALID_STATES.join(", ")}`, statusCode: 400 };
  }
  if (!VALID_STATES.includes(revertAction)) {
    return { ok: false, error: `revertAction must be one of: ${VALID_STATES.join(", ")}`, statusCode: 400 };
  }

  ensureSeeded();

  const rule = {
    id: generateId(),
    tenantId: normalizeText(input.tenantId),
    userId: normalizeText(input.userId),
    userName: normalizeText(input.userName),
    userEmail: normalizeText(input.userEmail),
    fromCountry: normalizeText(input.fromCountry),
    toCountries: Array.isArray(input.toCountries) ? input.toCountries.map(String) : [],
    departureDate,
    returnDate,
    policyIds: Array.isArray(input.policyIds) ? input.policyIds.map(String) : [],
    travelAction,
    revertAction,
    status: "scheduled",
    activatedAt: null,
    completedAt: null,
    notes: normalizeText(input.notes)
  };

  ruleStore.push(rule);
  return { ok: true, rule: toPublicRule(rule, new Date()) };
}

function cancelTravelRule(id) {
  const rule = findRule(id);
  if (!rule) {
    return { ok: false, error: `Travel rule not found: ${id}`, statusCode: 404 };
  }
  if (rule.status === "completed" || rule.status === "cancelled") {
    return { ok: false, error: `Cannot cancel a rule with status: ${rule.status}`, statusCode: 409 };
  }
  rule.status = "cancelled";
  return { ok: true, rule: toPublicRule(rule, new Date()) };
}

function extendTravelRule(id, newReturnDate) {
  const rule = findRule(id);
  if (!rule) {
    return { ok: false, error: `Travel rule not found: ${id}`, statusCode: 404 };
  }
  if (rule.status === "completed" || rule.status === "cancelled") {
    return { ok: false, error: `Cannot extend a rule with status: ${rule.status}`, statusCode: 409 };
  }
  const normalized = toDateOnly(newReturnDate);
  if (!normalized) {
    return { ok: false, error: "returnDate is required (YYYY-MM-DD)", statusCode: 400 };
  }
  if (normalized <= rule.departureDate) {
    return { ok: false, error: "New returnDate must be after departureDate", statusCode: 400 };
  }
  rule.returnDate = normalized;
  rule.status = computeLiveStatus(rule, new Date());
  return { ok: true, rule: toPublicRule(rule, new Date()) };
}

// ── Policy mutation (live mode) ───────────────────────────────────────────────

async function patchPolicyState(tenant, policyId, state, graphBaseUrl) {
  const tokenResult = await getAccessToken(tenant);
  if (!tokenResult.ok) {
    return { ok: false, error: `Token error: ${tokenResult.error}`, statusCode: tokenResult.statusCode || 502 };
  }

  const result = await graphRequest({
    baseUrl: graphBaseUrl,
    token: tokenResult.accessToken,
    path: `/identity/conditionalAccess/policies/${encodeURIComponent(policyId)}`,
    method: "PATCH",
    body: { state }
  });

  if (!result.ok) {
    return { ok: false, error: result.error, statusCode: result.statusCode || 502 };
  }

  return { ok: true };
}

// ── Scheduler tick ────────────────────────────────────────────────────────────

async function evaluateTravelRules({ tenantResolver, graphBaseUrl, now = new Date() } = {}) {
  ensureSeeded();

  const isLive = getLiveGraphEnabled();
  const activated = [];
  const completed = [];
  const errors = [];

  for (const rule of ruleStore) {
    if (rule.status === "cancelled" || rule.status === "completed") continue;

    const next = computeLiveStatus(rule, now);

    // scheduled → completed: both departure and return already passed (rule was never activated)
    if (rule.status === "scheduled" && next === "completed") {
      rule.status = "completed";
      rule.completedAt = now.toISOString();
      // No policy action — the rule was never active so there is nothing to revert
      continue;
    }

    // scheduled → active/expiring: departure has arrived
    if (rule.status === "scheduled" && (next === "active" || next === "expiring")) {
      rule.status = next;
      rule.activatedAt = now.toISOString();

      if (isLive && rule.policyIds.length > 0 && tenantResolver) {
        const tenant = tenantResolver(rule.tenantId);
        for (const policyId of rule.policyIds) {
          const result = await patchPolicyState(tenant, policyId, rule.travelAction, graphBaseUrl);
          if (result.ok) {
            activated.push({ ruleId: rule.id, policyId, action: rule.travelAction });
          } else {
            errors.push({ ruleId: rule.id, policyId, error: result.error });
          }
        }
      } else {
        activated.push({ ruleId: rule.id, policyIds: rule.policyIds, action: rule.travelAction, mode: "demo" });
      }
      continue;
    }

    // active/expiring → completed: return date has passed
    if ((rule.status === "active" || rule.status === "expiring") && next === "completed") {
      rule.status = "completed";
      rule.completedAt = now.toISOString();

      if (isLive && rule.policyIds.length > 0 && tenantResolver) {
        const tenant = tenantResolver(rule.tenantId);
        for (const policyId of rule.policyIds) {
          const result = await patchPolicyState(tenant, policyId, rule.revertAction, graphBaseUrl);
          if (result.ok) {
            completed.push({ ruleId: rule.id, policyId, action: rule.revertAction });
          } else {
            errors.push({ ruleId: rule.id, policyId, error: result.error });
          }
        }
      } else {
        completed.push({ ruleId: rule.id, policyIds: rule.policyIds, action: rule.revertAction, mode: "demo" });
      }
      continue;
    }

    // active → expiring: update badge only, no policy action
    if (rule.status === "active" && next === "expiring") {
      rule.status = "expiring";
    }
  }

  return {
    ok: true,
    evaluatedAt: now.toISOString(),
    mode: isLive ? "live" : "demo",
    activatedCount: activated.length,
    completedCount: completed.length,
    errorCount: errors.length,
    activated,
    completed,
    errors
  };
}

module.exports = {
  listTravelRules,
  createTravelRule,
  cancelTravelRule,
  extendTravelRule,
  evaluateTravelRules,
  _resetStore
};
