const path = require("path");
const { readFile } = require("fs/promises");

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

async function run() {
  const filePath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, "..", "data", "audit", "auth-admin-audit.log.jsonl");
  const secret = String(process.env.AUDIT_LOG_SECRET || process.env.SESSION_SECRET || "cam-audit-default-secret");

  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      process.stdout.write(`Audit log not found: ${filePath}\n`);
      return;
    }
    throw error;
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  let previousHash = "GENESIS";
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let parsed;
    try {
      parsed = JSON.parse(lines[index]);
    } catch (error) {
      throw new Error(`Invalid JSON at line ${lineNumber}: ${error.message}`);
    }

    if (String(parsed.prevHash || "") !== previousHash) {
      throw new Error(`Hash chain mismatch at line ${lineNumber}: expected prevHash=${previousHash}`);
    }

    const base = {
      time: parsed.time,
      eventType: parsed.eventType,
      outcome: parsed.outcome,
      actor: parsed.actor,
      request: parsed.request,
      details: parsed.details,
      prevHash: parsed.prevHash
    };
    const payload = stableStringify(base);
    const computed = require("crypto")
      .createHash("sha256")
      .update(`${secret}|${parsed.prevHash}|${payload}`)
      .digest("hex");

    if (computed !== parsed.hash) {
      throw new Error(`Hash mismatch at line ${lineNumber}`);
    }

    previousHash = parsed.hash;
  }

  process.stdout.write(`Audit log chain verified (${lines.length} entries): ${filePath}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
