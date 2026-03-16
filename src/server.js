const crypto = require("crypto");
const http = require("http");
const path = require("path");
const { readFile } = require("fs/promises");
const { listTenants, findDefaultTenant, findTenantById } = require("./api/tenants");
const { createPoliciesService } = require("./api/policies");
const { buildReminderPlan, summarizePolicies, syncRemindersToCalendar } = require("./api/management");
const { getAuditLogConfig, getCalendarIntegrationConfig, getKeyVaultConfig, getLiveGraphEnabled, getRedisConfig } = require("./api/runtimeConfig");
const { validateLiveTenant } = require("./api/onboarding");
const { listTravelRules, createTravelRule, cancelTravelRule, extendTravelRule, evaluateTravelRules } = require("./api/travelRules");
const { createPolicy, updatePolicy, deletePolicy } = require("./api/policyMutations");
const { createSessionAuth } = require("./api/sessionAuth");
const { createAuditLogger } = require("./api/auditLog");
const { createRateLimiter } = require("./api/rateLimiter");
const { getSharedRedisRuntime } = require("./api/redisRuntime");
const { hydrateSecretsFromKeyVault } = require("./api/keyVaultSecrets");

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin"
};

function applySecurityHeaders(request, response) {
  Object.entries(SECURITY_HEADERS).forEach(([key, value]) => {
    response.setHeader(key, value);
  });

  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const isSecureRequest = Boolean(request.socket && request.socket.encrypted) || forwardedProto === "https";
  if (isSecureRequest) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function applyNoStoreHeaders(response) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
}

