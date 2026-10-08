'use strict';
// orders: creates orders. POST /orders reserves tickets (HTTP to tickets, with timeout + retries), stores the order,
// then notifies the customer either synchronously (HTTP) or asynchronously (RabbitMQ). Also GET /orders/:id, GET /stats.
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');
const { str, num, makeLogger, reply, retry, createService, client } = require('./lib');
const { QUEUE, amqpConnection } = require('./amqp');
const { reserveTickets } = require('./tickets-client');
const { startRelay } = require('./outbox');

const log = makeLogger('orders');
const config = {
  port: num('PORT', 3002),
  databaseUrl: str('DATABASE_URL', 'postgres://app:app@localhost:5432/orders'),
  ticketsUrl: str('TICKETS_URL', 'http://localhost:3001'),
  ticketsTimeoutMs: num('TICKETS_TIMEOUT_MS', 2000), // per attempt
  ticketsRetries: num('TICKETS_RETRIES', 2), // extra attempts after the first
  ticketsBackoffMs: num('TICKETS_BACKOFF_MS', 100), // base delay; doubles on each retry
  notifyMode: str('NOTIFY_MODE', 'sync'), // sync | async
  notificationsUrl: str('NOTIFICATIONS_URL', 'http://localhost:3003'),
  notifyTimeoutMs: num('NOTIFY_TIMEOUT_MS', 5000),
  outbox: str('OUTBOX', 'on') === 'on', // on | off (async mode only): see below
  outboxPollMs: num('OUTBOX_POLL_MS', 200),
  outboxPublishTimeoutMs: num('OUTBOX_PUBLISH_TIMEOUT_MS', 5000), // confirms must arrive within this, or the connection is reset and the batch retried
  outboxKeepMinutes: num('OUTBOX_KEEP_MINUTES', 60), // sent rows are deleted after this long
  rabbitUrl: str('RABBITMQ_URL', 'amqp://app:app@localhost:5672'),
  pgPoolMax: num('PG_POOL_MAX', 10),
};
if (!['sync', 'async'].includes(config.notifyMode)) throw new Error('NOTIFY_MODE must be sync or async');

const pool = new Pool({ connectionString: config.databaseUrl, max: config.pgPoolMax });
pool.on('error', (err) => log.warn('postgres pool error', { err: err.message })); // a Postgres restart must not crash us
const useOutbox = config.notifyMode === 'async' && config.outbox;
const broker = config.notifyMode === 'async' ? amqpConnection({ url: config.rabbitUrl, log, confirm: true }) : null;

