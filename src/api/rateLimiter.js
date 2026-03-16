function createInMemoryRateLimiter(config = {}) {
  const windowMs = Math.max(60 * 1000, Number(config.windowMs) || 15 * 60 * 1000);
  const maxRequests = Math.max(1, Number(config.maxRequests) || 20);
  const blockMs = Math.max(windowMs, Number(config.blockMs) || windowMs);
  const store = new Map();

  async function check(key) {
    const now = Date.now();
    const entry = store.get(key) || { count: 0, windowStart: now, blockedUntil: 0 };

    if (entry.blockedUntil > now) {
      const retryAfterSeconds = Math.ceil((entry.blockedUntil - now) / 1000);
      return { limited: true, retryAfterSeconds };
    }

    if (now - entry.windowStart >= windowMs) {
      entry.windowStart = now;
      entry.count = 0;
      entry.blockedUntil = 0;
    }

    entry.count += 1;
    if (entry.count > maxRequests) {
      entry.blockedUntil = now + blockMs;
      store.set(key, entry);
      return { limited: true, retryAfterSeconds: Math.ceil(blockMs / 1000) };
    }

    store.set(key, entry);
    return { limited: false, retryAfterSeconds: 0 };
  }

  return { check };
}

function createRedisRateLimiter(config = {}, redisRuntime) {
  const windowMs = Math.max(60 * 1000, Number(config.windowMs) || 15 * 60 * 1000);
  const maxRequests = Math.max(1, Number(config.maxRequests) || 20);
  const blockMs = Math.max(windowMs, Number(config.blockMs) || windowMs);
  const fallbackLimiter = createInMemoryRateLimiter(config);
  const prefix = String(config.prefix || `${redisRuntime.keyPrefix}:ratelimit`);

  function buildKeys(bucket) {
    const safeBucket = String(bucket || "unknown");
    return {
      countKey: `${prefix}:${safeBucket}:count`,
      blockKey: `${prefix}:${safeBucket}:block`
    };
  }

  async function check(bucket) {
    if (!redisRuntime || !redisRuntime.enabled) {
      return fallbackLimiter.check(bucket);
    }

    const result = await redisRuntime.execute(async (client) => {
      const { countKey, blockKey } = buildKeys(bucket);
      const blockedMs = await client.pTTL(blockKey);
      if (blockedMs > 0) {
        return { limited: true, retryAfterSeconds: Math.ceil(blockedMs / 1000) };
      }

      const count = await client.incr(countKey);
      if (count === 1) {
        await client.pExpire(countKey, windowMs);
      }

      if (count > maxRequests) {
        await client.set(blockKey, "1", { PX: blockMs });
        await client.del(countKey);
        return { limited: true, retryAfterSeconds: Math.ceil(blockMs / 1000) };
      }

      return { limited: false, retryAfterSeconds: 0 };
    });

    if (result) {
      return result;
    }

    return fallbackLimiter.check(bucket);
  }

  return { check };
}

function createRateLimiter(config = {}, redisRuntime) {
  if (redisRuntime && redisRuntime.enabled) {
    return createRedisRateLimiter(config, redisRuntime);
  }
  return createInMemoryRateLimiter(config);
}

module.exports = {
  createRateLimiter
};
