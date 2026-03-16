const crypto = require("crypto");
const path = require("path");
const { appendFile, mkdir, readFile } = require("fs/promises");
const { getAuditLogConfig } = require("./runtimeConfig");

const DEFAULT_AUDIT_FILE = path.resolve(__dirname, "..", "..", "data", "audit", "auth-admin-audit.log.jsonl");

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    const fields = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${fields.join(",")}}`;
  }

  return JSON.stringify(value);
}

function createNoopAuditLogger() {
  return {
    enabled: false,
    log: async () => {}
  };
}

function createAuditLogger(options = {}) {
  const config = options.config || getAuditLogConfig();
  if (!config.enabled) {
    return createNoopAuditLogger();
  }

  const filePath = config.filePath ? path.resolve(config.filePath) : DEFAULT_AUDIT_FILE;
  const secret = String(config.secret || process.env.SESSION_SECRET || "cam-audit-default-secret");
  const fileDirectory = path.dirname(filePath);
  let previousHash = "GENESIS";
  let writeQueue = Promise.resolve();

  const readyPromise = (async () => {
    await mkdir(fileDirectory, { recursive: true });
    try {
      const raw = await readFile(filePath, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);
      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1];
        const parsed = JSON.parse(lastLine);
        if (parsed && parsed.hash) {
          previousHash = String(parsed.hash);
        }
      }
    } catch (_error) {
    }
  })();

  function normalizeActor(actor = {}) {
    return {
      type: String(actor.type || "system"),
      id: String(actor.id || ""),
      email: String(actor.email || "")
    };
  }

  function normalizeRequestContext(request = {}) {
    return {
      ip: String(request.ip || ""),
      userAgent: String(request.userAgent || ""),
      requestId: String(request.requestId || ""),
      route: String(request.route || "")
    };
  }

  async function log(event = {}) {
    writeQueue = writeQueue.then(async () => {
      await readyPromise;
      const entryBase = {
        time: new Date().toISOString(),
        eventType: String(event.eventType || "unknown_event"),
        outcome: String(event.outcome || "unknown"),
        actor: normalizeActor(event.actor),
        request: normalizeRequestContext(event.request),
        details: event.details && typeof event.details === "object" ? event.details : {},
        prevHash: previousHash
      };
      const payload = stableStringify(entryBase);
      const hash = crypto
        .createHash("sha256")
        .update(`${secret}|${entryBase.prevHash}|${payload}`)
        .digest("hex");
      const finalEntry = { ...entryBase, hash };
      previousHash = hash;
      await appendFile(filePath, `${JSON.stringify(finalEntry)}\n`, "utf8");
    }).catch(() => {});

    return writeQueue;
  }

  return {
    enabled: true,
    filePath,
    log
  };
}

module.exports = {
  createAuditLogger
};
