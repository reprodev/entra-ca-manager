const crypto = require("crypto");
const path = require("path");
const { access, copyFile, mkdir, readFile, rename, unlink, writeFile } = require("fs/promises");

const DEFAULT_LOCAL_USERS_PATH = path.resolve(__dirname, "..", "..", "data", "local-users.json");
const VALID_AUTH_MODES = new Set(["sso", "local", "either"]);
const VALID_STATUSES = new Set(["active", "disabled"]);
const VALID_GROUPS = new Set(["admins", "analysts"]);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeName(value) {
  return String(value || "").trim();
}

function normalizeAuthMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return VALID_AUTH_MODES.has(mode) ? mode : "";
}

function normalizeStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return VALID_STATUSES.has(status) ? status : "active";
}

function normalizeGroups(values) {
  const source = Array.isArray(values) ? values : [values];
  const groups = source
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => VALID_GROUPS.has(item));

  if (groups.includes("admins") && !groups.includes("analysts")) {
    groups.push("analysts");
  }

  if (groups.length === 0) {
    return ["analysts"];
  }

  return Array.from(new Set(groups));
}

function roleListFromGroups(groups) {
  const normalized = normalizeGroups(groups);
  const roles = new Set();
  if (normalized.includes("admins")) {
    roles.add("admin");
    roles.add("analyst");
  }
  if (normalized.includes("analysts")) {
    roles.add("analyst");
  }
  return Array.from(roles);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { passwordHash: hash, passwordSalt: salt };
}

function verifyPassword(password, passwordSalt, passwordHash) {
  if (!passwordSalt || !passwordHash) {
    return false;
  }

  const derived = crypto.scryptSync(String(password), passwordSalt, 64).toString("hex");
  const left = Buffer.from(passwordHash, "hex");
  const right = Buffer.from(derived, "hex");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function getPasswordPolicy(minLength = 12) {
  return {
    minLength,
    requireUpper: true,
    requireLower: true,
    requireNumber: true,
    requireSymbol: true
  };
}

function validatePassword(password, minLength = 12) {
  const candidate = String(password || "");
  if (candidate.length < minLength) {
    return `Password must be at least ${minLength} characters.`;
  }
  if (!/[A-Z]/.test(candidate)) {
    return "Password must include at least one uppercase letter.";
  }
  if (!/[a-z]/.test(candidate)) {
    return "Password must include at least one lowercase letter.";
  }
  if (!/[0-9]/.test(candidate)) {
    return "Password must include at least one number.";
  }
  if (!/[^A-Za-z0-9]/.test(candidate)) {
    return "Password must include at least one symbol.";
  }
  return "";
}

function generateTemporaryPassword(minLength = 12) {
  const uppercase = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lowercase = "abcdefghijkmnopqrstuvwxyz";
  const numbers = "23456789";
  const symbols = "!@#$%^&*()_-+=?";
  const all = `${uppercase}${lowercase}${numbers}${symbols}`;
  const targetLength = Math.max(16, minLength);
  const seed = [
    uppercase[Math.floor(Math.random() * uppercase.length)],
    lowercase[Math.floor(Math.random() * lowercase.length)],
    numbers[Math.floor(Math.random() * numbers.length)],
    symbols[Math.floor(Math.random() * symbols.length)]
  ];

  while (seed.length < targetLength) {
    seed.push(all[Math.floor(Math.random() * all.length)]);
  }

  for (let i = seed.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [seed[i], seed[j]] = [seed[j], seed[i]];
  }

  return seed.join("");
}

function parseTime(value) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    authMode: user.authMode,
    groups: user.groups,
    roles: roleListFromGroups(user.groups),
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null,
    failedLoginCount: Number(user.failedLoginCount) || 0,
    lastFailedLoginAt: user.lastFailedLoginAt || null,
    lockedUntil: user.lockedUntil || null,
    mustResetPassword: Boolean(user.mustResetPassword),
    passwordChangedAt: user.passwordChangedAt || null
  };
}

