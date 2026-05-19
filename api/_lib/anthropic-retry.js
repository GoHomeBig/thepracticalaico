// Small wrapper around anthropic.messages.create that retries transient errors
// (529 overload, 502/503, timeouts, connection resets) with exponential backoff.
// The user-facing UX stays calm because most overload spikes resolve in a few
// seconds and they never reach the browser.

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504, 529]);
const RETRYABLE_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "EAI_AGAIN"]);

function isRetryable(err) {
  if (!err) return false;
  if (err.status && RETRYABLE_STATUSES.has(err.status)) return true;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  // Anthropic SDK exposes the upstream HTTP status as err.status; some wrappers
  // bury it inside err.error.status. Catch both.
  const inner = err.error && err.error.status;
  if (inner && RETRYABLE_STATUSES.has(inner)) return true;
  return false;
}

async function callAnthropicWithRetry(anthropic, params, options) {
  const { maxRetries = 2, backoffMs = [2000, 5000, 10000], label = "anthropic" } = options || {};
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === maxRetries) {
        // Tag the error so callers can show calm copy if they want.
        if (isRetryable(err)) err.isRetryableOverload = true;
        throw err;
      }
      const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)] || 5000;
      const status = err.status || (err.error && err.error.status) || err.code || "unknown";
      console.warn(`[${label}] retryable error ${status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

module.exports = { callAnthropicWithRetry, isRetryable };
