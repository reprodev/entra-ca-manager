const { getDemoTenant } = require("./demoData");

function normalizeText(value) {
  return String(value || "").trim();
}

function parseTenantsJson() {
  const raw = process.env.TENANTS_JSON;
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function singleTenantFromEnv() {
  const tenantId = normalizeText(process.env.AZURE_TENANT_ID);
  const clientId = normalizeText(process.env.AZURE_CLIENT_ID);
  const clientSecret = normalizeText(process.env.AZURE_CLIENT_SECRET);
  const accessToken = normalizeText(process.env.GRAPH_ACCESS_TOKEN);

  if (!tenantId) {
    return null;
  }

  if ((!clientId || !clientSecret) && !accessToken) {
    return null;
  }

  return {
    id: tenantId,
    name: normalizeText(process.env.TENANT_NAME) || "Configured Tenant",
    domain: normalizeText(process.env.TENANT_DOMAIN),
    tenantId,
    clientId,
    clientSecret,
    accessToken,
    status: "unknown",
    isDemo: false
  };
}

function sanitizeTenant(inputTenant) {
  const tenantId = normalizeText(inputTenant.tenantId);
  const id = normalizeText(inputTenant.id) || tenantId || normalizeText(inputTenant.domain).toLowerCase();
  const domain = normalizeText(inputTenant.domain).toLowerCase();

  if (!id) {
    return null;
  }

  return {
    id,
    name: normalizeText(inputTenant.name),
    domain,
    tenantId,
    clientId: normalizeText(inputTenant.clientId),
    clientSecret: normalizeText(inputTenant.clientSecret),
    accessToken: normalizeText(inputTenant.accessToken),
    status: normalizeText(inputTenant.status) || "unknown",
    isDemo: Boolean(inputTenant.isDemo)
  };
}

function dedupeTenants(tenants) {
  const result = [];
  const seen = new Set();

  for (const tenant of tenants) {
    const dedupeKey = [tenant.id, tenant.tenantId, tenant.domain]
      .filter(Boolean)
      .join("|")
      .toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    result.push(tenant);
  }

  return result;
}

function allTenantsWithSecrets() {
  const fromJson = parseTenantsJson()
    .map(sanitizeTenant)
    .filter(Boolean);
  const single = sanitizeTenant(singleTenantFromEnv() || {});
  const configuredTenants = single ? [...fromJson, single] : fromJson;
  const deduped = dedupeTenants(configuredTenants);

  if (deduped.length > 0) {
    return deduped;
  }

  return [sanitizeTenant(getDemoTenant())].filter(Boolean);
}

function toPublicTenant(tenant) {
  return {
    id: tenant.id,
    name: tenant.name,
    domain: tenant.domain,
    tenantId: tenant.tenantId,
    status: tenant.status,
    mode: tenant.isDemo ? "demo" : "live"
  };
}

function listTenants() {
  return allTenantsWithSecrets().map(toPublicTenant);
}

function findDefaultTenant() {
  const tenants = allTenantsWithSecrets();
  return tenants.length > 0 ? tenants[0] : null;
}

function findTenantById(tenantId) {
  const normalized = normalizeText(tenantId).toLowerCase();
  if (!normalized) {
    return null;
  }

  return (
    allTenantsWithSecrets().find((tenant) => {
      const candidates = [tenant.id, tenant.tenantId, tenant.domain]
        .filter(Boolean)
        .map((value) => value.toLowerCase());
      return candidates.includes(normalized);
    }) || null
  );
}

module.exports = {
  listTenants,
  findDefaultTenant,
  findTenantById
};
