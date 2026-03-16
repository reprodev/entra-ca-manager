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

async function run() {
  delete process.env.TENANTS_JSON;
  delete process.env.AZURE_TENANT_ID;
  delete process.env.AZURE_CLIENT_ID;
  delete process.env.AZURE_CLIENT_SECRET;
  delete process.env.GRAPH_ACCESS_TOKEN;
  delete process.env.ENABLE_LIVE_GRAPH;

  const server = createServer();

  try {
    const port = await startServer(server, "127.0.0.1");

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    const healthBody = await healthResponse.json();

    if (healthResponse.status !== 200 || !healthBody.ok) {
      throw new Error("Expected /health to return 200 and ok=true");
    }

    if (healthBody.mode !== "demo") {
      throw new Error(`Expected /health mode=demo but received ${healthBody.mode}`);
    }

    const tenantsResponse = await fetch(`http://127.0.0.1:${port}/api/tenants`);
    const tenantsBody = await tenantsResponse.json();

    if (tenantsResponse.status !== 200 || !tenantsBody.ok) {
      throw new Error("Expected /api/tenants to return 200 and ok=true");
    }

    if (!Array.isArray(tenantsBody.tenants) || tenantsBody.tenants.length === 0) {
      throw new Error("Expected demo tenant list to contain at least one tenant");
    }

    const tenant = tenantsBody.tenants[0];
    if (tenant.domain !== "kontoso.com") {
      throw new Error(`Expected default demo tenant domain kontoso.com but received ${tenant.domain}`);
    }

    if (tenant.mode !== "demo") {
      throw new Error(`Expected tenant mode demo but received ${tenant.mode}`);
    }

    const policiesResponse = await fetch(`http://127.0.0.1:${port}/api/policies`);
    const policiesBody = await policiesResponse.json();

    if (policiesResponse.status !== 200 || !policiesBody.ok) {
      throw new Error("Expected /api/policies to return 200 and ok=true in demo mode");
    }

    if (policiesBody.tokenSource !== "demo") {
      throw new Error(`Expected tokenSource=demo but received ${policiesBody.tokenSource}`);
    }

    if (policiesBody.mode !== "demo") {
      throw new Error(`Expected /api/policies mode=demo but received ${policiesBody.mode}`);
    }

    if (!policiesBody.tenant || policiesBody.tenant.domain !== "kontoso.com") {
      throw new Error("Expected /api/policies to include kontoso.com tenant details");
    }

    if (!Array.isArray(policiesBody.policies) || policiesBody.policies.length < 1) {
      throw new Error("Expected demo policies in /api/policies response");
    }

    process.stdout.write("E2E demo mode check passed\n");
  } finally {
    await stopServer(server);
  }
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
