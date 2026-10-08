'use strict';
// HTTP client for the tickets service: per-attempt timeout + retries with exponential backoff.
// The SAME requestId is sent on every attempt, so an idempotent tickets service can recognise the retry.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns { status, body, attempts } for any answer below 500 (including 409 sold out: not worth retrying).
 * Retries on network errors, timeouts and 5xx; throws (with err.attempts and err.timeout) when attempts run out.
 */
async function reserveTickets({ url, timeoutMs, retries, backoffMs, fetchFn = fetch, onRetry = () => {} }, { eventId, qty, requestId, correlationId }) {
  for (let attempt = 1; ; attempt++) {
    let failure;
    try {
      const res = await fetchFn(`${url}/reservations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': correlationId || requestId },
        body: JSON.stringify({ eventId, qty, requestId }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status < 500) return { status: res.status, body, attempts: attempt };
      failure = Object.assign(new Error(`tickets answered ${res.status}`), { timeout: false });
    } catch (err) {
      failure = Object.assign(err, { timeout: err.name === 'TimeoutError' || err.name === 'AbortError' });
    }
    if (attempt > retries) throw Object.assign(failure, { attempts: attempt });
    onRetry(attempt, failure);
    await sleep(backoffMs * 2 ** (attempt - 1)); // 1x, 2x, 4x ... the base delay
  }
}

module.exports = { reserveTickets };
