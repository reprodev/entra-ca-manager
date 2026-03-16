// e2e check: travel-rule scheduler
// Tests CRUD routes, tick evaluation, and live-mode policy patching
// via a stub Graph server (no real Azure credentials needed).

const http = require("http");
const { createServer } = require("../src/server");
const { _resetStore } = require("../src/api/travelRules");

function startServer(server, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function stopServer(server) {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

function assert(label, condition, details) {
  if (!condition) {
    process.stderr.write(`FAIL [${label}]: ${details}\n`);
    process.exit(1);
  }
  process.stdout.write(`  ok  ${label}\n`);
}

// ── Part 1: demo-mode CRUD & tick ────────────────────────────────────────────

async function runDemoChecks() {
  delete process.env.ENABLE_LIVE_GRAPH;
  delete process.env.GRAPH_ACCESS_TOKEN;
  delete process.env.AZURE_TENANT_ID;
  delete process.env.AZURE_CLIENT_ID;
  delete process.env.AZURE_CLIENT_SECRET;
  delete process.env.TENANTS_JSON;

  _resetStore();
  const server = createServer();
  const port = await startServer(server, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  process.stdout.write(`Demo-mode travel checks — port ${port}\n`);

  try {
    // List demo seed rules
    const list1 = await (await fetch(`${base}/api/travel`)).json();
    assert("list → ok=true", list1.ok === true, JSON.stringify(list1));
    assert("list → 3 demo rules", list1.count === 3, `count=${list1.count}`);
    assert("list → rules is array", Array.isArray(list1.rules), "");

    // Create a new rule
    const cr = await fetch(`${base}/api/travel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: "test-tenant",
        userEmail: "alice@test.com",
        userName: "Alice",
        departureDate: "2027-06-01",
        returnDate: "2027-06-15",
        travelAction: "enabled",
        revertAction: "disabled"
      })
    });
    const created = await cr.json();
    assert("create → 201", cr.status === 201, `status=${cr.status}`);
    assert("create → ok=true", created.ok === true, JSON.stringify(created));
    assert("create → has id", typeof created.rule.id === "string" && created.rule.id.length > 0, JSON.stringify(created.rule));
    assert("create → status=scheduled", created.rule.status === "scheduled", created.rule.status);
    const ruleId = created.rule.id;

    // Validate — missing required field
    const bad = await fetch(`${base}/api/travel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: "x", userEmail: "x@x.com", departureDate: "2027-01-01" })
    });
    assert("create missing returnDate → 400", bad.status === 400, `status=${bad.status}`);

    // Validate — returnDate before departureDate
    const badDates = await fetch(`${base}/api/travel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: "x", userEmail: "x@x.com",
        departureDate: "2027-06-15", returnDate: "2027-06-01"
      })
    });
    assert("create inverted dates → 400", badDates.status === 400, `status=${badDates.status}`);

    // Extend
    const ext = await fetch(`${base}/api/travel/${ruleId}/extend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnDate: "2027-06-20" })
    });
    const extended = await ext.json();
    assert("extend → ok=true", extended.ok === true, JSON.stringify(extended));
    assert("extend → new returnDate", extended.rule.returnDate === "2027-06-20", extended.rule.returnDate);

    // Cancel
    const del = await fetch(`${base}/api/travel/${ruleId}`, { method: "DELETE" });
    const cancelled = await del.json();
    assert("cancel → ok=true", cancelled.ok === true, JSON.stringify(cancelled));
    assert("cancel → status=cancelled", cancelled.rule.status === "cancelled", cancelled.rule.status);

    // Cancel again → 409
    const del2 = await fetch(`${base}/api/travel/${ruleId}`, { method: "DELETE" });
    assert("cancel again → 409", del2.status === 409, `status=${del2.status}`);

    // Cancel missing id → 404
    const del3 = await fetch(`${base}/api/travel/not-a-real-id`, { method: "DELETE" });
    assert("cancel missing → 404", del3.status === 404, `status=${del3.status}`);

    // Demo-mode tick
    const tick = await (await fetch(`${base}/api/travel/tick`, { method: "POST" })).json();
    assert("tick → ok=true", tick.ok === true, JSON.stringify(tick));
    assert("tick → mode=demo", tick.mode === "demo", tick.mode);
    assert("tick → has activatedCount", typeof tick.activatedCount === "number", JSON.stringify(tick));
    assert("tick → has completedCount", typeof tick.completedCount === "number", JSON.stringify(tick));
    assert("tick → activated is array", Array.isArray(tick.activated), "");
    assert("tick → completed is array", Array.isArray(tick.completed), "");
    assert("tick → errors is array", Array.isArray(tick.errors), "");

    process.stdout.write("Demo-mode checks passed.\n");
  } finally {
    await stopServer(server);
  }
}

// ── Part 2: tick activates a scheduled rule in demo mode ─────────────────────

