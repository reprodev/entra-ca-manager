const crypto = require("crypto");
const { getAccessToken } = require("./auth");
const { graphRequest } = require("./graphClient");
const { getLiveGraphEnabled } = require("./runtimeConfig");
const { mapPolicy } = require("./policies");

const VALID_STATES = ["enabled", "disabled", "enabledForReportingButNotEnforced"];

function isDemoMode(tenant) {
  return !tenant || tenant.isDemo || !getLiveGraphEnabled();
}

// ── Create ────────────────────────────────────────────────────────────────────

async function createPolicy(tenant, payload, graphBaseUrl) {
  const displayName = String(payload.displayName || "").trim();
  if (!displayName) {
    return { ok: false, error: "displayName is required", statusCode: 400 };
  }

  const state = String(payload.state || "disabled").trim();
  if (!VALID_STATES.includes(state)) {
    return { ok: false, error: `state must be one of: ${VALID_STATES.join(", ")}`, statusCode: 400 };
  }

  if (isDemoMode(tenant)) {
    const demoPolicy = {
      id: "demo-" + crypto.randomBytes(4).toString("hex"),
      displayName,
      description: String(payload.description || "").trim(),
      state,
      createdDateTime: new Date().toISOString(),
      modifiedDateTime: new Date().toISOString(),
      conditions: payload.conditions || {},
      grantControls: payload.grantControls || null,
      sessionControls: payload.sessionControls || null
    };
    return { ok: true, mode: "demo", policy: mapPolicy(demoPolicy) };
  }

  const tokenResult = await getAccessToken(tenant);
  if (!tokenResult.ok) {
    return { ok: false, error: `Token error: ${tokenResult.error}`, statusCode: tokenResult.statusCode || 502 };
  }

  const body = { displayName, state };
  if (payload.description) body.description = String(payload.description).trim();
  if (payload.conditions) body.conditions = payload.conditions;
  if (payload.grantControls) body.grantControls = payload.grantControls;
  if (payload.sessionControls) body.sessionControls = payload.sessionControls;

  const result = await graphRequest({
    baseUrl: graphBaseUrl,
    token: tokenResult.accessToken,
    path: "/identity/conditionalAccess/policies",
    method: "POST",
    body
  });

  if (!result.ok) {
    return { ok: false, error: result.error, statusCode: result.statusCode || 502 };
  }

  return { ok: true, mode: "live", policy: mapPolicy(result.data) };
}

// ── Update (PATCH) ────────────────────────────────────────────────────────────

async function updatePolicy(tenant, policyId, patch, graphBaseUrl) {
  if (!policyId) {
    return { ok: false, error: "policyId is required", statusCode: 400 };
  }

  if (!patch || typeof patch !== "object" || Object.keys(patch).length === 0) {
    return { ok: false, error: "At least one field required (state, displayName, description)", statusCode: 400 };
  }

  if (patch.state !== undefined && !VALID_STATES.includes(patch.state)) {
    return { ok: false, error: `state must be one of: ${VALID_STATES.join(", ")}`, statusCode: 400 };
  }

  if (isDemoMode(tenant)) {
    // Demo mode: return a simulated updated policy shape (no persistence)
    const simulated = {
      id: policyId,
      displayName: patch.displayName || "Updated Policy",
      description: patch.description || "",
      state: patch.state || "disabled",
      createdDateTime: null,
      modifiedDateTime: new Date().toISOString(),
      conditions: patch.conditions || {},
      grantControls: patch.grantControls || null,
      sessionControls: patch.sessionControls || null
    };
    return { ok: true, mode: "demo", policy: mapPolicy(simulated) };
  }

  const tokenResult = await getAccessToken(tenant);
  if (!tokenResult.ok) {
    return { ok: false, error: `Token error: ${tokenResult.error}`, statusCode: tokenResult.statusCode || 502 };
  }

  const result = await graphRequest({
    baseUrl: graphBaseUrl,
    token: tokenResult.accessToken,
    path: `/identity/conditionalAccess/policies/${encodeURIComponent(policyId)}`,
    method: "PATCH",
    body: patch
  });

  if (!result.ok) {
    return { ok: false, error: result.error, statusCode: result.statusCode || 502 };
  }

  return { ok: true, mode: "live", policy: mapPolicy(result.data) };
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function deletePolicy(tenant, policyId, graphBaseUrl) {
  if (!policyId) {
    return { ok: false, error: "policyId is required", statusCode: 400 };
  }

  if (isDemoMode(tenant)) {
    return { ok: true, mode: "demo", policyId };
  }

  const tokenResult = await getAccessToken(tenant);
  if (!tokenResult.ok) {
    return { ok: false, error: `Token error: ${tokenResult.error}`, statusCode: tokenResult.statusCode || 502 };
  }

  const result = await graphRequest({
    baseUrl: graphBaseUrl,
    token: tokenResult.accessToken,
    path: `/identity/conditionalAccess/policies/${encodeURIComponent(policyId)}`,
    method: "DELETE"
  });

  if (!result.ok) {
    return { ok: false, error: result.error, statusCode: result.statusCode || 502 };
  }

  return { ok: true, mode: "live", policyId };
}

module.exports = {
  createPolicy,
  updatePolicy,
  deletePolicy
};
