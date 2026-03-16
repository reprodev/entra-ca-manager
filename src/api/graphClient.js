const { getGraphRequestConfig } = require("./runtimeConfig");

function shouldRetryStatus(statusCode) {
  return statusCode === 429 || statusCode >= 500;
}

function getRetryAfterMs(headerValue) {
  if (!headerValue) {
    return null;
  }

  const seconds = Number.parseFloat(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const asDateMs = Date.parse(headerValue);
  if (!Number.isNaN(asDateMs)) {
    const delta = asDateMs - Date.now();
    return delta > 0 ? delta : null;
  }

  return null;
}

function fallbackDelayMs(attemptNumber) {
  return Math.min(5000, 250 * (2 ** attemptNumber));
}

function normalizeDelayMs(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    return 250;
  }

  return Math.min(10000, Math.max(100, Math.round(delayMs)));
}

function wait(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseResponseData(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return { raw: text };
  }
}

function extractGraphError(data, fallbackMessage) {
  if (data && data.error && typeof data.error.message === "string" && data.error.message.length > 0) {
    return data.error.message;
  }

  return fallbackMessage;
}

async function graphRequest({ baseUrl, token, path, method = "GET", body }) {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json"
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const { timeoutMs, maxRetries } = getGraphRequestConfig();

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const isFinalAttempt = attempt >= maxRetries;

    let response;
    try {
      response = await fetchWithTimeout(
        url,
        {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined
        },
        timeoutMs
      );
    } catch (error) {
      const isTimeout = error && error.name === "AbortError";
      if (!isFinalAttempt) {
        await wait(fallbackDelayMs(attempt));
        continue;
      }

      if (isTimeout) {
        return {
          ok: false,
          statusCode: 504,
          error: `Graph request timed out after ${timeoutMs}ms`
        };
      }

      return {
        ok: false,
        statusCode: 502,
        error: error && error.message ? error.message : "Graph request failed"
      };
    }

    const data = await parseResponseData(response);
    if (response.ok) {
      return { ok: true, statusCode: response.status, data };
    }

    const graphError = extractGraphError(data, response.statusText || "Graph request failed");
    if (!isFinalAttempt && shouldRetryStatus(response.status)) {
      const retryAfter = getRetryAfterMs(response.headers.get("retry-after"));
      const delayMs = normalizeDelayMs(retryAfter ?? fallbackDelayMs(attempt));
      await wait(delayMs);
      continue;
    }

    return {
      ok: false,
      statusCode: response.status,
      error: graphError,
      data
    };
  }

  return {
    ok: false,
    statusCode: 502,
    error: "Graph request failed after retries"
  };
}

module.exports = {
  graphRequest
};
