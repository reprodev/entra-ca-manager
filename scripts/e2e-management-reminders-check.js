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
  delete process.env.ENABLE_LIVE_GRAPH;
  delete process.env.ENABLE_CALENDAR_INTEGRATION;
  delete process.env.CALENDAR_TARGET_USER;
  delete process.env.AZURE_TENANT_ID;
  delete process.env.AZURE_CLIENT_ID;
  delete process.env.AZURE_CLIENT_SECRET;
  delete process.env.GRAPH_ACCESS_TOKEN;
  delete process.env.TENANTS_JSON;

  const server = createServer();

  try {
    const port = await startServer(server, "127.0.0.1");

    const overviewResponse = await fetch(`http://127.0.0.1:${port}/api/management/overview`);
    const overviewBody = await overviewResponse.json();

    if (overviewResponse.status !== 200 || !overviewBody.ok) {
      throw new Error("Expected management overview to return 200 and ok=true");
    }

    if (overviewBody.mode !== "demo") {
      throw new Error(`Expected overview mode=demo but received ${overviewBody.mode}`);
    }

    if (!overviewBody.summary || overviewBody.summary.total < 1) {
      throw new Error("Expected overview summary with demo policy totals");
    }

    const previewResponse = await fetch(`http://127.0.0.1:${port}/api/management/reminders`);
    const previewBody = await previewResponse.json();

    if (previewResponse.status !== 200 || !previewBody.ok) {
      throw new Error("Expected reminders preview to return 200 and ok=true");
    }

    if (!previewBody.reminderPlan || previewBody.reminderPlan.totalReminders < 1) {
      throw new Error("Expected reminder plan to include reminders");
    }

    if (!previewBody.calendarSync || previewBody.calendarSync.requested !== false) {
      throw new Error("Expected preview mode to avoid calendar sync");
    }

    const syncAttemptResponse = await fetch(`http://127.0.0.1:${port}/api/management/reminders?sync=true`);
    const syncAttemptBody = await syncAttemptResponse.json();

    if (syncAttemptResponse.status !== 200 || !syncAttemptBody.ok) {
      throw new Error("Expected sync attempt response to return 200 and ok=true");
    }

    if (!syncAttemptBody.calendarSync || !syncAttemptBody.calendarSync.requested) {
      throw new Error("Expected calendarSync.requested=true when sync=true");
    }

    if (syncAttemptBody.calendarSync.executed !== false) {
      throw new Error("Expected sync to be skipped in demo mode");
    }

    process.stdout.write("E2E management reminders check passed\n");
  } finally {
    await stopServer(server);
  }
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