const created = new client.Counter({ name: 'orders_created_total', help: 'Orders confirmed' });
const rejected = new client.Counter({ name: 'orders_rejected_total', help: 'Orders refused because tickets answered 4xx (e.g. sold out)', labelNames: ['reason'] });
for (const reason of ['sold_out', 'not_found']) rejected.inc({ reason }, 0); // show zeros before the first event
const ticketsRetries = new client.Counter({ name: 'orders_tickets_retries_total', help: 'Retries of the call to tickets' });
const ticketsFailures = new client.Counter({ name: 'orders_tickets_failures_total', help: 'Orders that failed because tickets never answered properly' });
const published = new client.Counter({ name: 'orders_messages_published_total', help: 'order.created messages published to RabbitMQ (confirmed by the broker)' });
const publishFailed = new client.Counter({ name: 'orders_messages_failed_total', help: 'Failed publish attempts (each pending message is retried until the broker confirms it)' });
new client.Gauge({ // messages waiting in the outbox (OUTBOX=on): grows while the broker is down
  name: 'orders_outbox_pending', help: 'Outbox rows not yet published',
  async collect() { this.set((await pool.query('SELECT count(*)::int AS n FROM outbox WHERE sent_at IS NULL').catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n); },
});
const publishTimeouts = new client.Counter({ name: 'orders_outbox_publish_timeouts_total', help: 'Outbox batches whose broker confirms did not arrive in time (connection reset)' });
const notifyFailed = new client.Counter({ name: 'orders_notify_failed_total', help: 'Synchronous notification calls that failed' });

const notifySync = async (order) => {
  const res = await fetch(`${config.notificationsUrl}/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(order),
    signal: AbortSignal.timeout(config.notifyTimeoutMs),
  });
  if (!res.ok) throw new Error(`notifications answered ${res.status}`);
};

const publish = (order) => new Promise((resolve, reject) => {
  const ch = broker.channel();
  if (!ch) return reject(new Error('broker not connected'));
  // persistent message + durable queue + publisher confirm: RabbitMQ has it on disk before we say "queued".
  ch.sendToQueue(QUEUE, Buffer.from(JSON.stringify(order)), { persistent: true, contentType: 'application/json', messageId: order.orderId }, (err) => (err ? reject(err) : resolve()));
});

// Never lets a notification problem fail an order that is already confirmed.
async function notify(order) {
  try {
    if (config.notifyMode === 'sync') {
      await notifySync(order);
      return 'sent';
    }
    await publish(order);
    published.inc();
    return 'queued';
  } catch (err) {
    (config.notifyMode === 'sync' ? notifyFailed : publishFailed).inc();
    log.warn('notification failed', { orderId: order.orderId, mode: config.notifyMode, err: err.message });
    return 'failed';
  }
}

let relay = null;
const svc = createService({
  name: 'orders',
  port: config.port,
  log,
  init: async () => {
    await retry(async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(7002)'); // replicas starting together take turns
        await c.query(`CREATE TABLE IF NOT EXISTS orders (
          id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          event_id               text NOT NULL,
          qty                    int  NOT NULL,
          status                 text NOT NULL,
          reservation_request_id text NOT NULL,
          created_at             timestamptz NOT NULL DEFAULT now())`);
        await c.query(`CREATE TABLE IF NOT EXISTS outbox (
          id      bigserial PRIMARY KEY,
          order_id uuid NOT NULL,
          payload jsonb NOT NULL,
          sent_at timestamptz)`);
        // Pending rows only: the relay and the gauge stay fast however many sent rows exist.
        await c.query('CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (id) WHERE sent_at IS NULL');
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    }, { what: 'postgres', log });
    if (useOutbox) {
      broker.connect(); // in the background: with the outbox a broker outage must not stop the service
      relay = startRelay({
        pool, publish, pollMs: config.outboxPollMs, log,
        publishTimeoutMs: config.outboxPublishTimeoutMs, keepSec: config.outboxKeepMinutes * 60,
        onTimeout: () => { publishTimeouts.inc(); broker.reset(); },
        onPublished: (n) => published.inc(n),
        onFailed: (n) => publishFailed.inc(n),
      });
    } else if (broker) await broker.connect();
    log.info('config', { notifyMode: config.notifyMode, outbox: useOutbox, ticketsTimeoutMs: config.ticketsTimeoutMs, ticketsRetries: config.ticketsRetries, ticketsUrl: config.ticketsUrl });
  },
  checks: {
    postgres: () => pool.query('SELECT 1'),
    // Readiness lists only what a request needs: the broker matters for /orders only when it is published to directly.
    ...(broker && !useOutbox ? { rabbitmq: async () => { if (!broker.isUp()) throw new Error('not connected'); } } : {}),
  },
  shutdown: async () => {
    if (relay) await relay.stop();
    if (broker) await broker.close();
    await pool.end();
  },
});

svc.start((app) => {
  app.use(express.json());

  app.post('/orders', async (req, res) => {
    const { eventId, qty } = req.body || {};
    if (typeof eventId !== 'string' || !eventId || !Number.isInteger(qty) || qty <= 0) {
      return reply(res, 400, { error: 'expected {eventId: string, qty: integer > 0}' });
    }
    const correlationId = res.get('x-request-id');
    const reservationRequestId = crypto.randomUUID(); // one per order, reused on every retry

    let r;
    try {
      r = await reserveTickets(
        { url: config.ticketsUrl, timeoutMs: config.ticketsTimeoutMs, retries: config.ticketsRetries, backoffMs: config.ticketsBackoffMs,
          onRetry: (attempt, err) => { ticketsRetries.inc(); log.warn('retrying tickets', { attempt, reservationRequestId, err: err.message }); } },
        { eventId, qty, requestId: reservationRequestId, correlationId });
    } catch (err) {
      ticketsFailures.inc();
      log.error('tickets unavailable', { reservationRequestId, attempts: err.attempts, err: err.message });
      return reply(res, err.timeout ? 504 : 502, { error: 'tickets_unavailable', attempts: err.attempts, reservationRequestId });
    }
    if (r.status === 409 || r.status === 404) {
      rejected.inc({ reason: r.body.status || 'unknown' });
      return reply(res, r.status, { error: r.body.status || 'rejected', attempts: r.attempts });
    }
    if (r.status !== 201) return reply(res, 502, { error: 'unexpected_tickets_answer', ticketsStatus: r.status });

    const insert = "INSERT INTO orders (event_id, qty, status, reservation_request_id) VALUES ($1, $2, 'confirmed', $3) RETURNING id";
    let row;
    let notification;
    if (useOutbox) {
      // Order + outbox row in ONE transaction: no broker involved, so a broker outage cannot fail (or lose) the order.
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        row = (await c.query(insert, [eventId, qty, reservationRequestId])).rows[0];
        await c.query('INSERT INTO outbox (order_id, payload) VALUES ($1, $2)', [row.id, JSON.stringify({ orderId: row.id, eventId, qty })]);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }
      notification = 'queued'; // durably recorded; the relay publishes it
    } else {
      row = (await pool.query(insert, [eventId, qty, reservationRequestId])).rows[0];
    }
    created.inc();
    if (!useOutbox) notification = await notify({ orderId: row.id, eventId, qty }); // direct: sync HTTP, or async publish (dual write)
    reply(res, 201, { id: row.id, eventId, qty, status: 'confirmed', attempts: r.attempts, notification, reservationRequestId });
  });

  app.get('/orders/:id', async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply(res, 404, { error: 'not_found' });
    const row = (await pool.query('SELECT id, event_id, qty, status, reservation_request_id, created_at FROM orders WHERE id = $1', [req.params.id])).rows[0];
    if (!row) return reply(res, 404, { error: 'not_found' });
    reply(res, 200, { id: row.id, eventId: row.event_id, qty: row.qty, status: row.status, reservationRequestId: row.reservation_request_id, createdAt: row.created_at });
  });

  // Helper for the experiments: how many orders exist (and how many units they hold) for an event.
  app.get('/stats', async (req, res) => {
    const eventId = req.query.eventId;
    const r = await pool.query('SELECT count(*)::int AS orders, coalesce(sum(qty), 0)::int AS units FROM orders WHERE ($1::text IS NULL OR event_id = $1)', [eventId || null]);
    reply(res, 200, r.rows[0]);
  });
});
