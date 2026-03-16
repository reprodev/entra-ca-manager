// e2e check: duplicate-safe calendar sync response shape
// Verifies that calendarSync responses always include the dedup fields
// (deduplicated, skippedCount, skippedEvents) regardless of whether
// sync runs. Does not require real Azure credentials.

const { createServer } = require("../src/server");

const PORT = 3098;
const BASE = `http://localhost:${PORT}`;

function assert(label, condition, details) {
  if (!condition) {
    process.stderr.write(`FAIL [${label}]: ${details}\n`);
    process.exit(1);
  }
  process.stdout.write(`  ok  ${label}\n`);
}

function assertField(obj, field, label) {
  assert(label || `has field: ${field}`, field in obj, `missing field "${field}" in ${JSON.stringify(obj)}`);
}

async function run() {
  delete process.env.ENABLE_LIVE_GRAPH;
  delete process.env.ENABLE_CALENDAR_INTEGRATION;
  delete process.env.CALENDAR_TARGET_USER;
  delete process.env.AZURE_TENANT_ID;
  delete process.env.AZURE_CLIENT_ID;
  delete process.env.AZURE_CLIENT_SECRET;
  delete process.env.GRAPH_ACCESS_TOKEN;
  delete process.env.TENANTS_JSON;

  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  process.stdout.write(`Calendar dedup e2e check — server on port ${PORT}\n`);

  try {
    // 1. Preview (no sync) — verify base dedup fields are present
    const previewRes = await fetch(`${BASE}/api/management/reminders`);
    const preview = await previewRes.json();
    assert("preview → 200", previewRes.status === 200, `status=${previewRes.status}`);
    assertField(preview.calendarSync, "requested");
    assertField(preview.calendarSync, "executed");
    assertField(preview.calendarSync, "deduplicated");
    assertField(preview.calendarSync, "skippedCount");
    assertField(preview.calendarSync, "skippedEvents");
    assert("preview → requested=false", preview.calendarSync.requested === false, JSON.stringify(preview.calendarSync));
    assert("preview → skippedEvents is array", Array.isArray(preview.calendarSync.skippedEvents), JSON.stringify(preview.calendarSync));

    // 2. Sync=true in demo mode — calendar integration disabled → dedup fields still present
    const syncRes = await fetch(`${BASE}/api/management/reminders?sync=true`);
    const sync = await syncRes.json();
    assert("sync demo → 200", syncRes.status === 200, `status=${syncRes.status}`);
    assertField(sync.calendarSync, "deduplicated");
    assertField(sync.calendarSync, "skippedCount");
    assertField(sync.calendarSync, "skippedEvents");
    assert("sync demo → requested=true", sync.calendarSync.requested === true, JSON.stringify(sync.calendarSync));
    assert("sync demo → executed=false (disabled)", sync.calendarSync.executed === false, JSON.stringify(sync.calendarSync));
    assert("sync demo → skippedCount=0", sync.calendarSync.skippedCount === 0, JSON.stringify(sync.calendarSync));
    assert("sync demo → skippedEvents=[]", Array.isArray(sync.calendarSync.skippedEvents) && sync.calendarSync.skippedEvents.length === 0, JSON.stringify(sync.calendarSync));

    // 3. Verify reminderPlan reminders each have a transactionId (required for dedup keying)
    const reminders = sync.reminderPlan && sync.reminderPlan.reminders;
    assert("reminders present", Array.isArray(reminders) && reminders.length > 0, JSON.stringify(sync.reminderPlan));
    const missingTxId = reminders.filter((r) => !r.transactionId);
    assert("all reminders have transactionId", missingTxId.length === 0, `${missingTxId.length} reminders missing transactionId`);

    // 4. Verify all transactionIds are unique (dedup relies on this)
    const txIds = reminders.map((r) => r.transactionId);
    const uniqueTxIds = new Set(txIds);
    assert("transactionIds are unique", uniqueTxIds.size === txIds.length, `${txIds.length - uniqueTxIds.size} collisions`);

    process.stdout.write("All calendar dedup e2e checks passed.\n");
  } finally {
    server.close();
  }
}

run().catch((err) => {
  process.stderr.write(`Calendar dedup e2e check error: ${err.message}\n`);
  process.exit(1);
});
