// e2e check: policy CRUD routes
// Tests create, update (state toggle), and delete via demo mode and a live
// mode stub Graph server (no real Azure credentials needed).

const http = require("http");
const { createServer } = require("../src/server");

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

// ── Part 1: demo-mode CRUD ────────────────────────────────────────────────────

async function runDemoChecks() {
  delete process.env.ENABLE_LIVE_GRAPH;
  delete process.env.GRAPH_ACCESS_TOKEN;
  delete process.env.AZURE_TENANT_ID;
  delete process.env.AZURE_CLIENT_ID;
  delete process.env.AZURE_CLIENT_SECRET;
  delete process.env.TENANTS_JSON;

  const server = createServer();
  const port = await startServer(server, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  process.stdout.write(`Demo-mode policy CRUD checks — port ${port}\n`);

  try {
    // Create — valid
    const cr = await fetch(`${base}/api/policies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Test MFA Policy", state: "disabled" })
    });
    const created = await cr.json();
    assert("create → 201", cr.status === 201, `status=${cr.status}`);
    assert("create → ok=true", created.ok === true, JSON.stringify(created));
    assert("create → mode=demo", created.mode === "demo", created.mode);
    assert("create → has id", typeof created.policy.id === "string" && created.policy.id.length > 0, JSON.stringify(created.policy));
    assert("create → correct displayName", created.policy.name === "Test MFA Policy", created.policy.name);
    assert("create → state=disabled", created.policy.state === "disabled", created.policy.state);
    const policyId = created.policy.id;

    // Create — missing displayName → 400
    const badCreate = await fetch(`${base}/api/policies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "enabled" })
    });
    assert("create missing displayName → 400", badCreate.status === 400, `status=${badCreate.status}`);

    // Create — invalid state → 400
    const badState = await fetch(`${base}/api/policies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Bad Policy", state: "notAState" })
    });
    assert("create invalid state → 400", badState.status === 400, `status=${badState.status}`);

    // Update — toggle state
    const upd = await fetch(`${base}/api/policies/${policyId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "enabled" })
    });
    const updated = await upd.json();
    assert("update → 200", upd.status === 200, `status=${upd.status}`);
    assert("update → ok=true", updated.ok === true, JSON.stringify(updated));
    assert("update → mode=demo", updated.mode === "demo", updated.mode);
    assert("update → state=enabled", updated.policy.state === "enabled", updated.policy.state);

    // Update — empty patch → 400
    const emptyPatch = await fetch(`${base}/api/policies/${policyId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert("update empty patch → 400", emptyPatch.status === 400, `status=${emptyPatch.status}`);

    // Update — invalid state → 400
    const badPatch = await fetch(`${base}/api/policies/${policyId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "notValid" })
    });
    assert("update invalid state → 400", badPatch.status === 400, `status=${badPatch.status}`);

    // Delete
    const del = await fetch(`${base}/api/policies/${policyId}`, { method: "DELETE" });
    const deleted = await del.json();
    assert("delete → 200", del.status === 200, `status=${del.status}`);
    assert("delete → ok=true", deleted.ok === true, JSON.stringify(deleted));
    assert("delete → mode=demo", deleted.mode === "demo", deleted.mode);
    assert("delete → policyId returned", deleted.policyId === policyId, deleted.policyId);

    process.stdout.write("Demo-mode policy CRUD checks passed.\n");
  } finally {
    await stopServer(server);
  }
}

// ── Part 2: live-mode CRUD via stub Graph ─────────────────────────────────────

