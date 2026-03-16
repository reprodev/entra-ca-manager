// e2e check: onboarding validation endpoint
// Verifies that POST /api/onboarding/validate rejects missing/incomplete credentials
// and returns the expected error shape. Does not require real Azure credentials.

const { createServer } = require("../src/server");

const PORT = 3099;
const BASE = `http://localhost:${PORT}`;

async function postJson(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  return { status: response.status, data };
}

function assert(label, condition, details) {
  if (!condition) {
    process.stderr.write(`FAIL [${label}]: ${details}\n`);
    process.exit(1);
  }
  process.stdout.write(`  ok  ${label}\n`);
}

async function run() {
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  process.stdout.write(`Onboarding e2e check — server on port ${PORT}\n`);

  try {
    // 1. Missing all fields
    const r1 = await postJson("/api/onboarding/validate", {});
    assert("missing fields → 400", r1.status === 400, JSON.stringify(r1.data));
    assert("missing fields → ok=false", r1.data.ok === false, JSON.stringify(r1.data));
    assert("missing fields → checks.fieldsPresent=false", r1.data.checks && r1.data.checks.fieldsPresent === false, JSON.stringify(r1.data));

    // 2. Partial fields (no clientSecret)
    const r2 = await postJson("/api/onboarding/validate", {
      tenantId: "test-tenant-id",
      clientId: "test-client-id"
    });
    assert("partial fields → 400", r2.status === 400, JSON.stringify(r2.data));
    assert("partial fields → ok=false", r2.data.ok === false, JSON.stringify(r2.data));

    // 3. Invalid JSON body
    const raw = await fetch(`${BASE}/api/onboarding/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json"
    });
    assert("invalid json → 400", raw.status === 400, `status=${raw.status}`);

    // 4. Route shape — all fields present but credentials bogus → tokenAcquired=false (not a 400)
    const r4 = await postJson("/api/onboarding/validate", {
      tenantId: "00000000-0000-0000-0000-000000000000",
      clientId: "00000000-0000-0000-0000-000000000001",
      clientSecret: "bogus-secret"
    });
    assert("bogus creds → ok=false", r4.data.ok === false, JSON.stringify(r4.data));
    assert("bogus creds → checks.fieldsPresent=true", r4.data.checks && r4.data.checks.fieldsPresent === true, JSON.stringify(r4.data));
    assert("bogus creds → checks.tokenAcquired=false", r4.data.checks && r4.data.checks.tokenAcquired === false, JSON.stringify(r4.data));

    process.stdout.write("All onboarding e2e checks passed.\n");
  } finally {
    server.close();
  }
}

run().catch((err) => {
  process.stderr.write(`Onboarding e2e check error: ${err.message}\n`);
  process.exit(1);
});
