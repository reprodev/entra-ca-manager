const { createClient } = require("redis");

let sharedRuntime = null;

function createNoopRuntime() {
  return {
    enabled: false,
    keyPrefix: "cam",
    execute: async () => null
  };
}

function createRedisRuntime(config = {}) {
  const enabled = Boolean(config.enabled && config.url);
  if (!enabled) {
    return createNoopRuntime();
  }

  const client = createClient({
    url: config.url,
    socket: {
      connectTimeout: Number(config.connectTimeoutMs) || 5000
    }
  });
  const keyPrefix = String(config.keyPrefix || "cam");
  const required = Boolean(config.required);
  let connectPromise = null;
  let connectError = null;
  let disabled = false;

  client.on("error", (error) => {
    connectError = error;
  });

  async function ensureConnected() {
    if (disabled) {
      return false;
    }
    if (client.isOpen) {
      return true;
    }
    if (!connectPromise) {
      connectPromise = client.connect().catch((error) => {
        connectError = error;
        if (!required) {
          disabled = true;
          return false;
        }
        throw error;
      });
    }

    const connected = await connectPromise;
    return connected !== false;
  }

  return {
    enabled: true,
    keyPrefix,
    getError: () => connectError,
    execute: async (handler) => {
      try {
        const connected = await ensureConnected();
        if (!connected || disabled) {
          return null;
        }
      } catch (_error) {
        if (required) {
          throw _error;
        }
        disabled = true;
        return null;
      }

      try {
        return await handler(client);
      } catch (error) {
        connectError = error;
        if (required) {
          throw error;
        }
        return null;
      }
    }
  };
}

function getSharedRedisRuntime(config = {}) {
  if (!sharedRuntime) {
    sharedRuntime = createRedisRuntime(config);
  }
  return sharedRuntime;
}

module.exports = {
  getSharedRedisRuntime
};
