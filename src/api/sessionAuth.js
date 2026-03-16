const crypto = require("crypto");
const { ConfidentialClientApplication } = require("@azure/msal-node");
const { getAuthConfig, getRedisConfig } = require("./runtimeConfig");
const { createLocalUserDirectory, roleListFromGroups } = require("./localUsers");
const { getSharedRedisRuntime } = require("./redisRuntime");

const SESSION_COOKIE_NAME = "cam_sid";
const AUTH_SCOPES = ["openid", "profile", "email", "User.Read"];

function base64UrlToken(bytes = 32) {
  return crypto
    .randomBytes(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseCookies(request) {
  const header = request && request.headers ? request.headers.cookie || "" : "";
  if (!header) {
    return {};
  }

  return header.split(";").reduce((cookies, part) => {
    const segment = part.trim();
    if (!segment) {
      return cookies;
    }

    const eqIndex = segment.indexOf("=");
    const key = eqIndex >= 0 ? segment.slice(0, eqIndex) : segment;
    const rawValue = eqIndex >= 0 ? segment.slice(eqIndex + 1) : "";
    cookies[key] = decodeURIComponent(rawValue);
    return cookies;
  }, {});
}

function setCookie(response, name, value, options = {}) {
  const attributes = [`${name}=${encodeURIComponent(value)}`];
  attributes.push(`Path=${options.path || "/"}`);

  if (options.maxAge !== undefined) {
    attributes.push(`Max-Age=${Math.max(0, Number(options.maxAge) || 0)}`);
  }

  if (options.httpOnly !== false) {
    attributes.push("HttpOnly");
  }

  if (options.sameSite) {
    attributes.push(`SameSite=${options.sameSite}`);
  }

  if (options.secure) {
    attributes.push("Secure");
  }

  response.setHeader("Set-Cookie", attributes.join("; "));
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function authErrorPayload(code, message, details = {}) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...details
    }
  };
}

function writeAuthError(response, statusCode, code, message, details = {}) {
  writeJson(response, statusCode, authErrorPayload(code, message, details));
}

function safeReturnTo(value) {
  const candidate = String(value || "").trim();
  if (!candidate.startsWith("/")) {
    return "/";
  }

  if (candidate.startsWith("//")) {
    return "/";
  }

  return candidate;
}

function getMissingSsoConfig(config) {
  const missing = [];
  if (!config.clientId) {
    missing.push("SSO_CLIENT_ID");
  }
  if (!config.clientSecret) {
    missing.push("SSO_CLIENT_SECRET");
  }
  if (!config.redirectUri) {
    missing.push("SSO_REDIRECT_URI");
  }
  return missing;
}

