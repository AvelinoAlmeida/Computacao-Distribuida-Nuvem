'use strict';
// The heart of the "tickets" service: the three stock strategies and the idempotency layer.
// Pure logic on top of two small interfaces (`store` = Postgres, `redis` = Redis), so it can be unit-tested
// with in-memory fakes. Results are always { status: 'reserved' | 'sold_out' | 'not_found', sold?, capacity? }.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Values returned by redis.take() besides the remaining stock (>= 0).
const REDIS_MISSING = -1; // key does not exist yet
const REDIS_SOLD_OUT = -2;

/** naive: check-then-act. Reads `sold`, waits, then writes. Concurrent requests all read the same stale value => overselling. */
function naive({ store, naiveDelayMs }) {
  return async ({ eventId, qty, requestId }) => {
    const ev = await store.getEvent(eventId); // (1) read
    if (!ev) return { status: 'not_found' };
    if (ev.sold + qty > ev.capacity) return { status: 'sold_out', sold: ev.sold, capacity: ev.capacity };
    await sleep(naiveDelayMs); // widens the race window: what we just read may already be wrong
    const row = await store.addUnguarded(eventId, qty, requestId); // (2) write, without re-checking
    return { status: 'reserved', sold: row.sold, capacity: row.capacity };
  };
}

/**
 * db-atomic: ONE statement does check + update (UPDATE ... WHERE sold + qty <= capacity), so Postgres row
 * locking serialises competing requests. No transaction needed; the reservation row is inserted in the same statement (CTE).
 */
function dbAtomic({ store }) {
  return async ({ eventId, qty, requestId }) => {
    const row = await store.addGuarded(eventId, qty, requestId);
    if (row) return { status: 'reserved', sold: row.sold, capacity: row.capacity };
    const ev = await store.getEvent(eventId); // no row updated: unknown event or no stock left?
    return ev ? { status: 'sold_out', sold: ev.sold, capacity: ev.capacity } : { status: 'not_found' };
  };
}

/**
 * redis-atomic: Redis (single-threaded, Lua script) decides who gets stock; Postgres then records the sale.
 * Trade-off: two systems, and Redis is trusted. Postgres is the source of truth, so an oversell is always VISIBLE (audit,
 * tickets_oversold_total) but not always PREVENTED:
 *  - Redis comes back EMPTY: the counter is rebuilt from Postgres (capacity - sold). Correct unless reservations that Redis
 *    approved were not yet written to Postgres at that moment (small window under load: see README-docente).
 *  - Redis comes back with OLD data (snapshot, stale replica): the counter exists, is too high, and nothing rebuilds it => oversell.
 *  - Postgres fails after Redis accepted: we give the stock back (compensation). If the process dies in between, Redis is one
 *    unit short of Postgres (under-selling, never over-selling) until an operator fixes it.
 */
function redisAtomic({ store, redis }) {
  return async ({ eventId, qty, requestId }) => {
    let left = await redis.take(eventId, qty);
    if (left === REDIS_MISSING) {
      // Redis lost (or never had) the counter: rebuild it from Postgres, the source of truth.
      const ev = await store.getEvent(eventId);
      if (!ev) return { status: 'not_found' };
      await redis.init(eventId, ev.capacity - ev.sold, { onlyIfMissing: true });
      left = await redis.take(eventId, qty);
    }
    if (left === REDIS_SOLD_OUT) return { status: 'sold_out' };
    try {
      const row = await store.addUnguarded(eventId, qty, requestId); // durable record; never rejects (Redis already decided)
      // row.sold / row.capacity come from Postgres: if Redis was wrong (stale or rebuilt too early) the oversell shows up here.
      return { status: 'reserved', sold: row.sold, capacity: row.capacity };
    } catch (err) {
      await redis.giveBack(eventId, qty);
      throw err;
    }
  };
}

function makeStrategy(name, deps) {
  switch (name) {
    case 'naive': return naive(deps);
    case 'db-atomic': return dbAtomic(deps);
    case 'redis-atomic':
      if (!deps.redis) throw new Error('STOCK_STRATEGY=redis-atomic needs REDIS_URL');
      return redisAtomic(deps);
    default: throw new Error(`unknown STOCK_STRATEGY "${name}" (naive | db-atomic | redis-atomic)`);
  }
}

/**
 * Idempotency layer, independent of the strategy. With IDEMPOTENCY=on the first request for a requestId "claims" it
 * (INSERT ... ON CONFLICT DO NOTHING), runs the strategy and stores the result. A repeated requestId never runs the
 * strategy again: it returns the stored result (waiting if the first attempt is still running). A requestId reused with a
 * different eventId/qty is refused. Returns { result, replayed } | { inProgress: true } | { mismatch: true }.
 */
async function reserveOnce({ store, reserve, idempotency, waitMs = 5000 }, req) {
  if (!idempotency) return { result: await reserve(req), replayed: false };
  const fingerprint = `${req.eventId}:${req.qty}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await store.claim(req.requestId, fingerprint)) break;
    const row = await store.getRequest(req.requestId);
    if (row && row.fingerprint && row.fingerprint !== fingerprint) return { mismatch: true };
    if (row && row.status === 'done') return { result: row.result, replayed: true };
    if (Date.now() > deadline) return { inProgress: true };
    await sleep(25); // first attempt still running (or its claim was just released): look again
  }
  try {
    const result = await reserve(req);
    // 'not_found' is not remembered: the event may be created a moment later and the retry should then work.
    if (result.status === 'not_found') await store.releaseRequest(req.requestId);
    else await store.finishRequest(req.requestId, result);
    return { result, replayed: false };
  } catch (err) {
    await store.releaseRequest(req.requestId); // let a retry try again
    throw err;
  }
}

module.exports = { makeStrategy, reserveOnce, REDIS_MISSING, REDIS_SOLD_OUT };
