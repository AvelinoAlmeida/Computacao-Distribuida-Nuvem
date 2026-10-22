'use strict';
// tickets: stock of tickets per event. Endpoints: POST /events, GET /events/:id (read replica if READ_DATABASE_URL), GET /events/:id/audit, POST /reservations.
const crypto = require('node:crypto');
const express = require('express');
const { str, num, sleep, makeLogger, reply, retry, createService, client } = require('./lib');
const { PgStore } = require('./store');
const { RedisStock } = require('./redis-stock');
const { makeStrategy, reserveOnce } = require('./stock');

const log = makeLogger('tickets');
const config = {
  port: num('PORT', 3001),
  databaseUrl: str('DATABASE_URL', 'postgres://app:app@localhost:5432/tickets'),
  readDatabaseUrl: str('READ_DATABASE_URL', ''), // optional: read replica used ONLY by GET /events/:id (writes and /audit use DATABASE_URL)
  redisUrl: str('REDIS_URL', ''), // used ONLY with STOCK_STRATEGY=redis-atomic (otherwise Redis is neither connected nor checked)
  strategy: str('STOCK_STRATEGY', 'db-atomic'), // naive | db-atomic | redis-atomic
  naiveDelayMs: num('NAIVE_DELAY_MS', 50), // pause between read and write in the naive strategy
  idempotency: str('IDEMPOTENCY', 'on') === 'on', // on | off
  responseDelayMs: num('RESPONSE_DELAY_MS', 0), // artificial delay AFTER the reservation is done, before answering
  pgPoolMax: num('PG_POOL_MAX', 10),
};

const store = new PgStore(config.databaseUrl, config.pgPoolMax, (err) => log.warn('postgres pool error', { err: err.message }), config.readDatabaseUrl);
const redis = config.strategy === 'redis-atomic' && config.redisUrl ? new RedisStock(config.redisUrl) : null;
const reserve = makeStrategy(config.strategy, { store, redis, naiveDelayMs: config.naiveDelayMs });

// Business metrics (in addition to the HTTP metrics from lib.js).
const reservations = new client.Counter({ name: 'tickets_reservations_total', help: 'Reservations accepted (201)' });
const soldOut = new client.Counter({ name: 'tickets_sold_out_total', help: 'Reservations rejected because the event is sold out (409)' });
const oversold = new client.Counter({ name: 'tickets_oversold_total', help: 'Units sold beyond capacity, judged by the sold/capacity Postgres has right after each write (any strategy)' });
const replays = new client.Counter({ name: 'tickets_idempotent_replays_total', help: 'Repeated requestIds answered from the stored result' });

const HTTP = { reserved: 201, sold_out: 409, not_found: 404 };
const isPositiveInt = (n) => Number.isInteger(n) && n > 0;

const svc = createService({
  name: 'tickets',
  port: config.port,
  log,
  init: async () => {
    await retry(() => store.migrate(), { what: 'postgres', log });
    if (redis) {
      await retry(() => redis.ping(), { what: 'redis', log });
      // Pre-load the counters from Postgres (only where missing: never overwrites a live counter).
      for (const { id, remaining } of await store.stockLeft()) await redis.init(id, remaining, { onlyIfMissing: true });
    }
    log.info('config', { readFrom: store.readFrom, strategy: config.strategy, idempotency: config.idempotency, naiveDelayMs: config.naiveDelayMs, responseDelayMs: config.responseDelayMs });
  },
  checks: { postgres: () => store.ping(), ...(config.readDatabaseUrl ? { replica: () => store.pingRead() } : {}), ...(redis ? { redis: () => redis.ping() } : {}) },
  shutdown: async () => {
    await store.close();
    if (redis) await redis.close();
  },
});

svc.start((app) => {
  app.use(express.json());

  // Seed an event. 409 if the id already exists.
  app.post('/events', async (req, res) => {
    const { id, name, capacity } = req.body || {};
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !Number.isInteger(capacity) || capacity < 0) {
      return reply(res, 400, { error: 'expected {id: string, name: string, capacity: integer >= 0}' });
    }
    const ev = await store.createEvent({ id, name, capacity });
    if (!ev) return reply(res, 409, { error: 'event_exists' });
    if (redis) await redis.init(id, capacity); // stock counter for redis-atomic
    log.info('event created', { eventId: id, capacity });
    reply(res, 201, { ...ev, available: ev.capacity - ev.sold });
  });

  app.get('/events/:id', async (req, res) => {
    const ev = await store.readEvent(req.params.id); // replica if READ_DATABASE_URL is set: may be out of date
    if (!ev) return reply(res, 404, { error: 'not_found', readFrom: store.readFrom });
    reply(res, 200, { ...ev, available: Math.max(0, ev.capacity - ev.sold), readFrom: store.readFrom });
  });

  // Ground truth for the experiments: oversold = max(0, sold - capacity).
  app.get('/events/:id/audit', async (req, res) => {
    const a = await store.audit(req.params.id);
    if (!a) return reply(res, 404, { error: 'not_found' });
    // sold/oversold come from the reservations recorded in Postgres, whatever strategy (or Redis) accepted them.
    reply(res, 200, {
      eventId: req.params.id, capacity: a.capacity, sold: a.reserved_qty, oversold: Math.max(0, a.reserved_qty - a.capacity),
      reservations: a.reservations, counter: a.counter, strategy: config.strategy,
    });
  });

  app.post('/reservations', async (req, res) => {
    const { eventId, qty, requestId } = req.body || {};
    if (typeof eventId !== 'string' || !isPositiveInt(qty)) {
      return reply(res, 400, { error: 'expected {eventId: string, qty: integer > 0, requestId?: string}' });
    }
    const rid = typeof requestId === 'string' && requestId ? requestId : req.get('x-request-id') || crypto.randomUUID();
    const out = await reserveOnce({ store, reserve, idempotency: config.idempotency }, { eventId, qty, requestId: rid });
    if (out.mismatch) return reply(res, 422, { error: 'request_id_reused_with_different_content', requestId: rid });
    if (out.inProgress) return reply(res, 503, { error: 'request_in_progress', requestId: rid });

    const { result, replayed } = out;
    if (replayed) replays.inc();
    else {
      if (result.status === 'reserved') {
        reservations.inc();
        if (result.sold > result.capacity) oversold.inc(Math.min(qty, result.sold - result.capacity));
      }
      if (result.status === 'sold_out') soldOut.inc();
      if (config.responseDelayMs > 0) await sleep(config.responseDelayMs); // work is done, the answer is late (=> client timeouts)
    }
    reply(res, HTTP[result.status], { status: result.status, eventId, qty, requestId: rid, sold: result.sold, replayed });
  });
});