async function runLiveChecks() {
  const calls = [];

  const graphServer = http.createServer((req, res) => {
    // Auth token endpoint
    if (req.method === "POST" && req.url.includes("/oauth2/v2.0/token")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "live-crud-token", expires_in: 3600 }));
      return;
    }

    // POST /identity/conditionalAccess/policies (create)
    if (req.method === "POST" && req.url === "/identity/conditionalAccess/policies") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        calls.push({ method: "POST", body: parsed });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "live-policy-001",
          displayName: parsed.displayName,
          state: parsed.state || "disabled",
          createdDateTime: new Date().toISOString(),
          modifiedDateTime: new Date().toISOString()
        }));
      });
      return;
    }

    // PATCH /identity/conditionalAccess/policies/:id
    if (req.method === "PATCH" && req.url.startsWith("/identity/conditionalAccess/policies/")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        calls.push({ method: "PATCH", url: req.url, body: parsed });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "live-policy-001",
          displayName: "Live CA Policy",
          state: parsed.state || "enabled",
          modifiedDateTime: new Date().toISOString()
        }));
      });
      return;
    }

    // DELETE /identity/conditionalAccess/policies/:id
    if (req.method === "DELETE" && req.url.startsWith("/identity/conditionalAccess/policies/")) {
      calls.push({ method: "DELETE", url: req.url });
      res.writeHead(204, {});
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found" } }));
  });

  let appServer;
  try {
    const graphPort = await startServer(graphServer, "127.0.0.1");
    process.env.GRAPH_API_BASE = `http://127.0.0.1:${graphPort}`;
    process.env.GRAPH_ACCESS_TOKEN = "live-crud-token";
    process.env.AZURE_TENANT_ID = "live-crud-tenant";
    process.env.AZURE_CLIENT_ID = "";
    process.env.AZURE_CLIENT_SECRET = "";
    process.env.TENANTS_JSON = JSON.stringify([{
      id: "live-crud-tenant", name: "Live CRUD Tenant", domain: "crud.example.com",
      tenantId: "live-crud-tenant", clientId: "", clientSecret: "",
      accessToken: "live-crud-token", isDemo: false
    }]);
    process.env.ENABLE_LIVE_GRAPH = "true";

    appServer = createServer({ graphBaseUrl: process.env.GRAPH_API_BASE });
    const port = await startServer(appServer, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const qs = "?tenantId=live-crud-tenant";
    process.stdout.write(`Live-mode policy CRUD checks — port ${port}\n`);

    // Create
    const cr = await fetch(`${base}/api/policies${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Live MFA Policy", state: "disabled" })
    });
    const created = await cr.json();
    assert("live create → 201", cr.status === 201, `status=${cr.status}`);
    assert("live create → ok=true", created.ok === true, JSON.stringify(created));
    assert("live create → mode=live", created.mode === "live", created.mode);
    assert("live create → has id", typeof created.policy.id === "string", JSON.stringify(created.policy));
    assert("live create → Graph received POST", calls.some((c) => c.method === "POST"), JSON.stringify(calls));

    const postCall = calls.find((c) => c.method === "POST");
    assert("live create → displayName sent", postCall.body.displayName === "Live MFA Policy", JSON.stringify(postCall.body));

    // Update state
    const upd = await fetch(`${base}/api/policies/live-policy-001${qs}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "enabled" })
    });
    const updated = await upd.json();
    assert("live update → 200", upd.status === 200, `status=${upd.status}`);
    assert("live update → ok=true", updated.ok === true, JSON.stringify(updated));
    assert("live update → mode=live", updated.mode === "live", updated.mode);
    assert("live update → state=enabled", updated.policy.state === "enabled", updated.policy.state);
    assert("live update → Graph received PATCH", calls.some((c) => c.method === "PATCH"), JSON.stringify(calls));

    const patchCall = calls.find((c) => c.method === "PATCH");
    assert("live update → state sent", patchCall.body.state === "enabled", JSON.stringify(patchCall.body));

    // Delete
    const del = await fetch(`${base}/api/policies/live-policy-001${qs}`, { method: "DELETE" });
    const deleted = await del.json();
    assert("live delete → 200", del.status === 200, `status=${del.status}`);
    assert("live delete → ok=true", deleted.ok === true, JSON.stringify(deleted));
    assert("live delete → mode=live", deleted.mode === "live", deleted.mode);
    assert("live delete → Graph received DELETE", calls.some((c) => c.method === "DELETE"), JSON.stringify(calls));

    process.stdout.write("Live-mode policy CRUD checks passed.\n");
  } finally {
    if (appServer) await stopServer(appServer);
    await stopServer(graphServer);
  }
}

// ── Run all ───────────────────────────────────────────────────────────────────

async function run() {
  await runDemoChecks();
  await runLiveChecks();
  process.stdout.write("All policy CRUD e2e checks passed.\n");
}

run().catch((err) => {
  process.stderr.write(`Policy CRUD e2e error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