function normalizeStoredUser(input = {}) {
  const authMode = normalizeAuthMode(input.authMode) || "sso";
  const now = new Date().toISOString();
  return {
    id: String(input.id || crypto.randomUUID()),
    name: normalizeName(input.name) || "Unnamed user",
    email: normalizeEmail(input.email),
    authMode,
    groups: normalizeGroups(input.groups),
    status: normalizeStatus(input.status),
    createdAt: String(input.createdAt || now),
    updatedAt: String(input.updatedAt || now),
    lastLoginAt: input.lastLoginAt ? String(input.lastLoginAt) : null,
    passwordHash: String(input.passwordHash || ""),
    passwordSalt: String(input.passwordSalt || ""),
    failedLoginCount: Number.isFinite(Number(input.failedLoginCount)) ? Math.max(0, Number(input.failedLoginCount)) : 0,
    lastFailedLoginAt: input.lastFailedLoginAt ? String(input.lastFailedLoginAt) : null,
    lockedUntil: input.lockedUntil ? String(input.lockedUntil) : null,
    mustResetPassword: Boolean(input.mustResetPassword),
    passwordChangedAt: input.passwordChangedAt ? String(input.passwordChangedAt) : null
  };
}

function createLocalUserDirectory(options = {}) {
  const filePath = options.filePath ? path.resolve(options.filePath) : DEFAULT_LOCAL_USERS_PATH;
  const backupFilePath = `${filePath}.bak`;
  const bootstrap = options.bootstrap || {};
  const minPasswordLength = Number.isFinite(Number(options.passwordMinLength))
    ? Math.max(12, Number(options.passwordMinLength))
    : 12;
  const lockoutPolicy = {
    enabled: options.lockout ? options.lockout.enabled !== false : true,
    maxAttempts: Number.isFinite(Number(options.lockout && options.lockout.maxAttempts))
      ? Math.max(3, Number(options.lockout.maxAttempts))
      : 5,
    windowMs: Number.isFinite(Number(options.lockout && options.lockout.windowMs))
      ? Math.max(1000, Number(options.lockout.windowMs))
      : 15 * 60 * 1000,
    lockMs: Number.isFinite(Number(options.lockout && options.lockout.lockMs))
      ? Math.max(1000, Number(options.lockout.lockMs))
      : 15 * 60 * 1000
  };

  let users = [];
  let initialized = false;

  function clearFailureState(user) {
    user.failedLoginCount = 0;
    user.lastFailedLoginAt = null;
    user.lockedUntil = null;
  }

  async function persist() {
    const folder = path.dirname(filePath);
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const payload = JSON.stringify({ version: 1, users }, null, 2);
    await mkdir(folder, { recursive: true });
    await writeFile(tempPath, payload, "utf8");

    try {
      await access(filePath);
      await copyFile(filePath, backupFilePath);
    } catch (_error) {
    }

    try {
      await rename(tempPath, filePath);
    } catch (error) {
      if (error && (error.code === "EEXIST" || error.code === "EPERM")) {
        await unlink(filePath).catch(() => {});
        await rename(tempPath, filePath);
      } else {
        throw error;
      }
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  }

  function parseStore(raw, sourceLabel) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Local user directory JSON parse failed (${sourceLabel}): ${error.message}`);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Local user directory is invalid (${sourceLabel}).`);
    }

    if (!Array.isArray(parsed.users)) {
      return [];
    }

    return parsed.users
      .map((item) => normalizeStoredUser(item))
      .filter((item) => item.email);
  }

  async function loadFromFile(targetPath, sourceLabel) {
    const raw = await readFile(targetPath, "utf8");
    return parseStore(raw, sourceLabel);
  }

  async function loadUsers() {
    try {
      const primaryUsers = await loadFromFile(filePath, "primary");
      return { users: primaryUsers, loadedFromBackup: false };
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { users: [], loadedFromBackup: false };
      }

      try {
        const backupUsers = await loadFromFile(backupFilePath, "backup");
        return { users: backupUsers, loadedFromBackup: true };
      } catch (backupError) {
        throw new Error(`Failed to load local user directory. ${error.message} Backup load error: ${backupError.message}`);
      }
    }
  }

  async function ensureReady() {
    if (initialized) {
      return;
    }

    const loaded = await loadUsers();
    users = loaded.users;

    if (users.length === 0 && bootstrap.enabled) {
      const initialPassword = String(bootstrap.password || "").trim();
      const passwordError = validatePassword(initialPassword, minPasswordLength);
      if (passwordError) {
        throw new Error(`LOCAL_BOOTSTRAP_ADMIN_PASSWORD is invalid: ${passwordError}`);
      }

      const now = new Date().toISOString();
      const passwordInfo = hashPassword(initialPassword);
      users.push({
        id: crypto.randomUUID(),
        name: normalizeName(bootstrap.name) || "Local Administrator",
        email: normalizeEmail(bootstrap.email) || "admin@kontoso.com",
        authMode: "local",
        groups: ["admins", "analysts"],
        status: "active",
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
        passwordHash: passwordInfo.passwordHash,
        passwordSalt: passwordInfo.passwordSalt,
        failedLoginCount: 0,
        lastFailedLoginAt: null,
        lockedUntil: null,
        mustResetPassword: true,
        passwordChangedAt: null
      });
      await persist();
    } else if (loaded.loadedFromBackup) {
      await persist();
    }

    initialized = true;
  }

  function findByEmail(email) {
    const normalized = normalizeEmail(email);
    return users.find((user) => user.email === normalized) || null;
  }

  function findById(id) {
    return users.find((user) => user.id === id) || null;
  }

  function getCachedUserById(id) {
    const user = findById(id);
    return user ? toPublicUser(user) : null;
  }

  function getLockoutResponse(user) {
    return {
      ok: false,
      statusCode: 423,
      code: "account_locked",
      error: "Account is locked due to repeated failed sign-in attempts.",
      lockedUntil: user.lockedUntil || null
    };
  }

  async function listUsers() {
    await ensureReady();
    return users.map(toPublicUser);
  }

  async function createUser(input = {}) {
    await ensureReady();
    const name = normalizeName(input.name);
    const email = normalizeEmail(input.email);
    const authMode = normalizeAuthMode(input.authMode);
    const groups = normalizeGroups(input.groups);
    const status = normalizeStatus(input.status);
    const password = String(input.password || "");
    const mustResetPassword = Boolean(input.mustResetPassword);

    if (!name) {
      return { ok: false, statusCode: 400, code: "invalid_name", error: "Name is required." };
    }

    if (!email || !email.includes("@")) {
      return { ok: false, statusCode: 400, code: "invalid_email", error: "A valid email is required." };
    }

    if (!authMode) {
      return { ok: false, statusCode: 400, code: "invalid_auth_mode", error: "authMode must be one of: sso, local, either." };
    }

    if (findByEmail(email)) {
      return { ok: false, statusCode: 409, code: "duplicate_user", error: "User already exists for this email." };
    }

    if (authMode === "local" || authMode === "either") {
      const passwordError = validatePassword(password, minPasswordLength);
      if (passwordError) {
        return { ok: false, statusCode: 400, code: "invalid_password", error: passwordError };
      }
    }

    const now = new Date().toISOString();
    const next = {
      id: crypto.randomUUID(),
      name,
      email,
      authMode,
      groups,
      status,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
      mustResetPassword: authMode === "sso" ? false : mustResetPassword,
      passwordChangedAt: null
    };

    if (authMode === "local" || authMode === "either") {
      const passwordInfo = hashPassword(password);
      next.passwordHash = passwordInfo.passwordHash;
      next.passwordSalt = passwordInfo.passwordSalt;
      next.passwordChangedAt = now;
    } else {
      next.passwordHash = "";
      next.passwordSalt = "";
      next.passwordChangedAt = null;
    }

    users.push(next);
    await persist();
    return { ok: true, user: toPublicUser(next) };
  }

  async function updateUser(id, updates = {}) {
    await ensureReady();
    const user = findById(id);
    if (!user) {
      return { ok: false, statusCode: 404, code: "not_found", error: "User not found." };
    }

    const nextName = updates.name !== undefined ? normalizeName(updates.name) : user.name;
    const nextAuthMode = updates.authMode !== undefined ? normalizeAuthMode(updates.authMode) : user.authMode;
    const nextGroups = updates.groups !== undefined ? normalizeGroups(updates.groups) : user.groups;
    const nextStatus = updates.status !== undefined ? normalizeStatus(updates.status) : user.status;
    const nextPassword = updates.password !== undefined ? String(updates.password || "") : "";
    const mustResetPassword = updates.mustResetPassword !== undefined ? Boolean(updates.mustResetPassword) : user.mustResetPassword;

    if (!nextName) {
      return { ok: false, statusCode: 400, code: "invalid_name", error: "Name cannot be empty." };
    }

    if (!nextAuthMode) {
      return { ok: false, statusCode: 400, code: "invalid_auth_mode", error: "authMode must be one of: sso, local, either." };
    }

    if (updates.password !== undefined) {
      if (nextAuthMode === "sso") {
        return { ok: false, statusCode: 400, code: "password_not_allowed", error: "SSO-only users cannot store local passwords." };
      }
      const passwordError = validatePassword(nextPassword, minPasswordLength);
      if (passwordError) {
        return { ok: false, statusCode: 400, code: "invalid_password", error: passwordError };
      }
      if (verifyPassword(nextPassword, user.passwordSalt, user.passwordHash)) {
        return { ok: false, statusCode: 400, code: "password_reuse_not_allowed", error: "New password must be different from the current password." };
      }
      const hashed = hashPassword(nextPassword);
      user.passwordHash = hashed.passwordHash;
      user.passwordSalt = hashed.passwordSalt;
      user.passwordChangedAt = new Date().toISOString();
      clearFailureState(user);
    }

    if ((nextAuthMode === "local" || nextAuthMode === "either") && (!user.passwordHash || !user.passwordSalt)) {
      return { ok: false, statusCode: 400, code: "password_required", error: "Local-enabled users must have a password set." };
    }

    if (nextAuthMode === "sso") {
      user.passwordHash = "";
      user.passwordSalt = "";
      user.passwordChangedAt = null;
      user.mustResetPassword = false;
      clearFailureState(user);
    } else {
      user.mustResetPassword = mustResetPassword;
    }

    if (updates.unlock) {
      clearFailureState(user);
    }

    user.name = nextName;
    user.authMode = nextAuthMode;
    user.groups = nextGroups;
    user.status = nextStatus;
    user.updatedAt = new Date().toISOString();

    await persist();
    return { ok: true, user: toPublicUser(user) };
  }

  async function verifyLocalCredentials(email, password) {
    await ensureReady();
    const user = findByEmail(email);
    if (!user) {
      return { ok: false, statusCode: 401, code: "invalid_credentials", error: "Invalid email or password." };
    }

    if (user.status !== "active") {
      return { ok: false, statusCode: 403, code: "account_disabled", error: "Account is disabled." };
    }

    if (!["local", "either"].includes(user.authMode)) {
      return { ok: false, statusCode: 403, code: "password_login_not_allowed", error: "This account does not allow password sign-in." };
    }

    const nowMs = Date.now();
    const lockUntilMs = parseTime(user.lockedUntil);
    if (lockUntilMs && lockUntilMs > nowMs) {
      return getLockoutResponse(user);
    }

    if (lockUntilMs && lockUntilMs <= nowMs) {
      clearFailureState(user);
    }

    const passwordOk = verifyPassword(password, user.passwordSalt, user.passwordHash);
    if (!passwordOk) {
      const nowIso = new Date(nowMs).toISOString();
      const lastFailedMs = parseTime(user.lastFailedLoginAt);
      const withinWindow = lastFailedMs ? nowMs - lastFailedMs <= lockoutPolicy.windowMs : false;
      const nextFailedCount = withinWindow ? (Number(user.failedLoginCount) || 0) + 1 : 1;
      user.failedLoginCount = nextFailedCount;
      user.lastFailedLoginAt = nowIso;

      if (lockoutPolicy.enabled && nextFailedCount >= lockoutPolicy.maxAttempts) {
        user.lockedUntil = new Date(nowMs + lockoutPolicy.lockMs).toISOString();
      }

      user.updatedAt = nowIso;
      await persist();

      if (user.lockedUntil) {
        return getLockoutResponse(user);
      }

      return { ok: false, statusCode: 401, code: "invalid_credentials", error: "Invalid email or password." };
    }

    clearFailureState(user);
    user.lastLoginAt = new Date(nowMs).toISOString();
    user.updatedAt = user.lastLoginAt;
    await persist();
    return { ok: true, user: toPublicUser(user) };
  }

  async function resolveUserForSso(email) {
    await ensureReady();
    const user = findByEmail(email);
    if (!user) {
      return { ok: false, code: "directory_user_missing", error: "User is not provisioned in the local directory." };
    }

    if (user.status !== "active") {
      return { ok: false, code: "account_disabled", error: "Account is disabled." };
    }

    if (!["sso", "either"].includes(user.authMode)) {
      return { ok: false, code: "sso_not_allowed", error: "This account does not allow SSO sign-in." };
    }

    user.lastLoginAt = new Date().toISOString();
    user.updatedAt = user.lastLoginAt;
    await persist();
    return { ok: true, user: toPublicUser(user) };
  }

  async function changePassword(userId, currentPassword, newPassword) {
    await ensureReady();
    const user = findById(userId);
    if (!user) {
      return { ok: false, statusCode: 404, code: "not_found", error: "User not found." };
    }

    if (!["local", "either"].includes(user.authMode)) {
      return { ok: false, statusCode: 400, code: "password_login_not_allowed", error: "This account does not allow password sign-in." };
    }

    const passwordError = validatePassword(newPassword, minPasswordLength);
    if (passwordError) {
      return { ok: false, statusCode: 400, code: "invalid_password", error: passwordError };
    }

    const currentMatches = verifyPassword(currentPassword, user.passwordSalt, user.passwordHash);
    if (!currentMatches) {
      return { ok: false, statusCode: 401, code: "invalid_current_password", error: "Current password is incorrect." };
    }
    if (verifyPassword(newPassword, user.passwordSalt, user.passwordHash)) {
      return { ok: false, statusCode: 400, code: "password_reuse_not_allowed", error: "New password must be different from the current password." };
    }

    const hashed = hashPassword(newPassword);
    user.passwordHash = hashed.passwordHash;
    user.passwordSalt = hashed.passwordSalt;
    user.passwordChangedAt = new Date().toISOString();
    user.mustResetPassword = false;
    user.updatedAt = user.passwordChangedAt;
    clearFailureState(user);
    await persist();
    return { ok: true, user: toPublicUser(user) };
  }

  async function resetUserPassword(userId, options = {}) {
    await ensureReady();
    const user = findById(userId);
    if (!user) {
      return { ok: false, statusCode: 404, code: "not_found", error: "User not found." };
    }

    if (!["local", "either"].includes(user.authMode)) {
      return { ok: false, statusCode: 400, code: "password_login_not_allowed", error: "This account does not allow password sign-in." };
    }

    const providedPassword = String(options.password || "").trim();
    let temporaryPassword = providedPassword;
    if (!temporaryPassword) {
      temporaryPassword = generateTemporaryPassword(minPasswordLength);
      let attempts = 0;
      while (verifyPassword(temporaryPassword, user.passwordSalt, user.passwordHash) && attempts < 4) {
        temporaryPassword = generateTemporaryPassword(minPasswordLength);
        attempts += 1;
      }
    }
    const passwordError = validatePassword(temporaryPassword, minPasswordLength);
    if (passwordError) {
      return { ok: false, statusCode: 400, code: "invalid_password", error: passwordError };
    }
    if (verifyPassword(temporaryPassword, user.passwordSalt, user.passwordHash)) {
      return { ok: false, statusCode: 400, code: "password_reuse_not_allowed", error: "Temporary password must be different from the current password." };
    }

    const hashed = hashPassword(temporaryPassword);
    user.passwordHash = hashed.passwordHash;
    user.passwordSalt = hashed.passwordSalt;
    user.passwordChangedAt = new Date().toISOString();
    user.mustResetPassword = options.mustResetPassword !== undefined ? Boolean(options.mustResetPassword) : true;
    user.updatedAt = user.passwordChangedAt;
    clearFailureState(user);
    await persist();

    return {
      ok: true,
      user: toPublicUser(user),
      temporaryPassword
    };
  }

  return {
    ensureReady,
    listUsers,
    createUser,
    updateUser,
    verifyLocalCredentials,
    resolveUserForSso,
    changePassword,
    resetUserPassword,
    getCachedUserById,
    roleListFromGroups,
    getPasswordPolicy: () => getPasswordPolicy(minPasswordLength),
    getLockoutPolicy: () => ({
      maxAttempts: lockoutPolicy.maxAttempts,
      windowMinutes: Math.round(lockoutPolicy.windowMs / 60000),
      lockMinutes: Math.round(lockoutPolicy.lockMs / 60000),
      windowSeconds: Math.round(lockoutPolicy.windowMs / 1000),
      lockSeconds: Math.round(lockoutPolicy.lockMs / 1000)
    })
  };
}

module.exports = {
  createLocalUserDirectory,
  roleListFromGroups,
  getPasswordPolicy
};
