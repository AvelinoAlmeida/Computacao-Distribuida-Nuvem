'use strict';
// Transactional outbox (OUTBOX=on). POST /orders writes the order AND an outbox row in ONE transaction, so an order can never
// exist without its pending notification. This relay publishes pending rows to RabbitMQ and marks them sent.
// Delivery is at-least-once: if we crash after publishing but before the COMMIT the row is published again
// (the notifications service deduplicates by orderId). Several orders replicas can run it: SKIP LOCKED shares the rows.

// Rejects with err.timeout = true if the promise takes longer than ms (e.g. a broker that blocks publishers and never confirms).
function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`publish timed out after ${ms} ms`), { timeout: true })), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// One cycle: lock a batch, publish it (publisher confirms, at most publishTimeoutMs), mark it sent.
// Throws (rolling back, so the rows stay pending) if any publish fails or the confirms do not arrive in time.
async function relayOnce({ pool, publish, batch = 100, publishTimeoutMs = 5000 }) {
  const c = await pool.connect();
  let count = 0;
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('SELECT id, payload FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED', [batch]);
    count = rows.length;
    if (count > 0) {
      await withTimeout(Promise.all(rows.map((r) => publish(r.payload))), publishTimeoutMs);
      await c.query('UPDATE outbox SET sent_at = now() WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
    }
    await c.query('COMMIT');
    return count;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    err.count = count;
    throw err;
  } finally {
    c.release();
  }
}

// Housekeeping: delete rows that were sent more than keepSec ago (the outbox would otherwise grow forever). Returns the count.
async function cleanupSent(pool, keepSec) {
  const r = await pool.query("DELETE FROM outbox WHERE sent_at IS NOT NULL AND sent_at < now() - make_interval(secs => $1)", [keepSec]);
  return r.rowCount;
}

// Runs relayOnce forever (every pollMs, immediately again while there is a backlog) until stop() is called.
// A publish timeout calls onTimeout() (the caller closes and reopens the AMQP connection) and the batch is retried.
// Every cleanupEveryMs it removes rows sent more than keepSec ago.
function startRelay({ pool, publish, pollMs, log, publishTimeoutMs, keepSec, cleanupEveryMs = 300000, onPublished = () => {}, onFailed = () => {}, onTimeout = () => {} }) {
  let stopped = false;
  let lastCleanup = Date.now();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const loop = (async () => {
    while (!stopped) {
      let n = 0;
      try {
        if (Date.now() - lastCleanup >= cleanupEveryMs) {
          lastCleanup = Date.now();
          const removed = await cleanupSent(pool, keepSec).catch((err) => { log.warn('outbox cleanup failed', { err: err.message }); return 0; });
          if (removed) log.info('outbox cleanup', { removed });
        }
        n = await relayOnce({ pool, publish, publishTimeoutMs });
        if (n) onPublished(n);
      } catch (err) {
        onFailed(err.count || 1);
        if (err.timeout) { onTimeout(); log.error('outbox publish timed out: resetting the broker connection', { err: err.message, pending: err.count }); }
        else log.warn('outbox relay failed (will retry)', { err: err.message });
        await sleep(Math.max(pollMs, 1000));
        continue;
      }
      if (n === 0) await sleep(pollMs);
    }
  })();
  return { stop: async () => { stopped = true; await loop; } };
}

module.exports = { relayOnce, cleanupSent, startRelay };