function createSessionStateStore(options = {}) {
  const redisRuntime = options.redisRuntime;
  const sessionTtlSeconds = Math.max(60, Number(options.sessionTtlSeconds) || 8 * 60 * 60);
  const stateTtlSeconds = Math.max(60, Number(options.stateTtlSeconds) || 10 * 60);

  if (redisRuntime && redisRuntime.enabled) {
    const fallbackStore = createSessionStateStore({
      sessionTtlSeconds,
      stateTtlSeconds
    });
    const prefix = String(redisRuntime.keyPrefix || "cam");
    const keySession = (sessionId) => `${prefix}:session:${sessionId}`;
    const keyState = (stateValue) => `${prefix}:state:${stateValue}`;
    const keyUserSessions = (localUserId) => `${prefix}:session-user:${localUserId}`;

    async function saveSession(session) {
      await fallbackStore.saveSession(session);
      const sessionId = String(session.id || "");
      if (!sessionId) {
        return;
      }

      await redisRuntime.execute(async (client) => {
        await client.set(keySession(sessionId), JSON.stringify(session), { EX: sessionTtlSeconds });
        if (session.localUserId) {
          const userIndexKey = keyUserSessions(session.localUserId);
          await client.sAdd(userIndexKey, sessionId);
          await client.expire(userIndexKey, sessionTtlSeconds + 3600);
        }
      });
    }

    async function getSession(sessionId) {
      const sid = String(sessionId || "");
      if (!sid) {
        return null;
      }

      const result = await redisRuntime.execute(async (client) => {
        const raw = await client.get(keySession(sid));
        if (!raw) {
          return { found: false, session: null };
        }

        try {
          return { found: true, session: JSON.parse(raw) };
        } catch (_error) {
          await client.del(keySession(sid));
          return { found: false, session: null };
        }
      });

      if (!result) {
        return fallbackStore.getSession(sid);
      }

      if (!result.found || !result.session) {
        await fallbackStore.deleteSession(sid);
        return null;
      }

      await fallbackStore.saveSession(result.session);
      return result.session;
    }

    async function deleteSession(sessionId, localUserId = "") {
      const sid = String(sessionId || "");
      if (!sid) {
        return;
      }

      await fallbackStore.deleteSession(sid);
      await redisRuntime.execute(async (client) => {
        let resolvedLocalUserId = String(localUserId || "");
        if (!resolvedLocalUserId) {
          const raw = await client.get(keySession(sid));
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              resolvedLocalUserId = String(parsed.localUserId || "");
            } catch (_error) {
            }
          }
        }

        await client.del(keySession(sid));
        if (resolvedLocalUserId) {
          await client.sRem(keyUserSessions(resolvedLocalUserId), sid);
        }
      });
    }

    async function revokeUserSessions(localUserId, keepSessionId = "") {
      const userId = String(localUserId || "");
      if (!userId) {
        return 0;
      }

      const fallbackRemoved = await fallbackStore.revokeUserSessions(userId, keepSessionId);
      const removed = await redisRuntime.execute(async (client) => {
        const userIndexKey = keyUserSessions(userId);
        const sessionIds = await client.sMembers(userIndexKey);
        if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
          return 0;
        }

        let removedCount = 0;
        for (const sessionId of sessionIds) {
          if (keepSessionId && sessionId === keepSessionId) {
            continue;
          }
          await client.del(keySession(sessionId));
          await client.sRem(userIndexKey, sessionId);
          removedCount += 1;
        }

        if (!keepSessionId) {
          await client.del(userIndexKey);
        }

        return removedCount;
      });

      if (removed === null || removed === undefined) {
        return fallbackRemoved;
      }

      return Number(removed || 0);
    }

    async function saveState(stateValue, payload) {
      const key = String(stateValue || "");
      if (!key) {
        return;
      }

      await fallbackStore.saveState(key, payload);
      await redisRuntime.execute(async (client) => {
        await client.set(keyState(key), JSON.stringify(payload), { EX: stateTtlSeconds });
      });
    }

    async function consumeState(stateValue) {
      const key = String(stateValue || "");
      if (!key) {
        return null;
      }

      const result = await redisRuntime.execute(async (client) => {
        const redisKey = keyState(key);
        const raw = await client.get(redisKey);
        await client.del(redisKey);
        if (!raw) {
          return { found: false, payload: null };
        }

        try {
          return { found: true, payload: JSON.parse(raw) };
        } catch (_error) {
          return { found: false, payload: null };
        }
      });

      if (!result) {
        return fallbackStore.consumeState(key);
      }

      await fallbackStore.consumeState(key);
      if (!result.found) {
        return null;
      }

      return result.payload;
    }

    return {
      distributed: true,
      saveSession,
      getSession,
      deleteSession,
      revokeUserSessions,
      saveState,
      consumeState
    };
  }

  const sessionStore = new Map();
  const stateStore = new Map();

  function pruneExpiredEntries() {
    const now = Date.now();
    for (const [stateKey, item] of stateStore.entries()) {
      if (!item || now > Number(item.expiresAt || 0)) {
        stateStore.delete(stateKey);
      }
    }

    for (const [sid, session] of sessionStore.entries()) {
      if (!session || now > Number(session.expiresAt || 0)) {
        sessionStore.delete(sid);
      }
    }
  }

  async function saveSession(session) {
    pruneExpiredEntries();
    sessionStore.set(session.id, session);
  }

  async function getSession(sessionId) {
    pruneExpiredEntries();
    return sessionStore.get(sessionId) || null;
  }

  async function deleteSession(sessionId) {
    pruneExpiredEntries();
    sessionStore.delete(sessionId);
  }

  async function revokeUserSessions(localUserId, keepSessionId = "") {
    pruneExpiredEntries();
    const userId = String(localUserId || "");
    if (!userId) {
      return 0;
    }

    let removedCount = 0;
    for (const [sessionId, session] of sessionStore.entries()) {
      if (String(session.localUserId || "") !== userId) {
        continue;
      }
      if (keepSessionId && sessionId === keepSessionId) {
        continue;
      }
      sessionStore.delete(sessionId);
      removedCount += 1;
    }

    return removedCount;
  }

  async function saveState(stateValue, payload) {
    pruneExpiredEntries();
    stateStore.set(stateValue, {
      payload,
      expiresAt: Date.now() + stateTtlSeconds * 1000
    });
  }

  async function consumeState(stateValue) {
    pruneExpiredEntries();
    const entry = stateStore.get(stateValue);
    stateStore.delete(stateValue);
    return entry ? entry.payload : null;
  }

  return {
    distributed: false,
    saveSession,
    getSession,
    deleteSession,
    revokeUserSessions,
    saveState,
    consumeState
  };
}