function readBody(request, options = {}) {
  const limitBytes = Number.isFinite(Number(options.limitBytes)) ? Number(options.limitBytes) : Infinity;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > limitBytes) {
        tooLarge = true;
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        const error = new Error("Request body too large");
        error.statusCode = 413;
        error.code = "payload_too_large";
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function writeAuthError(response, statusCode, code, message, details = {}) {
  writeJson(response, statusCode, {
    ok: false,
    error: {
      code,
      message,
      ...details
    }
  });
}

async function readJsonBody(request, response, options = {}) {
  let rawBody;
  try {
    rawBody = await readBody(request, options);
  } catch (error) {
    const statusCode = error && error.statusCode ? error.statusCode : 400;
    if (statusCode === 413) {
      writeAuthError(response, 413, "payload_too_large", "Request body exceeds the configured limit.");
    } else {
      writeAuthError(response, 400, "body_read_failed", "Failed to read request body.");
    }
    return { ok: false, payload: null };
  }

  try {
    const parsed = JSON.parse(rawBody || "{}");
    return { ok: true, payload: parsed };
  } catch (_error) {
    writeAuthError(response, 400, "invalid_json", "Request body must be valid JSON.");
    return { ok: false, payload: null };
  }
}

function requestIp(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").trim();
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return String(request.socket && request.socket.remoteAddress ? request.socket.remoteAddress : "unknown");
}

async function writeHtmlFile(response, filename) {
  try {
    const htmlPath = path.resolve(__dirname, "..", filename);
    const html = await readFile(htmlPath, "utf8");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  } catch (error) {
    writeJson(response, 500, { ok: false, error: `Unable to load ${filename}`, details: error.message });
  }
}

function resolveTenantFromRequest(url) {
  let tenantId = url.searchParams.get("tenantId");
  if (!tenantId) {
    const defaultTenant = findDefaultTenant();
    tenantId = defaultTenant ? defaultTenant.id : "";
  }

  if (!tenantId) {
    return {
      ok: false,
      statusCode: 400,
      error: "No tenant available. Configure tenant settings first."
    };
  }

  const tenant = findTenantById(tenantId);
  if (!tenant) {
    return {
      ok: false,
      statusCode: 404,
      error: `Tenant not found: ${tenantId}`
    };
  }

  return { ok: true, tenant };
}

function tenantPublicView(tenant) {
  return {
    id: tenant.id,
    name: tenant.name,
    domain: tenant.domain,
    isDemo: tenant.isDemo
  };
}

function createServer(config = {}) {
  const graphBaseUrl = config.graphBaseUrl || process.env.GRAPH_API_BASE || "https://graph.microsoft.com/v1.0";
  const policiesService = config.policiesService || createPoliciesService({ graphBaseUrl });
  const redisConfig = config.redisConfig || getRedisConfig();
  const redisRuntime = config.redisRuntime || getSharedRedisRuntime(redisConfig);
  const auditLogger = config.auditLogger || createAuditLogger({ config: getAuditLogConfig() });
  const authService = config.authService || createSessionAuth({
    redisConfig,
    redisRuntime,
    auditLogger
  });
  const jsonBodyLimitBytes = Math.max(16 * 1024, Number(authService.authConfig.jsonBodyLimitKb || 64) * 1024);
  const rateWindowMs = Math.max(60 * 1000, Number(authService.authConfig.authRateLimitWindowSeconds || 900) * 1000);
  const authLocalLoginLimiter = createRateLimiter({
    prefix: `${redisConfig.keyPrefix || "cam"}:ratelimit:auth-local-login`,
    windowMs: rateWindowMs,
    maxRequests: authService.authConfig.authRateLimitLocalLoginMax || 12,
    blockMs: rateWindowMs
  }, redisRuntime);
  const authSsoLimiter = createRateLimiter({
    prefix: `${redisConfig.keyPrefix || "cam"}:ratelimit:auth-sso`,
    windowMs: rateWindowMs,
    maxRequests: authService.authConfig.authRateLimitSsoMax || 30,
    blockMs: rateWindowMs
  }, redisRuntime);
  const adminMutationLimiter = createRateLimiter({
    prefix: `${redisConfig.keyPrefix || "cam"}:ratelimit:admin-mutation`,
    windowMs: rateWindowMs,
    maxRequests: authService.authConfig.adminMutationRateLimitMax || 45,
    blockMs: rateWindowMs
  }, redisRuntime);

  function requireAdmin(session) {
    return authService.hasRole(session, "admin");
  }

  function actorFromSession(session) {
    if (!session) {
      return { type: "anonymous", id: "", email: "" };
    }
    return {
      type: authService.hasRole(session, "admin") ? "admin" : "user",
      id: String(session.localUserId || ""),
      email: String(session.email || "")
    };
  }

  async function audit(eventType, outcome, request, details = {}, actor = {}) {
    if (!auditLogger || !auditLogger.enabled) {
      return;
    }

    await auditLogger.log({
      eventType,
      outcome,
      actor: {
        type: String(actor.type || "system"),
        id: String(actor.id || ""),
        email: String(actor.email || "")
      },
      request: {
        ip: requestIp(request),
        userAgent: String(request.headers["user-agent"] || ""),
        requestId: String(request.requestId || ""),
        route: String(request.url || "")
      },
      details
    });
  }

  async function enforceRateLimit(request, response, limiter, bucketPrefix, authPayload = false) {
    if (!authService.authConfig.enabled) {
      return true;
    }

    const key = `${bucketPrefix}:${requestIp(request)}`;
    const result = await limiter.check(key);
    if (!result.limited) {
      return true;
    }

    response.setHeader("Retry-After", String(result.retryAfterSeconds));
    if (authPayload) {
      writeAuthError(response, 429, "rate_limited", "Too many attempts. Please try again later.", {
        retryAfterSeconds: result.retryAfterSeconds
      });
    } else {
      writeJson(response, 429, {
        ok: false,
        error: "Too many requests. Please try again later.",
        code: "rate_limited",
        retryAfterSeconds: result.retryAfterSeconds
      });
    }
    return false;
  }

  async function requestHandler(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    request.requestId = String(request.headers["x-request-id"] || "").trim() || crypto.randomUUID();
    response.setHeader("X-Request-Id", request.requestId);
    applySecurityHeaders(request, response);
    if (url.pathname === "/login" || url.pathname === "/" || url.pathname === "/api/session" || url.pathname.startsWith("/auth/")) {
      applyNoStoreHeaders(response);
    }

    if (request.method === "GET" && url.pathname === "/login") {
      const session = await authService.getSession(request);
      if (session && authService.authConfig.enabled && !session.mustResetPassword) {
        response.writeHead(302, { Location: "/" });
        response.end();
        return;
      }
      await writeHtmlFile(response, "login.html");
      return;
    }

    if (request.method === "GET" && url.pathname === "/auth/status") {
      const session = await authService.getSession(request);
      writeJson(response, 200, {
        ok: true,
        auth: authService.getAuthStatus(),
        session: session
          ? {
              email: session.email,
              authSource: session.authSource,
              mustResetPassword: Boolean(session.mustResetPassword)
            }
          : null
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/auth/login") {
      if (!await enforceRateLimit(request, response, authSsoLimiter, "auth-login", true)) {
        return;
      }
      await authService.handleLogin(request, response, url);
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/local-login") {
      if (!await enforceRateLimit(request, response, authLocalLoginLimiter, "auth-local-login", true)) {
        return;
      }
      const parsed = await readJsonBody(request, response, { limitBytes: jsonBodyLimitBytes });
      if (!parsed.ok) {
        return;
      }
      await authService.handleLocalLogin(request, response, parsed.payload || {});
      return;
    }

    if (request.method === "GET" && url.pathname === "/auth/callback") {
      if (!await enforceRateLimit(request, response, authSsoLimiter, "auth-callback", true)) {
        return;
      }
      await authService.handleCallback(request, response, url);
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/change-password") {
      const authResult = await authService.requireSession(request, response, { api: true, allowPasswordReset: true });
      if (!authResult.ok) {
        return;
      }
      const parsed = await readJsonBody(request, response, { limitBytes: jsonBodyLimitBytes });
      if (!parsed.ok) {
        return;
      }
      await authService.handleChangePassword(request, response, parsed.payload || {});
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/logout") {
      await authService.handleLogout(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/session") {
      await authService.writeSession(response, request);
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      const authResult = await authService.requireSession(request, response, { api: false });
      if (!authResult.ok) {
        return;
      }
      await writeHtmlFile(response, "index.html");
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const tenants = listTenants();
      const authStatus = authService.getAuthStatus();
      writeJson(response, 200, {
        ok: true,
        status: "healthy",
        mode: getLiveGraphEnabled() ? "live" : "demo",
        tenantCount: tenants.length,
        calendarIntegrationEnabled: getCalendarIntegrationConfig().enabled,
        authEnabled: authStatus.enabled,
        authConfigured: authStatus.configured,
        ssoEnabled: authStatus.providers ? authStatus.providers.sso.enabled : false,
        localLoginEnabled: authStatus.providers ? authStatus.providers.local.enabled : false,
        redisEnabled: Boolean(redisRuntime && redisRuntime.enabled),
        auditLogEnabled: Boolean(auditLogger && auditLogger.enabled),
        time: new Date().toISOString()
      });
      return;
    }

    const isApiRoute = url.pathname.startsWith("/api/");
    if (isApiRoute) {
      const authResult = await authService.requireSession(request, response, { api: true });
      if (!authResult.ok) {
        return;
      }
      request.userSession = authResult.session;
    }

    if (request.method === "GET" && url.pathname === "/api/tenants") {
      writeJson(response, 200, { ok: true, tenants: listTenants() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/policies") {
      const tenantResult = resolveTenantFromRequest(url);
      if (!tenantResult.ok) {
        writeJson(response, tenantResult.statusCode, { ok: false, error: tenantResult.error });
        return;
      }

      const includeRaw = url.searchParams.get("includeRaw") === "true";
      const result = await policiesService.listPolicies(tenantResult.tenant, { includeRaw });
      if (!result.ok) {
        writeJson(response, result.statusCode || 502, { ok: false, error: result.error });
        return;
      }

      writeJson(response, 200, {
        ok: true,
        mode: result.mode || "unknown",
        tenant: tenantPublicView(tenantResult.tenant),
        policyCount: result.policyCount || result.policies.length,
        tokenSource: result.tokenSource || "unknown",
        policies: result.policies
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/policies") {
      const tenantResult = resolveTenantFromRequest(url);
      if (!tenantResult.ok) {
        writeJson(response, tenantResult.statusCode, { ok: false, error: tenantResult.error });
        return;
      }
      let rawBody;
      try { rawBody = await readBody(request); } catch (_) {
        writeJson(response, 400, { ok: false, error: "Failed to read request body" });
        return;
      }
      let payload;
      try { payload = JSON.parse(rawBody); } catch (_) {
        writeJson(response, 400, { ok: false, error: "Request body must be valid JSON" });
        return;
      }
      const result = await createPolicy(tenantResult.tenant, payload || {}, graphBaseUrl);
      writeJson(response, result.ok ? 201 : result.statusCode || 400, result);
      return;
    }

    const policyIdMatch = url.pathname.match(/^\/api\/policies\/([^/]+)$/);
    if (policyIdMatch) {
      const policyId = decodeURIComponent(policyIdMatch[1]);
      const tenantResult = resolveTenantFromRequest(url);
      if (!tenantResult.ok) {
        writeJson(response, tenantResult.statusCode, { ok: false, error: tenantResult.error });
        return;
      }

      if (request.method === "PATCH") {
        let rawBody;
        try { rawBody = await readBody(request); } catch (_) {
          writeJson(response, 400, { ok: false, error: "Failed to read request body" });
          return;
        }
        let payload;
        try { payload = JSON.parse(rawBody); } catch (_) {
          writeJson(response, 400, { ok: false, error: "Request body must be valid JSON" });
          return;
        }
        const result = await updatePolicy(tenantResult.tenant, policyId, payload || {}, graphBaseUrl);
        writeJson(response, result.ok ? 200 : result.statusCode || 400, result);
        return;
      }

      if (request.method === "DELETE") {
        const result = await deletePolicy(tenantResult.tenant, policyId, graphBaseUrl);
        writeJson(response, result.ok ? 200 : result.statusCode || 400, result);
        return;
      }

      writeJson(response, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/management/overview") {
      const tenantResult = resolveTenantFromRequest(url);
      if (!tenantResult.ok) {
        writeJson(response, tenantResult.statusCode, { ok: false, error: tenantResult.error });
        return;
      }

      const result = await policiesService.listPolicies(tenantResult.tenant, { includeRaw: false });
      if (!result.ok) {
        writeJson(response, result.statusCode || 502, { ok: false, error: result.error });
        return;
      }

      writeJson(response, 200, {
        ok: true,
        mode: result.mode || "unknown",
        tenant: tenantPublicView(tenantResult.tenant),
        summary: summarizePolicies(result.policies),
        policyCount: result.policyCount || result.policies.length
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/management/reminders") {
      const tenantResult = resolveTenantFromRequest(url);
      if (!tenantResult.ok) {
        writeJson(response, tenantResult.statusCode, { ok: false, error: tenantResult.error });
        return;
      }

      const policiesResult = await policiesService.listPolicies(tenantResult.tenant, { includeRaw: false });
      if (!policiesResult.ok) {
        writeJson(response, policiesResult.statusCode || 502, { ok: false, error: policiesResult.error });
        return;
      }

      const reminderPlan = buildReminderPlan(tenantResult.tenant, policiesResult.policies);
      const syncRequested = url.searchParams.get("sync") === "true";

      let calendarSync = {
        requested: false,
        executed: false,
        deduplicated: false,
        reason: "Preview only (sync not requested).",
        createdCount: 0,
        skippedCount: 0,
        failedCount: 0,
        createdEvents: [],
        skippedEvents: [],
        failures: []
      };

      if (syncRequested) {
        const syncResult = await syncRemindersToCalendar({
          tenant: tenantResult.tenant,
          reminders: reminderPlan.reminders,
          graphBaseUrl
        });

        calendarSync = {
          requested: true,
          executed: syncResult.executed,
          deduplicated: syncResult.deduplicated,
          reason: syncResult.reason,
          createdCount: syncResult.createdCount,
          skippedCount: syncResult.skippedCount,
          failedCount: syncResult.failedCount,
          createdEvents: syncResult.createdEvents,
          skippedEvents: syncResult.skippedEvents,
          failures: syncResult.failures
        };
      }

      writeJson(response, 200, {
        ok: true,
        mode: policiesResult.mode || "unknown",
        tenant: tenantPublicView(tenantResult.tenant),
        reminderPlan: {
          generatedAt: reminderPlan.generatedAt,
          policySummary: reminderPlan.policySummary,
          calendarConfig: reminderPlan.calendarConfig,
          totalReminders: reminderPlan.reminders.length,
          reminders: reminderPlan.reminders
        },
        calendarSync
      });
      return;
    }

    // ── Travel rules ──────────────────────────────────────────────────────────

    if (request.method === "GET" && url.pathname === "/api/admin/access-model") {
      if (!requireAdmin(request.userSession)) {
        await audit("admin_access_model", "denied", request, { code: "admin_role_required" }, actorFromSession(request.userSession));
        writeJson(response, 403, { ok: false, error: "Administrator role required." });
        return;
      }

      const authStatus = authService.getAuthStatus();
      writeJson(response, 200, {
        ok: true,
        auth: authStatus,
        rbac: {
          requireGroups: authService.authConfig.requireGroups,
          adminGroupIds: authService.authConfig.adminGroupIds,
          analystGroupIds: authService.authConfig.analystGroupIds,
          requireUserDirectoryForSso: true
        },
        deployment: {
          liveGraphEnabled: getLiveGraphEnabled(),
          calendarIntegrationEnabled: getCalendarIntegrationConfig().enabled
        }
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/users") {
      if (!requireAdmin(request.userSession)) {
        await audit("admin_users_list", "denied", request, { code: "admin_role_required" }, actorFromSession(request.userSession));
        writeJson(response, 403, { ok: false, error: "Administrator role required." });
        return;
      }

      const users = await authService.listManagedUsers();
      writeJson(response, 200, { ok: true, count: users.length, users });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/users") {
      if (!requireAdmin(request.userSession)) {
        await audit("admin_user_create", "denied", request, { code: "admin_role_required" }, actorFromSession(request.userSession));
        writeJson(response, 403, { ok: false, error: "Administrator role required." });
        return;
      }

      if (!await enforceRateLimit(request, response, adminMutationLimiter, "admin-users-mutation")) {
        return;
      }
      const parsed = await readJsonBody(request, response, { limitBytes: jsonBodyLimitBytes });
      if (!parsed.ok) {
        return;
      }

      const result = await authService.createManagedUser(parsed.payload || {});
      await audit("admin_user_create", result.ok ? "success" : "failure", request, {
        statusCode: result.ok ? 201 : result.statusCode || 400,
        targetEmail: result.user ? result.user.email : String((parsed.payload || {}).email || ""),
        code: result.code || ""
      }, actorFromSession(request.userSession));
      writeJson(response, result.ok ? 201 : result.statusCode || 400, result);
      return;
    }

    const adminUserResetPasswordMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/);
    if (adminUserResetPasswordMatch) {
      if (!requireAdmin(request.userSession)) {
        await audit("admin_user_reset_password", "denied", request, { code: "admin_role_required" }, actorFromSession(request.userSession));
        writeJson(response, 403, { ok: false, error: "Administrator role required." });
        return;
      }

      if (request.method !== "POST") {
        writeJson(response, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      if (!await enforceRateLimit(request, response, adminMutationLimiter, "admin-users-mutation")) {
        return;
      }
      const parsed = await readJsonBody(request, response, { limitBytes: jsonBodyLimitBytes });
      if (!parsed.ok) {
        return;
      }

      const userId = decodeURIComponent(adminUserResetPasswordMatch[1]);
      const result = await authService.resetManagedUserPassword(userId, parsed.payload || {});
      await audit("admin_user_reset_password", result.ok ? "success" : "failure", request, {
        statusCode: result.ok ? 200 : result.statusCode || 400,
        targetUserId: userId,
        targetEmail: result.user ? result.user.email : "",
        code: result.code || ""
      }, actorFromSession(request.userSession));
      writeJson(response, result.ok ? 200 : result.statusCode || 400, result);
      return;
    }

    const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (adminUserMatch) {
      if (!requireAdmin(request.userSession)) {
        await audit("admin_user_update", "denied", request, { code: "admin_role_required" }, actorFromSession(request.userSession));
        writeJson(response, 403, { ok: false, error: "Administrator role required." });
        return;
      }

      const userId = decodeURIComponent(adminUserMatch[1]);
      if (request.method !== "PATCH") {
        writeJson(response, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      if (!await enforceRateLimit(request, response, adminMutationLimiter, "admin-users-mutation")) {
        return;
      }
      const parsed = await readJsonBody(request, response, { limitBytes: jsonBodyLimitBytes });
      if (!parsed.ok) {
        return;
      }

      const result = await authService.updateManagedUser(userId, parsed.payload || {});
      await audit("admin_user_update", result.ok ? "success" : "failure", request, {
        statusCode: result.ok ? 200 : result.statusCode || 400,
        targetUserId: userId,
        targetEmail: result.user ? result.user.email : "",
        code: result.code || ""
      }, actorFromSession(request.userSession));
      writeJson(response, result.ok ? 200 : result.statusCode || 400, result);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/travel") {
      const tenantId = url.searchParams.get("tenantId") || "";
      const rules = listTravelRules(tenantId ? { tenantId } : {});
      writeJson(response, 200, { ok: true, count: rules.length, rules });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/travel") {
      let rawBody;
      try { rawBody = await readBody(request); } catch (_) {
        writeJson(response, 400, { ok: false, error: "Failed to read request body" });
        return;
      }
      let payload;
      try { payload = JSON.parse(rawBody); } catch (_) {
        writeJson(response, 400, { ok: false, error: "Request body must be valid JSON" });
        return;
      }
      const result = createTravelRule(payload || {});
      writeJson(response, result.ok ? 201 : result.statusCode || 400, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/travel/tick") {
      const tickResult = await evaluateTravelRules({
        tenantResolver: findTenantById,
        graphBaseUrl
      });
      writeJson(response, 200, tickResult);
      return;
    }

    const travelIdMatch = url.pathname.match(/^\/api\/travel\/([^/]+)$/);
    if (travelIdMatch) {
      const ruleId = decodeURIComponent(travelIdMatch[1]);

      if (request.method === "DELETE") {
        const result = cancelTravelRule(ruleId);
        writeJson(response, result.ok ? 200 : result.statusCode || 400, result);
        return;
      }

      writeJson(response, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    const travelExtendMatch = url.pathname.match(/^\/api\/travel\/([^/]+)\/extend$/);
    if (travelExtendMatch) {
      const ruleId = decodeURIComponent(travelExtendMatch[1]);

      if (request.method === "POST") {
        let rawBody;
        try { rawBody = await readBody(request); } catch (_) {
          writeJson(response, 400, { ok: false, error: "Failed to read request body" });
          return;
        }
        let payload;
        try { payload = JSON.parse(rawBody); } catch (_) {
          writeJson(response, 400, { ok: false, error: "Request body must be valid JSON" });
          return;
        }
        const result = extendTravelRule(ruleId, (payload && payload.returnDate) || "");
        writeJson(response, result.ok ? 200 : result.statusCode || 400, result);
        return;
      }

      writeJson(response, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    // ─────────────────────────────────────────────────────────────────────────

    if (request.method === "POST" && url.pathname === "/api/onboarding/validate") {
      if (!requireAdmin(request.userSession)) {
        writeJson(response, 403, { ok: false, error: "Administrator role required." });
        return;
      }

      let rawBody;
      try {
        rawBody = await readBody(request);
      } catch (_err) {
        writeJson(response, 400, { ok: false, error: "Failed to read request body" });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (_err) {
        writeJson(response, 400, { ok: false, error: "Request body must be valid JSON" });
        return;
      }

      if (!payload || typeof payload !== "object") {
        writeJson(response, 400, { ok: false, error: "Request body must be a JSON object" });
        return;
      }

      const result = await validateLiveTenant(
        {
          tenantId: String(payload.tenantId || ""),
          clientId: String(payload.clientId || ""),
          clientSecret: String(payload.clientSecret || ""),
          tenantName: String(payload.tenantName || ""),
          domain: String(payload.domain || "")
        },
        graphBaseUrl
      );

      writeJson(response, result.ok ? 200 : result.statusCode || 502, result);
      return;
    }

    writeJson(response, 404, { ok: false, error: "Route not found" });
  }

  const server = http.createServer((request, response) => {
    requestHandler(request, response).catch((error) => {
      writeJson(response, 500, { ok: false, error: "Unhandled server error", details: error.message });
    });
  });

  return server;
}

async function startServer() {
  const keyVaultResult = await hydrateSecretsFromKeyVault({ config: getKeyVaultConfig() });
  if (keyVaultResult.enabled && !keyVaultResult.ok) {
    throw new Error(`Failed to hydrate secrets from Key Vault: ${keyVaultResult.errors.join("; ")}`);
  }
  if (keyVaultResult.enabled) {
    process.stdout.write(`Key Vault hydration complete (loaded=${keyVaultResult.loadedCount}, skipped=${keyVaultResult.skippedCount}).\n`);
  }

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "0.0.0.0";
  const server = createServer();

  server.listen(port, host, () => {
    process.stdout.write(`CA Manager scaffold listening at http://${host}:${port}\n`);
  });

  return { server, port, host };
}

if (require.main === module) {
  startServer().catch((error) => {
    process.stderr.write(`Server startup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createServer,
  startServer
};
