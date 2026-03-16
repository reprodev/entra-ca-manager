const os = require("os");
const path = require("path");
const { mkdtemp, rm } = require("fs/promises");
const { ConfidentialClientApplication } = require("@azure/msal-node");
const { createServer } = require("../src/server");

function startServer(server, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

function stopServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function hasNoStoreCacheHeaders(response) {
  const cacheControl = String(response.headers.get("cache-control") || "").toLowerCase();
  return cacheControl.includes("no-store");
}

function extractCookie(response) {
  const cookieHeader = response.headers.get("set-cookie") || "";
  if (!cookieHeader) {
    return "";
  }
  const [cookiePair] = cookieHeader.split(";");
  return cookiePair || "";
}

async function fetchJson(url, options = {}, cookie = "") {
  const headers = Object.assign({}, options.headers || {});
  if (cookie) {
    headers.Cookie = cookie;
  }
  const response = await fetch(url, Object.assign({}, options, { headers }));
  let body = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (_error) {
      body = null;
    }
  }
  const nextCookie = extractCookie(response) || cookie;
  return { response, body, cookie: nextCookie };
}

function setEnv(overrides) {
  const previous = {};
  Object.entries(overrides).forEach(([key, value]) => {
    previous[key] = process.env[key];
    process.env[key] = value;
  });
  return () => {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  };
}

