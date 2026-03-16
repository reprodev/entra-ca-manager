const { getAccessToken } = require("./auth");
const { graphRequest } = require("./graphClient");

function validateFields(tenantId, clientId, clientSecret) {
  const missing = ["tenantId", "clientId", "clientSecret"].filter((k) => {
    const map = { tenantId, clientId, clientSecret };
    return !map[k] || String(map[k]).trim() === "";
  });

  if (missing.length > 0) {
    return { ok: false, error: `Missing required fields: ${missing.join(", ")}`, statusCode: 400 };
  }

  return { ok: true };
}

function buildEnvHint(tenantId, clientId, tenantName, domain) {
  const lines = [
    "ENABLE_LIVE_GRAPH=true",
    `AZURE_TENANT_ID=${tenantId}`,
    `AZURE_CLIENT_ID=${clientId}`,
    "AZURE_CLIENT_SECRET=<paste-client-secret-here>"
  ];

  if (tenantName) lines.push(`TENANT_NAME=${tenantName}`);
  if (domain) lines.push(`TENANT_DOMAIN=${domain}`);

  return lines.join("\n");
}

function extractOrgInfo(graphData) {
  const org = graphData && Array.isArray(graphData.value) ? graphData.value[0] : null;
  if (!org) return { name: null, domain: null };

  const defaultDomain =
    Array.isArray(org.verifiedDomains)
      ? (org.verifiedDomains.find((d) => d.isDefault) || {}).name || null
      : null;

  return {
    name: org.displayName || null,
    domain: defaultDomain
  };
}

async function validateLiveTenant({ tenantId, clientId, clientSecret, tenantName, domain }, graphBaseUrl) {
  const checks = {
    fieldsPresent: false,
    tokenAcquired: false,
    graphReachable: false,
    orgReadable: false
  };

  const fieldCheck = validateFields(tenantId, clientId, clientSecret);
  if (!fieldCheck.ok) {
    return { ok: false, checks, error: fieldCheck.error, statusCode: fieldCheck.statusCode };
  }

  checks.fieldsPresent = true;

  const tokenResult = await getAccessToken({ tenantId, clientId, clientSecret });
  if (!tokenResult.ok) {
    return {
      ok: false,
      checks,
      error: `Token acquisition failed: ${tokenResult.error}`,
      statusCode: tokenResult.statusCode || 502
    };
  }

  checks.tokenAcquired = true;

  const graphResult = await graphRequest({
    baseUrl: graphBaseUrl,
    token: tokenResult.accessToken,
    path: "organization"
  });

  if (!graphResult.ok) {
    return {
      ok: false,
      checks,
      error: `Graph call failed: ${graphResult.error}`,
      statusCode: graphResult.statusCode || 502
    };
  }

  checks.graphReachable = true;
  checks.orgReadable = true;

  const orgInfo = extractOrgInfo(graphResult.data);
  const resolvedName = orgInfo.name || tenantName || tenantId;
  const resolvedDomain = orgInfo.domain || domain || "";

  return {
    ok: true,
    checks,
    resolvedName,
    resolvedDomain,
    envHint: buildEnvHint(tenantId, clientId, resolvedName, resolvedDomain)
  };
}

module.exports = { validateLiveTenant };
