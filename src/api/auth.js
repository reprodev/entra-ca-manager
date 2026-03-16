const { ConfidentialClientApplication } = require("@azure/msal-node");

const clientCache = new Map();
const tokenCache = new Map();

function validateTenantCredentials(tenant) {
  if (!tenant) {
    return { ok: false, error: "Tenant details are required", statusCode: 400 };
  }

  const missingFields = ["tenantId", "clientId", "clientSecret"].filter((field) => !tenant[field]);
  if (missingFields.length > 0) {
    return { ok: false, error: `Missing tenant fields: ${missingFields.join(", ")}`, statusCode: 400 };
  }

  return { ok: true };
}

function cacheKey(tenant) {
  return `${tenant.tenantId}:${tenant.clientId}`;
}

function getGraphScope() {
  return process.env.GRAPH_SCOPE || "https://graph.microsoft.com/.default";
}

function getStaticToken(tenant) {
  if (tenant && typeof tenant.accessToken === "string" && tenant.accessToken.length > 0) {
    return tenant.accessToken;
  }

  if (typeof process.env.GRAPH_ACCESS_TOKEN === "string" && process.env.GRAPH_ACCESS_TOKEN.length > 0) {
    return process.env.GRAPH_ACCESS_TOKEN;
  }

  return null;
}

function getMsalClient(tenant) {
  const key = cacheKey(tenant);
  const existing = clientCache.get(key);
  if (existing) {
    return existing;
  }

  const authority = `https://login.microsoftonline.com/${tenant.tenantId}`;
  const client = new ConfidentialClientApplication({
    auth: {
      clientId: tenant.clientId,
      authority,
      clientSecret: tenant.clientSecret
    }
  });

  clientCache.set(key, client);
  return client;
}

function getCachedToken(tenant) {
  const key = cacheKey(tenant);
  const cached = tokenCache.get(key);
  if (!cached) {
    return null;
  }

  const now = Date.now();
  const skewMs = 120000;
  if (cached.expiresOnTimestamp > now + skewMs) {
    return cached.accessToken;
  }

  tokenCache.delete(key);
  return null;
}

function cacheToken(tenant, tokenResponse) {
  if (!tokenResponse || !tokenResponse.accessToken || !tokenResponse.expiresOn) {
    return;
  }

  const expiresOnTimestamp = tokenResponse.expiresOn.getTime();
  tokenCache.set(cacheKey(tenant), {
    accessToken: tokenResponse.accessToken,
    expiresOnTimestamp
  });
}

function formatAuthError(error) {
  if (!error) {
    return "Unable to acquire Graph access token";
  }

  if (typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }

  return "Unable to acquire Graph access token";
}

async function getAccessToken(tenant) {
  if (!tenant) {
    return { ok: false, error: "Tenant details are required", statusCode: 400 };
  }

  const staticToken = getStaticToken(tenant);
  if (staticToken) {
    return { ok: true, accessToken: staticToken, source: "static" };
  }

  const validation = validateTenantCredentials(tenant);
  if (!validation.ok) {
    return validation;
  }

  const cachedToken = getCachedToken(tenant);
  if (cachedToken) {
    return { ok: true, accessToken: cachedToken, source: "cache" };
  }

  try {
    const client = getMsalClient(tenant);
    const tokenResponse = await client.acquireTokenByClientCredential({
      scopes: [getGraphScope()]
    });

    if (!tokenResponse || !tokenResponse.accessToken) {
      return { ok: false, error: "MSAL returned no access token", statusCode: 502 };
    }

    cacheToken(tenant, tokenResponse);
    return { ok: true, accessToken: tokenResponse.accessToken, source: "msal" };
  } catch (error) {
    return { ok: false, error: formatAuthError(error), statusCode: 502 };
  }
}

module.exports = {
  getAccessToken,
  validateTenantCredentials
};