function createSessionAuth(options = {}) {
  const authConfig = options.authConfig || getAuthConfig();
  const redisConfig = options.redisConfig || getRedisConfig();
  const redisRuntime = options.redisRuntime || getSharedRedisRuntime(redisConfig);
  const sessionTtlSeconds = authConfig.sessionTtlHours * 60 * 60;
  const sessionStateStore = createSessionStateStore({
    redisRuntime,
    sessionTtlSeconds,
    stateTtlSeconds: 10 * 60
  });
  const auditLogger = options.auditLogger || { enabled: false, log: async () => {} };
  const ssoMissingConfig = getMissingSsoConfig(authConfig);
  const ssoConfigured = authConfig.ssoEnabled ? ssoMissingConfig.length === 0 : false;
  const anyProviderConfigured = authConfig.localEnabled || ssoConfigured;

  const localDirectory = options.localDirectory || createLocalUserDirectory({
    filePath: authConfig.localUsersFile,
    passwordMinLength: authConfig.passwordMinLength,
    lockout: {
      enabled: authConfig.enabled,
      maxAttempts: authConfig.lockoutMaxAttempts,
      windowMs: authConfig.lockoutWindowSeconds * 1000,
      lockMs: authConfig.lockoutDurationSeconds * 1000
    },
    bootstrap: {
      enabled: authConfig.localEnabled,
      name: authConfig.bootstrapAdminName,
      email: authConfig.bootstrapAdminEmail,
      password: authConfig.bootstrapAdminPassword
    }
  });

  const authClient = authConfig.ssoEnabled && ssoConfigured
    ? new ConfidentialClientApplication({
        auth: {
          clientId: authConfig.clientId,
          authority: `https://login.microsoftonline.com/${authConfig.tenantId}`,
          clientSecret: authConfig.clientSecret
        }
      })
    : null;

  let localDirectoryError = "";
  const readyPromise = localDirectory.ensureReady().catch((error) => {
    localDirectoryError = error && error.message ? error.message : "Unknown local user store error.";
  });

  function buildSession(identity) {
    const now = Date.now();
    return {
      id: base64UrlToken(24),
      name: String(identity.name || "Unknown user"),
      email: String(identity.email || ""),
      oid: String(identity.oid || ""),
      localUserId: String(identity.localUserId || ""),
      roles: Array.isArray(identity.roles) ? identity.roles : ["analyst"],
      groups: Array.isArray(identity.groups) ? identity.groups : [],
      authSource: String(identity.authSource || "unknown"),
      mustResetPassword: Boolean(identity.mustResetPassword),
      createdAt: now,
      expiresAt: now + sessionTtlSeconds * 1000
    };
  }

  function toAuditRequest(request, routeOverride = "") {
    const headers = request && request.headers ? request.headers : {};
    const forwarded = String(headers["x-forwarded-for"] || "").trim();
    const ip = forwarded ? forwarded.split(",")[0].trim() : String(request && request.socket && request.socket.remoteAddress ? request.socket.remoteAddress : "");
    return {
      ip,
      userAgent: String(headers["user-agent"] || ""),
      requestId: String(request && request.requestId ? request.requestId : ""),
      route: routeOverride || String(request && request.url ? request.url : "")
    };
  }

  async function logAudit(eventType, outcome, request, details = {}, actor = {}) {
    if (!auditLogger || !auditLogger.enabled) {
      return;
    }

    await auditLogger.log({
      eventType,
      outcome,
      request: toAuditRequest(request),
      actor,
      details
    });
  }

  async function issueSession(response, identity) {
    const session = buildSession(identity);
    await sessionStateStore.saveSession(session);
    setCookie(response, SESSION_COOKIE_NAME, session.id, {
      maxAge: sessionTtlSeconds,
      httpOnly: true,
      sameSite: "Lax",
      secure: authConfig.cookieSecure
    });
    return session;
  }

  async function revokeSessionsForLocalUser(localUserId, keepSessionId = "") {
    return sessionStateStore.revokeUserSessions(localUserId, keepSessionId);
  }

  async function getSession(request) {
    if (!authConfig.enabled) {
      return {
        id: "demo-local",
        name: "Demo Operator",
        email: "demo@kontoso.com",
        roles: ["admin", "analyst"],
        groups: [],
        authSource: "disabled",
        mustResetPassword: false
      };
    }

    const sid = parseCookies(request)[SESSION_COOKIE_NAME];
    if (!sid) {
      return null;
    }

    const session = await sessionStateStore.getSession(sid);
    if (!session) {
      return null;
    }

    if (Date.now() > Number(session.expiresAt || 0)) {
      await sessionStateStore.deleteSession(sid, session.localUserId);
      return null;
    }

    return session;
  }

  function hasRole(session, role) {
    return Boolean(session && Array.isArray(session.roles) && session.roles.includes(role));
  }

  function getAuthStatus() {
    const lockoutPolicy = localDirectory.getLockoutPolicy();
    const passwordPolicy = localDirectory.getPasswordPolicy();

    if (!authConfig.enabled) {
      return {
        enabled: false,
        configured: false,
        reason: "Authentication is disabled (`ENABLE_SSO_LOGIN=false` and `ENABLE_LOCAL_LOGIN=false`).",
        providers: {
          sso: { enabled: false, configured: false, reason: "Disabled." },
          local: { enabled: false, configured: false, reason: "Disabled." }
        },
        hardening: {
          enabled: false,
          directoryGuard: false,
          passwordPolicy,
          lockout: lockoutPolicy,
          jsonBodyLimitKb: authConfig.jsonBodyLimitKb,
          singleInstanceGuards: !sessionStateStore.distributed,
          distributedSessionStore: sessionStateStore.distributed,
          redisEnabled: Boolean(redisRuntime && redisRuntime.enabled)
        }
      };
    }

    const ssoReason = !authConfig.ssoEnabled
      ? "Disabled."
      : ssoConfigured
        ? "Microsoft SSO is configured."
        : `Missing auth settings: ${ssoMissingConfig.join(", ")}`;
    const localReason = !authConfig.localEnabled
      ? "Disabled."
      : localDirectoryError
        ? localDirectoryError
        : "Local credential login is configured.";

    return {
      enabled: true,
      configured: anyProviderConfigured && !localDirectoryError,
      reason: anyProviderConfigured
        ? "Authentication providers are available."
        : "No authentication provider is fully configured.",
      providers: {
        sso: { enabled: authConfig.ssoEnabled, configured: ssoConfigured, reason: ssoReason },
        local: { enabled: authConfig.localEnabled, configured: !localDirectoryError, reason: localReason }
      },
      hardening: {
        enabled: true,
        directoryGuard: true,
        passwordPolicy,
        lockout: lockoutPolicy,
        jsonBodyLimitKb: authConfig.jsonBodyLimitKb,
        singleInstanceGuards: !sessionStateStore.distributed,
        distributedSessionStore: sessionStateStore.distributed,
        redisEnabled: Boolean(redisRuntime && redisRuntime.enabled)
      }
    };
  }

  async function requireSession(request, response, options = {}) {
    const api = Boolean(options.api);
    if (!authConfig.enabled) {
      return { ok: true, session: await getSession(request) };
    }

    if (!anyProviderConfigured || localDirectoryError) {
      if (api) {
        writeJson(response, 503, {
          ok: false,
          error: "Authentication is enabled but not fully configured.",
          auth: getAuthStatus()
        });
      } else {
        response.writeHead(302, { Location: "/login?error=config" });
        response.end();
      }
      return { ok: false };
    }

    const sid = parseCookies(request)[SESSION_COOKIE_NAME];
    const session = await getSession(request);
    if (!session) {
      if (api) {
        writeAuthError(response, 401, "authentication_required", "Authentication required.");
      } else {
        response.writeHead(302, { Location: "/login" });
        response.end();
      }
      return { ok: false };
    }

    if (session.localUserId && typeof localDirectory.getCachedUserById === "function") {
      const directoryUser = localDirectory.getCachedUserById(session.localUserId);
      const invalidSession = !directoryUser
        || directoryUser.status !== "active"
        || (session.authSource === "aad-directory" && !["sso", "either"].includes(directoryUser.authMode))
        || (session.authSource === "local-password" && !["local", "either"].includes(directoryUser.authMode));

      if (invalidSession) {
        if (sid) {
          await sessionStateStore.deleteSession(sid, session.localUserId);
        }
        if (api) {
          writeAuthError(response, 401, "session_revoked", "Session is no longer valid.");
        } else {
          response.writeHead(302, { Location: "/login?error=session" });
          response.end();
        }
        return { ok: false };
      }

      session.roles = directoryUser.roles;
      session.groups = directoryUser.groups;
      session.mustResetPassword = session.authSource === "local-password" && Boolean(directoryUser.mustResetPassword);
      if (sid) {
        await sessionStateStore.saveSession(session);
      }
    }

    if (session.mustResetPassword && !options.allowPasswordReset) {
      if (api) {
        writeAuthError(response, 403, "password_reset_required", "Password reset is required before accessing this resource.", {
          mustResetPassword: true
        });
      } else {
        response.writeHead(302, { Location: "/login?reset=required" });
        response.end();
      }
      return { ok: false };
    }

    return { ok: true, session };
  }

  async function handleLogin(request, response, url) {
    await readyPromise;
    if (!authConfig.ssoEnabled) {
      writeAuthError(response, 404, "sso_disabled", "SSO login is not enabled.");
      return;
    }

    if (!ssoConfigured || !authClient) {
      writeAuthError(response, 503, "sso_not_configured", "SSO is enabled but not fully configured.", {
        missing: ssoMissingConfig
      });
      return;
    }

    const state = base64UrlToken(24);
    const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
    await sessionStateStore.saveState(state, { returnTo });

    try {
      const authUrl = await authClient.getAuthCodeUrl({
        scopes: AUTH_SCOPES,
        redirectUri: authConfig.redirectUri,
        responseMode: "query",
        state,
        prompt: "select_account"
      });

      response.writeHead(302, { Location: authUrl });
      response.end();
    } catch (error) {
      await logAudit("sso_login_start", "error", request, { code: "sso_start_failed", message: error.message });
      writeAuthError(response, 500, "sso_start_failed", "Failed to start SSO login.", {
        details: error.message
      });
    }
  }

  async function handleCallback(request, response, url) {
    await readyPromise;
    if (!authConfig.ssoEnabled || !ssoConfigured || !authClient) {
      writeAuthError(response, 503, "sso_not_configured", "SSO callback is unavailable due to missing configuration.");
      return;
    }

    const state = String(url.searchParams.get("state") || "");
    const code = String(url.searchParams.get("code") || "");
    const stored = await sessionStateStore.consumeState(state);

    if (!stored || !code) {
      await logAudit("sso_callback", "failure", request, { code: "invalid_callback" });
      response.writeHead(302, { Location: "/login?error=callback" });
      response.end();
      return;
    }

    try {
      const result = await authClient.acquireTokenByCode({
        code,
        redirectUri: authConfig.redirectUri,
        scopes: AUTH_SCOPES
      });

      const claims = result && result.idTokenClaims ? result.idTokenClaims : {};
      const email = String(claims.preferred_username || claims.upn || result.account?.username || "").trim().toLowerCase();
      const groups = Array.isArray(claims.groups) ? claims.groups.map((group) => String(group)) : [];
      const displayName = String(claims.name || result.account?.name || "Unknown user");

      if (!email) {
        await logAudit("sso_callback", "failure", request, { code: "directory_missing_email" });
        response.writeHead(302, { Location: "/login?error=directory" });
        response.end();
        return;
      }

      const directoryMatch = await localDirectory.resolveUserForSso(email);
      if (!directoryMatch.ok) {
        await logAudit("sso_callback", "failure", request, {
          code: directoryMatch.code || "directory",
          email
        }, {
          type: "user",
          email
        });
        response.writeHead(302, { Location: `/login?error=${encodeURIComponent(directoryMatch.code || "directory")}` });
        response.end();
        return;
      }

      const user = directoryMatch.user;
      const roles = Array.isArray(user.roles) && user.roles.length > 0 ? user.roles : roleListFromGroups(user.groups);
      if (!roles.length) {
        await logAudit("sso_callback", "failure", request, {
          code: "unauthorized_role_mapping",
          email
        }, {
          type: "user",
          email
        });
        response.writeHead(302, { Location: "/login?error=unauthorized" });
        response.end();
        return;
      }

      await issueSession(response, {
        name: displayName,
        email,
        oid: String(claims.oid || ""),
        localUserId: user.id,
        roles,
        groups,
        authSource: "aad-directory",
        mustResetPassword: false
      });

      await logAudit("sso_callback", "success", request, {
        authSource: "aad-directory",
        roles,
        localUserId: user.id
      }, {
        type: "user",
        id: user.id,
        email
      });

      response.writeHead(302, { Location: stored.returnTo || "/" });
      response.end();
    } catch (_error) {
      await logAudit("sso_callback", "failure", request, { code: "signin_failed" });
      response.writeHead(302, { Location: "/login?error=signin" });
      response.end();
    }
  }

  async function handleLocalLogin(request, response, payload = {}) {
    await readyPromise;
    if (!authConfig.localEnabled) {
      writeAuthError(response, 404, "local_login_disabled", "Local login is not enabled.");
      return;
    }

    if (localDirectoryError) {
      writeAuthError(response, 503, "local_directory_unavailable", "Local user directory is unavailable.", {
        details: localDirectoryError
      });
      return;
    }

    const email = String(payload.email || "").trim().toLowerCase();
    const password = String(payload.password || "");
    const returnTo = safeReturnTo(payload.returnTo || "/");
    const verification = await localDirectory.verifyLocalCredentials(email, password);
    if (!verification.ok) {
      await logAudit("local_login", "failure", request, {
        code: verification.code || "local_login_failed",
        lockedUntil: verification.lockedUntil || null
      }, {
        type: "user",
        email
      });
      writeAuthError(response, verification.statusCode || 401, verification.code || "local_login_failed", verification.error || "Sign-in failed.", {
        lockedUntil: verification.lockedUntil || null
      });
      return;
    }

    const user = verification.user;
    await issueSession(response, {
      name: user.name,
      email: user.email,
      localUserId: user.id,
      roles: user.roles,
      groups: user.groups,
      authSource: "local-password",
      mustResetPassword: Boolean(user.mustResetPassword)
    });

    await logAudit("local_login", "success", request, {
      authSource: "local-password",
      mustResetPassword: Boolean(user.mustResetPassword),
      roles: user.roles,
      localUserId: user.id
    }, {
      type: "user",
      id: user.id,
      email: user.email
    });

    if (user.mustResetPassword) {
      writeJson(response, 200, {
        ok: true,
        mustResetPassword: true,
        redirectTo: "/login?reset=required"
      });
      return;
    }

    writeJson(response, 200, { ok: true, mustResetPassword: false, redirectTo: returnTo });
  }

  async function handleChangePassword(request, response, payload = {}) {
    await readyPromise;
    if (!authConfig.localEnabled) {
      writeAuthError(response, 404, "local_login_disabled", "Local login is not enabled.");
      return;
    }

    if (localDirectoryError) {
      writeAuthError(response, 503, "local_directory_unavailable", "Local user directory is unavailable.", {
        details: localDirectoryError
      });
      return;
    }

    const session = await getSession(request);
    if (!session) {
      writeAuthError(response, 401, "authentication_required", "Authentication required.");
      return;
    }

    if (!session.localUserId || session.authSource !== "local-password") {
      writeAuthError(response, 403, "password_change_not_allowed", "Password change is available only for local credential sessions.");
      return;
    }

    const currentPassword = String(payload.currentPassword || "");
    const newPassword = String(payload.newPassword || "");
    if (!currentPassword || !newPassword) {
      writeAuthError(response, 400, "invalid_payload", "Current password and new password are required.");
      return;
    }

    const result = await localDirectory.changePassword(session.localUserId, currentPassword, newPassword);
    if (!result.ok) {
      await logAudit("password_change", "failure", request, {
        code: result.code || "password_change_failed"
      }, {
        type: "user",
        id: session.localUserId,
        email: session.email
      });
      writeAuthError(response, result.statusCode || 400, result.code || "password_change_failed", result.error || "Password change failed.");
      return;
    }

    const sid = parseCookies(request)[SESSION_COOKIE_NAME];
    await revokeSessionsForLocalUser(session.localUserId, sid);
    if (sid) {
      const latest = await sessionStateStore.getSession(sid);
      if (latest) {
        latest.mustResetPassword = false;
        latest.expiresAt = Date.now() + sessionTtlSeconds * 1000;
        await sessionStateStore.saveSession(latest);
      }
    }

    await logAudit("password_change", "success", request, {
      localUserId: session.localUserId
    }, {
      type: "user",
      id: session.localUserId,
      email: session.email
    });

    writeJson(response, 200, {
      ok: true,
      message: "Password changed successfully.",
      mustResetPassword: false
    });
  }

  async function handleLogout(request, response) {
    const sid = parseCookies(request)[SESSION_COOKIE_NAME];
    if (sid) {
      const existing = await sessionStateStore.getSession(sid);
      await sessionStateStore.deleteSession(sid, existing ? existing.localUserId : "");
      if (existing) {
        await logAudit("logout", "success", request, {
          authSource: existing.authSource
        }, {
          type: "user",
          id: existing.localUserId,
          email: existing.email
        });
      }
    }

    setCookie(response, SESSION_COOKIE_NAME, "", {
      maxAge: 0,
      httpOnly: true,
      sameSite: "Lax",
      secure: authConfig.cookieSecure
    });

    const location = authConfig.postLogoutRedirectUri || "/login";
    response.writeHead(302, { Location: location });
    response.end();
  }

  async function writeSession(response, request) {
    const session = await getSession(request);
    const status = getAuthStatus();
    if (!session && authConfig.enabled) {
      writeAuthError(response, 401, "authentication_required", "Authentication required.", {
        auth: status
      });
      return;
    }

    writeJson(response, 200, {
      ok: true,
      auth: status,
      user: session
        ? {
            name: session.name,
            email: session.email,
            roles: session.roles,
            groups: session.groups,
            authSource: session.authSource,
            mustResetPassword: Boolean(session.mustResetPassword)
          }
        : null
    });
  }

  async function listManagedUsers() {
    await readyPromise;
    return localDirectory.listUsers();
  }

  async function createManagedUser(payload) {
    await readyPromise;
    return localDirectory.createUser(payload);
  }

  async function updateManagedUser(userId, payload) {
    await readyPromise;
    const result = await localDirectory.updateUser(userId, payload);
    if (result.ok) {
      await revokeSessionsForLocalUser(userId);
    }
    return result;
  }

  async function resetManagedUserPassword(userId, payload) {
    await readyPromise;
    const result = await localDirectory.resetUserPassword(userId, payload || {});
    if (result.ok) {
      await revokeSessionsForLocalUser(userId);
    }
    return result;
  }

  return {
    authConfig,
    getAuthStatus,
    getSession,
    hasRole,
    requireSession,
    handleLogin,
    handleCallback,
    handleLocalLogin,
    handleChangePassword,
    handleLogout,
    writeSession,
    listManagedUsers,
    createManagedUser,
    updateManagedUser,
    resetManagedUserPassword,
    roleListFromGroups,
    authErrorPayload
  };
}

module.exports = {
  createSessionAuth
};
