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
  const postedEvents = [];
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

    if (request.method === "POST" && request.url === "/users/manager%40kontoso.com/events") {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk.toString();
      });
      request.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch (_error) {
          body = {};
        }

        postedEvents.push(body);
        response.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
        response.end(
          JSON.stringify({
            id: `event-${postedEvents.length}`,
            subject: body.subject || ""
          })
        );
      });
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: { message: "Not found" } }));
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
    process.env.ENABLE_CALENDAR_INTEGRATION = "true";
    process.env.CALENDAR_TARGET_USER = "manager@kontoso.com";
    process.env.CALENDAR_TIMEZONE = "UTC";

    appServer = createServer({ graphBaseUrl: process.env.GRAPH_API_BASE });
    const appPort = await startServer(appServer, "127.0.0.1");

    const response = await fetch(`http://127.0.0.1:${appPort}/api/management/reminders?tenantId=tenant-e2e&sync=true`);
    const body = await response.json();

    if (response.status !== 200 || !body.ok) {
      throw new Error("Expected reminders sync endpoint to return 200 and ok=true");
    }

    if (!body.calendarSync || !body.calendarSync.requested) {
      throw new Error("Expected calendarSync.requested=true");
    }

    if (!body.calendarSync.executed) {
      throw new Error("Expected calendar sync to execute in live mode");
    }

    if (body.calendarSync.createdCount < 1) {
      throw new Error("Expected at least one calendar event to be created");
    }

    if (postedEvents.length !== body.calendarSync.createdCount) {
      throw new Error("Expected posted event count to match createdCount");
    }

    process.stdout.write("E2E calendar sync live check passed\n");
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
