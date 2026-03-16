function normalizeText(value) {
  return String(value || "").trim();
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function parseInteger(value, defaultValue, minimum, maximum) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  if (parsed < minimum) {
    return minimum;
  }

  if (parsed > maximum) {
    return maximum;
  }

  return parsed;
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseKeyValueList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((result, entry) => {
      const eqIndex = entry.indexOf("=");
      if (eqIndex <= 0) {
        return result;
      }
      const key = entry.slice(0, eqIndex).trim();
      const mapped = entry.slice(eqIndex + 1).trim();
      if (key && mapped) {
        result[key] = mapped;
      }
      return result;
    }, {});
}

function getLiveGraphEnabled() {
  return parseBoolean(process.env.ENABLE_LIVE_GRAPH, false);
}

function getGraphRequestConfig() {
  return {
    timeoutMs: parseInteger(process.env.GRAPH_REQUEST_TIMEOUT_MS, 10000, 1000, 120000),
    maxRetries: parseInteger(process.env.GRAPH_MAX_RETRIES, 2, 0, 5)
  };
}

function getCalendarIntegrationConfig() {
  return {
    enabled: parseBoolean(process.env.ENABLE_CALENDAR_INTEGRATION, false),
    targetUser: normalizeText(process.env.CALENDAR_TARGET_USER),
    timeZone: normalizeText(process.env.CALENDAR_TIMEZONE) || "UTC",
    durationMinutes: parseInteger(process.env.CALENDAR_EVENT_DURATION_MINUTES, 30, 10, 240),
    standardReviewDays: parseInteger(process.env.CALENDAR_STANDARD_REVIEW_DAYS, 30, 1, 365),
    reportOnlyReviewDays: parseInteger(process.env.CALENDAR_REPORT_ONLY_REVIEW_DAYS, 3, 1, 90),
    disabledReviewDays: parseInteger(process.env.CALENDAR_DISABLED_REVIEW_DAYS, 7, 1, 180),
    summaryReviewDays: parseInteger(process.env.CALENDAR_SUMMARY_REVIEW_DAYS, 1, 1, 30),
    defaultHourUtc: parseInteger(process.env.CALENDAR_EVENT_HOUR_UTC, 9, 0, 23),
    defaultMinuteUtc: parseInteger(process.env.CALENDAR_EVENT_MINUTE_UTC, 0, 0, 59),
    createSummaryReminder: parseBoolean(process.env.CALENDAR_CREATE_SUMMARY_REMINDER, true)
  };
}

function getRedisConfig() {
  const url = normalizeText(process.env.REDIS_URL);
  const enabled = parseBoolean(process.env.REDIS_ENABLED, Boolean(url));
  return {
    enabled,
    required: parseBoolean(process.env.REDIS_REQUIRED, false),
    url,
    keyPrefix: normalizeText(process.env.REDIS_KEY_PREFIX) || "cam",
    connectTimeoutMs: parseInteger(process.env.REDIS_CONNECT_TIMEOUT_MS, 5000, 1000, 60000)
  };
}

function getAuditLogConfig() {
  return {
    enabled: parseBoolean(process.env.AUDIT_LOG_ENABLED, true),
    filePath: normalizeText(process.env.AUDIT_LOG_FILE),
    secret: normalizeText(process.env.AUDIT_LOG_SECRET)
  };
}

function getKeyVaultConfig() {
  return {
    enabled: parseBoolean(process.env.ENABLE_KEYVAULT_SECRETS, false),
    vaultUrl: normalizeText(process.env.KEYVAULT_URL),
    secretMappings: parseKeyValueList(process.env.KEYVAULT_SECRET_MAPPINGS),
    overrideExisting: parseBoolean(process.env.KEYVAULT_OVERRIDE_EXISTING, false),
    timeoutMs: parseInteger(process.env.KEYVAULT_TIMEOUT_MS, 10000, 1000, 120000)
  };
}

function getAuthConfig() {
  const ssoEnabled = parseBoolean(process.env.ENABLE_SSO_LOGIN, false);
  const localEnabled = parseBoolean(process.env.ENABLE_LOCAL_LOGIN, false);
  const redirectUri = normalizeText(process.env.SSO_REDIRECT_URI);
  const secureCookieFromRedirect = redirectUri.toLowerCase().startsWith("https://");

  return {
    enabled: ssoEnabled || localEnabled,
    ssoEnabled,
    localEnabled,
    tenantId: normalizeText(process.env.SSO_TENANT_ID) || "common",
    clientId: normalizeText(process.env.SSO_CLIENT_ID),
    clientSecret: normalizeText(process.env.SSO_CLIENT_SECRET),
    redirectUri,
    postLogoutRedirectUri: normalizeText(process.env.SSO_POST_LOGOUT_REDIRECT_URI),
    sessionSecret: normalizeText(process.env.SESSION_SECRET),
    sessionTtlHours: parseInteger(process.env.SESSION_TTL_HOURS, 8, 1, 24),
    requireGroups: parseBoolean(process.env.AUTH_REQUIRE_GROUPS, true),
    analystGroupIds: parseCsv(process.env.AUTH_ANALYST_GROUP_IDS),
    adminGroupIds: parseCsv(process.env.AUTH_ADMIN_GROUP_IDS),
    cookieSecure: parseBoolean(process.env.SESSION_COOKIE_SECURE, secureCookieFromRedirect),
    requireUserDirectoryForSso: parseBoolean(process.env.AUTH_REQUIRE_LOCAL_USER_FOR_SSO, true),
    localUsersFile: normalizeText(process.env.LOCAL_USERS_FILE),
    bootstrapAdminName: normalizeText(process.env.LOCAL_BOOTSTRAP_ADMIN_NAME) || "Local Administrator",
    bootstrapAdminEmail: normalizeText(process.env.LOCAL_BOOTSTRAP_ADMIN_EMAIL) || "admin@kontoso.com",
    bootstrapAdminPassword: normalizeText(process.env.LOCAL_BOOTSTRAP_ADMIN_PASSWORD) || "ChangeMeNow123!",
    lockoutMaxAttempts: parseInteger(process.env.AUTH_LOCKOUT_MAX_ATTEMPTS, 5, 3, 20),
    lockoutWindowSeconds: parseInteger(process.env.AUTH_LOCKOUT_WINDOW_SECONDS, 15 * 60, 1, 24 * 60 * 60),
    lockoutDurationSeconds: parseInteger(process.env.AUTH_LOCKOUT_DURATION_SECONDS, 15 * 60, 1, 24 * 60 * 60),
    passwordMinLength: parseInteger(process.env.AUTH_PASSWORD_MIN_LENGTH, 12, 12, 128),
    authRateLimitWindowSeconds: parseInteger(process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS, 15 * 60, 60, 24 * 60 * 60),
    authRateLimitLocalLoginMax: parseInteger(process.env.AUTH_RATE_LIMIT_LOCAL_LOGIN_MAX, 12, 3, 120),
    authRateLimitSsoMax: parseInteger(process.env.AUTH_RATE_LIMIT_SSO_MAX, 30, 10, 240),
    adminMutationRateLimitMax: parseInteger(process.env.AUTH_RATE_LIMIT_ADMIN_MUTATION_MAX, 45, 10, 360),
    jsonBodyLimitKb: parseInteger(process.env.AUTH_JSON_BODY_LIMIT_KB, 64, 16, 256)
  };
}

module.exports = {
  getGraphRequestConfig,
  getLiveGraphEnabled,
  getCalendarIntegrationConfig,
  getAuthConfig,
  getRedisConfig,
  getAuditLogConfig,
  getKeyVaultConfig
};