async function runLocalHardeningChecks() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cam-auth-hardening-"));
  const localUsersPath = path.join(tempDir, "local-users.json");
  const restoreEnv = setEnv({
    ENABLE_SSO_LOGIN: "false",
    ENABLE_LOCAL_LOGIN: "true",
    AUTH_REQUIRE_LOCAL_USER_FOR_SSO: "true",
    LOCAL_USERS_FILE: localUsersPath,
    LOCAL_BOOTSTRAP_ADMIN_NAME: "Bootstrap Admin",
    LOCAL_BOOTSTRAP_ADMIN_EMAIL: "admin@kontoso.com",
    LOCAL_BOOTSTRAP_ADMIN_PASSWORD: "ChangeMeNow123!",
    AUTH_LOCKOUT_MAX_ATTEMPTS: "3",
    AUTH_LOCKOUT_WINDOW_SECONDS: "60",
    AUTH_LOCKOUT_DURATION_SECONDS: "2",
    AUTH_PASSWORD_MIN_LENGTH: "12"
  });

  const server = createServer();

  try {
    const port = await startServer(server, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/health`);
    assert(health.headers.get("x-content-type-options") === "nosniff", "Missing X-Content-Type-Options");
    assert(health.headers.get("x-frame-options") === "DENY", "Missing X-Frame-Options");
    assert(Boolean(health.headers.get("content-security-policy")), "Missing Content-Security-Policy");
    assert(health.headers.get("cross-origin-opener-policy") === "same-origin", "Missing Cross-Origin-Opener-Policy");

    const statusCheck = await fetchJson(`${base}/auth/status`);
    assert(statusCheck.response.status === 200, "Expected /auth/status 200");
    assert(statusCheck.body && statusCheck.body.ok, "Expected auth status payload");
    assert(statusCheck.body.auth && statusCheck.body.auth.hardening && statusCheck.body.auth.hardening.directoryGuard === true, "Expected directory guard enabled");
    assert(hasNoStoreCacheHeaders(statusCheck.response), "Expected no-store headers on /auth/status");

    const login = await fetchJson(`${base}/auth/local-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@kontoso.com", password: "ChangeMeNow123!" })
    });
    assert(login.response.status === 200, `Expected local login 200, got ${login.response.status}`);
    assert(login.body && login.body.mustResetPassword === true, "Expected bootstrap admin to require password reset");
    assert(hasNoStoreCacheHeaders(login.response), "Expected no-store headers on /auth/local-login");
    const adminCookie = login.cookie;
    assert(Boolean(adminCookie), "Expected session cookie after bootstrap login");

    const blockedApi = await fetchJson(`${base}/api/tenants`, { method: "GET" }, adminCookie);
    assert(blockedApi.response.status === 403, `Expected 403 before password reset, got ${blockedApi.response.status}`);
    assert(blockedApi.body && blockedApi.body.error && blockedApi.body.error.code === "password_reset_required", "Expected password_reset_required error");

    const changePassword = await fetchJson(`${base}/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: "ChangeMeNow123!", newPassword: "AdminUpdated123!$" })
    }, adminCookie);
    assert(changePassword.response.status === 200, `Expected change-password 200, got ${changePassword.response.status}`);
    assert(changePassword.body && changePassword.body.ok, "Expected successful password change");
    assert(hasNoStoreCacheHeaders(changePassword.response), "Expected no-store headers on /auth/change-password");

    const tenantsAfterReset = await fetchJson(`${base}/api/tenants`, { method: "GET" }, adminCookie);
    assert(tenantsAfterReset.response.status === 200, "Expected API access after password reset");

    const createUser = await fetchJson(`${base}/api/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Analyst User",
        email: "analyst@kontoso.com",
        authMode: "local",
        groups: ["analysts"],
        password: "AnalystStart123!$"
      })
    }, adminCookie);
    assert(createUser.response.status === 201, `Expected admin user create 201, got ${createUser.response.status}`);
    const analystUser = createUser.body && createUser.body.user ? createUser.body.user : null;
    assert(analystUser && analystUser.id, "Expected created analyst user");

    const analystLogin = await fetchJson(`${base}/auth/local-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "analyst@kontoso.com", password: "AnalystStart123!$" })
    });
    assert(analystLogin.response.status === 200, `Expected analyst login 200, got ${analystLogin.response.status}`);
    const analystCookie = analystLogin.cookie;
    assert(Boolean(analystCookie), "Expected analyst session cookie");

    const reusePasswordAttempt = await fetchJson(`${base}/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: "AnalystStart123!$", newPassword: "AnalystStart123!$" })
    }, analystCookie);
    assert(reusePasswordAttempt.response.status === 400, `Expected 400 for password reuse, got ${reusePasswordAttempt.response.status}`);
    assert(
      reusePasswordAttempt.body &&
      reusePasswordAttempt.body.error &&
      reusePasswordAttempt.body.error.code === "password_reuse_not_allowed",
      "Expected password_reuse_not_allowed error"
    );

    const disableUser = await fetchJson(`${base}/api/admin/users/${encodeURIComponent(analystUser.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "disabled" })
    }, adminCookie);
    assert(disableUser.response.status === 200, `Expected disable user 200, got ${disableUser.response.status}`);

    const revokedSessionUse = await fetchJson(`${base}/api/tenants`, { method: "GET" }, analystCookie);
    assert(revokedSessionUse.response.status === 401, `Expected revoked analyst session to fail with 401, got ${revokedSessionUse.response.status}`);

    const enableUser = await fetchJson(`${base}/api/admin/users/${encodeURIComponent(analystUser.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active", unlock: true })
    }, adminCookie);
    assert(enableUser.response.status === 200, `Expected enable user 200, got ${enableUser.response.status}`);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const badLogin = await fetchJson(`${base}/auth/local-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "analyst@kontoso.com", password: "WrongPassword123!" })
      });
      if (attempt < 3) {
        assert(badLogin.response.status === 401, `Expected 401 for failed attempt ${attempt}, got ${badLogin.response.status}`);
      } else {
        assert(badLogin.response.status === 423, `Expected 423 on lockout threshold, got ${badLogin.response.status}`);
      }
    }

    const lockedGoodPassword = await fetchJson(`${base}/auth/local-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "analyst@kontoso.com", password: "AnalystStart123!$" })
    });
    assert(lockedGoodPassword.response.status === 423, "Expected locked account to block valid password");

    await new Promise((resolve) => setTimeout(resolve, 2300));

    const unlockedLogin = await fetchJson(`${base}/auth/local-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "analyst@kontoso.com", password: "AnalystStart123!$" })
    });
    assert(unlockedLogin.response.status === 200, `Expected login after lockout expiry, got ${unlockedLogin.response.status}`);

    const resetPassword = await fetchJson(`${base}/api/admin/users/${encodeURIComponent(analystUser.id)}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "AnalystReset123!$", mustResetPassword: true })
    }, adminCookie);
    assert(resetPassword.response.status === 200, `Expected admin reset-password 200, got ${resetPassword.response.status}`);
    assert(resetPassword.body && resetPassword.body.ok, "Expected reset-password success");

    const oldPasswordLogin = await fetchJson(`${base}/auth/local-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "analyst@kontoso.com", password: "AnalystStart123!$" })
    });
    assert(oldPasswordLogin.response.status === 401, "Expected old password to be invalid after reset");

    const tempPasswordLogin = await fetchJson(`${base}/auth/local-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "analyst@kontoso.com", password: "AnalystReset123!$" })
    });
    assert(tempPasswordLogin.response.status === 200, "Expected reset password to authenticate");
    assert(tempPasswordLogin.body && tempPasswordLogin.body.mustResetPassword === true, "Expected reset password login to require password change");
  } finally {
    await stopServer(server);
    restoreEnv();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runSsoDirectoryGuardCheck() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cam-auth-sso-guard-"));
  const localUsersPath = path.join(tempDir, "local-users.json");
  const restoreEnv = setEnv({
    ENABLE_SSO_LOGIN: "true",
    ENABLE_LOCAL_LOGIN: "false",
    AUTH_REQUIRE_LOCAL_USER_FOR_SSO: "true",
    LOCAL_USERS_FILE: localUsersPath,
    SSO_CLIENT_ID: "test-client-id",
    SSO_CLIENT_SECRET: "test-client-secret",
    SSO_REDIRECT_URI: "http://127.0.0.1/auth/callback"
  });

  const originalGetAuthCodeUrl = ConfidentialClientApplication.prototype.getAuthCodeUrl;
  const originalAcquireTokenByCode = ConfidentialClientApplication.prototype.acquireTokenByCode;

  ConfidentialClientApplication.prototype.getAuthCodeUrl = async function getAuthCodeUrl(request) {
    return `https://login.microsoftonline.com/mock?state=${encodeURIComponent(request.state)}`;
  };
  ConfidentialClientApplication.prototype.acquireTokenByCode = async function acquireTokenByCode() {
    return {
      account: { username: "missing@kontoso.com", name: "Missing User" },
      idTokenClaims: {
        preferred_username: "missing@kontoso.com",
        name: "Missing User",
        oid: "oid-missing-user"
      }
    };
  };

  const server = createServer();

  try {
    const port = await startServer(server, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;

    const loginStart = await fetch(`${base}/auth/login?returnTo=/`, { redirect: "manual" });
    assert(loginStart.status === 302, `Expected SSO login start redirect, got ${loginStart.status}`);
    assert(hasNoStoreCacheHeaders(loginStart), "Expected no-store headers on /auth/login");
    const location = loginStart.headers.get("location") || "";
    const authUrl = new URL(location);
    const state = authUrl.searchParams.get("state");
    assert(Boolean(state), "Expected SSO state value");

    const callback = await fetch(`${base}/auth/callback?state=${encodeURIComponent(state)}&code=test-code`, {
      redirect: "manual"
    });
    assert(callback.status === 302, `Expected callback redirect, got ${callback.status}`);
    const callbackLocation = callback.headers.get("location") || "";
    assert(callbackLocation.includes("/login?error=directory_user_missing"), `Expected directory guard denial, got ${callbackLocation}`);
  } finally {
    await stopServer(server);
    ConfidentialClientApplication.prototype.getAuthCodeUrl = originalGetAuthCodeUrl;
    ConfidentialClientApplication.prototype.acquireTokenByCode = originalAcquireTokenByCode;
    restoreEnv();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function run() {
  await runLocalHardeningChecks();
  await runSsoDirectoryGuardCheck();
  process.stdout.write("E2E auth hardening checks passed\n");
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