async function runTickActivationCheck() {
  delete process.env.ENABLE_LIVE_GRAPH;

  _resetStore();
  const server = createServer();
  const port = await startServer(server, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  process.stdout.write(`Tick activation check — port ${port}\n`);

  try {
    // Create a rule with departure = yesterday, return = next month
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    const cr = await fetch(`${base}/api/travel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: "t1", userEmail: "bob@t1.com",
        departureDate: yesterday, returnDate: nextMonth,
        policyIds: ["policy-x"], travelAction: "enabled", revertAction: "disabled"
      })
    });
    const created = await cr.json();
    assert("setup rule → scheduled", created.rule.status === "scheduled", created.rule.status);
    const ruleId = created.rule.id;

    // Tick — should activate because departure is in the past
    const tick = await (await fetch(`${base}/api/travel/tick`, { method: "POST" })).json();
    assert("tick activates past-departure rule", tick.activatedCount >= 1, `activatedCount=${tick.activatedCount}`);

    const activated = tick.activated.find((a) => a.ruleId === ruleId);
    assert("activated entry present", Boolean(activated), JSON.stringify(tick.activated));
    assert("activated mode=demo", activated.mode === "demo", JSON.stringify(activated));

    // Verify rule is now active in list
    const list = await (await fetch(`${base}/api/travel`)).json();
    const rule = list.rules.find((r) => r.id === ruleId);
    assert("rule is now active/expiring", rule && (rule.status === "active" || rule.status === "expiring"), rule && rule.status);

    process.stdout.write("Tick activation checks passed.\n");
  } finally {
    await stopServer(server);
  }
}

// ── Part 3: tick completes a rule and patches Graph (live mode) ───────────────

async function runLiveTickCheck() {
  const patches = [];

  const graphServer = http.createServer((req, res) => {
    // Auth token endpoint
    if (req.method === "POST" && req.url.includes("/oauth2/v2.0/token")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "live-test-token", expires_in: 3600 }));
      return;
    }

    // PATCH policy state
    if (req.method === "PATCH" && req.url.startsWith("/identity/conditionalAccess/policies/")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        patches.push({ url: req.url, body: JSON.parse(body || "{}") });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "policy-live-001", state: JSON.parse(body || "{}").state }));
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found" } }));
  });

  _resetStore();
  let appServer;
  try {
    const graphPort = await startServer(graphServer, "127.0.0.1");
    process.env.GRAPH_API_BASE = `http://127.0.0.1:${graphPort}`;
    process.env.GRAPH_ACCESS_TOKEN = "live-test-token";
    process.env.AZURE_TENANT_ID = "live-tenant-id";
    process.env.AZURE_CLIENT_ID = "";
    process.env.AZURE_CLIENT_SECRET = "";
    process.env.TENANTS_JSON = JSON.stringify([{
      id: "live-tenant-id", name: "Live Tenant", domain: "live.example.com",
      tenantId: "live-tenant-id", clientId: "", clientSecret: "",
      accessToken: "live-test-token", isDemo: false
    }]);
    process.env.ENABLE_LIVE_GRAPH = "true";

    appServer = createServer({ graphBaseUrl: process.env.GRAPH_API_BASE });
    const port = await startServer(appServer, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    process.stdout.write(`Live-mode tick check — port ${port}\n`);

    // Create a rule with departure=yesterday, return=next week
    // Tick should activate it (departure passed) and PATCH Graph with travelAction
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    const cr = await fetch(`${base}/api/travel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: "live-tenant-id", userEmail: "carol@live.example.com",
        departureDate: yesterday, returnDate: nextWeek,
        policyIds: ["policy-live-001"], travelAction: "enabled", revertAction: "disabled"
      })
    });
    const created = await cr.json();
    assert("live setup → rule created", created.ok === true, JSON.stringify(created));

    // Tick — departure is past so rule should activate and PATCH Graph
    const tick = await (await fetch(`${base}/api/travel/tick`, { method: "POST" })).json();
    assert("live tick → ok=true", tick.ok === true, JSON.stringify(tick));
    assert("live tick → mode=live", tick.mode === "live", tick.mode);
    assert("live tick → activatedCount >= 1", tick.activatedCount >= 1, `activatedCount=${tick.activatedCount}`);
    assert("live tick → Graph received PATCH", patches.length >= 1, `patches=${patches.length}`);

    const patch = patches[0];
    assert("live tick → PATCH state=enabled", patch.body.state === "enabled", JSON.stringify(patch.body));

    process.stdout.write("Live-mode tick checks passed.\n");
  } finally {
    if (appServer) await stopServer(appServer);
    await stopServer(graphServer);
  }
}

// ── Run all ───────────────────────────────────────────────────────────────────

async function run() {
  await runDemoChecks();
  await runTickActivationCheck();
  await runLiveTickCheck();
  process.stdout.write("All travel scheduler e2e checks passed.\n");
}

run().catch((err) => {
  process.stderr.write(`Travel e2e error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
