const http = require("http");
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
  const graphPayload = {
    value: [
      {
        id: "policy-001",
        displayName: "Require MFA for Admins",
        description: "MFA enforced for privileged users",
        state: "enabled",
        createdDateTime: "2026-03-13T10:00:00Z",
        modifiedDateTime: "2026-03-13T10:30:00Z",
        conditions: {
          users: {
            includeUsers: ["user-a"],
            excludeUsers: ["user-b"],
            includeGroups: ["group-1"],
            excludeGroups: []
          },
          applications: {
            includeApplications: ["All"],
            excludeApplications: []
          },
          locations: {
            includeLocations: ["location-1"],
            excludeLocations: []
          }
        },
        grantControls: {
          operator: "OR",
          builtInControls: ["mfa"]
        }
      }
    ]
  };

  const graphServer = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/identity/conditionalAccess/policies") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(graphPayload));
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Not found" }));
  });

  let appServer;
  try {
    const graphPort = await startServer(graphServer, "127.0.0.1");
    process.env.GRAPH_API_BASE = `http://127.0.0.1:${graphPort}`;
    process.env.AZURE_TENANT_ID = "tenant-e2e";
    process.env.AZURE_CLIENT_ID = "";
    process.env.AZURE_CLIENT_SECRET = "";
    process.env.GRAPH_ACCESS_TOKEN = "local-test-token";
    process.env.ENABLE_LIVE_GRAPH = "true";

    appServer = createServer({ graphBaseUrl: process.env.GRAPH_API_BASE });
    const appPort = await startServer(appServer, "127.0.0.1");

    const response = await fetch(`http://127.0.0.1:${appPort}/api/policies?tenantId=tenant-e2e`);
    const body = await response.json();

    if (response.status !== 200) {
      throw new Error(`Expected 200 but received ${response.status}`);
    }

    if (!body.ok) {
      throw new Error("Expected ok=true from policy route");
    }

    if (body.mode !== "live") {
      throw new Error(`Expected mode=live but received ${body.mode}`);
    }

    if (body.tokenSource !== "static") {
      throw new Error(`Expected tokenSource=static but received ${body.tokenSource}`);
    }

    if (!body.tenant || body.tenant.id !== "tenant-e2e") {
      throw new Error("Expected response tenant metadata for tenant-e2e");
    }

    if (body.policyCount !== 1) {
      throw new Error(`Expected policyCount=1 but received ${body.policyCount}`);
    }

    if (!Array.isArray(body.policies) || body.policies.length !== 1) {
      throw new Error("Expected one mapped policy");
    }

    const mappedPolicy = body.policies[0];
    if (mappedPolicy.stateLabel !== "Enabled") {
      throw new Error(`Expected stateLabel=Enabled but received ${mappedPolicy.stateLabel}`);
    }

    if (mappedPolicy.enforcementMode !== "enforced") {
      throw new Error(`Expected enforcementMode=enforced but received ${mappedPolicy.enforcementMode}`);
    }

    if (!mappedPolicy.conditions || !mappedPolicy.conditions.include) {
      throw new Error("Expected mapped conditions in policy payload");
    }

    if (!Array.isArray(mappedPolicy.conditions.include.users) || mappedPolicy.conditions.include.users.length !== 1) {
      throw new Error("Expected mapped include users array");
    }

    process.stdout.write("E2E policy route check passed\n");
  } finally {
    if (appServer) {
      await stopServer(appServer);
    }

    await stopServer(graphServer);
  }
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
