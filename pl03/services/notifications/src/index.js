'use strict';
// notifications: the worker that "sends" notifications for confirmed orders. Two entry points:
//   - HTTP:     POST /notify            (used by orders with NOTIFY_MODE=sync)
//   - RabbitMQ: queue order.created     (used by orders with NOTIFY_MODE=async; durable queue, manual ack, prefetch)
// "Sending" = wait NOTIFY_DELAY_MS, maybe fail (NOTIFY_FAIL_RATE), then record the order id in Postgres (idempotent).
const express = require('express');
const { Pool } = require('pg');
const { str, num, sleep, makeLogger, reply, retry, createService, client } = require('./lib');
const { QUEUE, DLQ, amqpConnection } = require('./amqp');
const { shouldFail, onFailure } = require('./delivery');

const log = makeLogger('notifications');
const config = {
  port: num('PORT', 3003),
  databaseUrl: str('DATABASE_URL', 'postgres://app:app@localhost:5432/notifications'),
  rabbitUrl: str('RABBITMQ_URL', 'amqp://app:app@localhost:5672'),
  consumer: str('CONSUMER', 'on') === 'on', // on | off: consume the queue
  prefetch: num('PREFETCH', 10), // unacknowledged messages per consumer
  delayMs: num('NOTIFY_DELAY_MS', 0), // simulates a slow email/SMS provider
  failRate: num('NOTIFY_FAIL_RATE', 0), // 0..1
  pgPoolMax: num('PG_POOL_MAX', 10),
};

const pool = new Pool({ connectionString: config.databaseUrl, max: config.pgPoolMax });
pool.on('error', (err) => log.warn('postgres pool error', { err: err.message })); // a Postgres restart must not crash us

const sent = new client.Counter({ name: 'notifications_sent_total', help: 'Notifications delivered', labelNames: ['channel'] });
const consumed = new client.Counter({ name: 'notifications_messages_consumed_total', help: 'Queue messages received (including redeliveries)' });
const failed = new client.Counter({ name: 'notifications_messages_failed_total', help: 'Delivery attempts that failed', labelNames: ['channel'] });
const deadLettered = new client.Counter({ name: 'notifications_messages_dead_lettered_total', help: 'Messages sent to the dead-letter queue' });
for (const channel of ['queue', 'http']) { sent.inc({ channel }, 0); failed.inc({ channel }, 0); } // show zeros before the first event

// One delivery attempt. Recording with ON CONFLICT DO NOTHING makes redelivered messages harmless (idempotent consumer).
async function deliver(order, channel) {
  await sleep(config.delayMs);
  if (shouldFail(config.failRate)) {
    failed.inc({ channel });
    throw new Error('simulated delivery failure');
  }
  await pool.query('INSERT INTO sent_notifications (order_id, event_id, qty, channel) VALUES ($1, $2, $3, $4) ON CONFLICT (order_id) DO NOTHING',
    [order.orderId, order.eventId, order.qty, channel]);
  sent.inc({ channel });
}

async function handleMessage(ch, msg) {
  if (!msg) return; // consumer cancelled by the broker
  consumed.inc();
  let order;
  try {
    order = JSON.parse(msg.content.toString());
    if (!order.orderId) throw new Error('missing orderId');
  } catch (err) {
    log.error('unreadable message, dead-lettering', { err: err.message });
    deadLettered.inc();
    return ch.nack(msg, false, false);
  }
  try {
    await deliver(order, 'queue');
    ch.ack(msg); // manual ack: only after the work is recorded. A crash before this line = the broker redelivers.
  } catch (err) {
    if (onFailure(msg) === 'requeue') {
      log.warn('delivery failed, requeueing', { orderId: order.orderId, err: err.message });
      ch.nack(msg, false, true);
    } else {
      log.warn('delivery failed again, dead-lettering', { orderId: order.orderId, err: err.message });
      deadLettered.inc();
      ch.nack(msg, false, false);
    }
  }
}

const broker = config.consumer
  ? amqpConnection({
    url: config.rabbitUrl,
    log,
    onChannel: async (ch) => {
      await ch.prefetch(config.prefetch);
      await ch.consume(QUEUE, (msg) => handleMessage(ch, msg).catch((err) => log.warn('message handling error', { err: err.message })), { noAck: false });
      log.info('consuming', { queue: QUEUE, dlq: DLQ, prefetch: config.prefetch });
    },
  })
  : null;

const svc = createService({
  name: 'notifications',
  port: config.port,
  log,
  init: async () => {
    await retry(async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(7003)');
        await c.query(`CREATE TABLE IF NOT EXISTS sent_notifications (
          order_id text PRIMARY KEY,
          event_id text,
          qty      int,
          channel  text NOT NULL,
          sent_at  timestamptz NOT NULL DEFAULT now())`);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    }, { what: 'postgres', log });
    if (broker) await broker.connect();
    log.info('config', { consumer: config.consumer, prefetch: config.prefetch, delayMs: config.delayMs, failRate: config.failRate });
  },
  checks: {
    postgres: () => pool.query('SELECT 1'),
    ...(broker ? { rabbitmq: async () => { if (!broker.isUp()) throw new Error('not connected'); } } : {}),
  },
  shutdown: async () => {
    if (broker) await broker.close(); // stops consuming; unacked messages go back to the queue
    await pool.end();
  },
});

svc.start((app) => {
  app.use(express.json());

  app.post('/notify', async (req, res) => {
    const { orderId, eventId, qty } = req.body || {};
    if (typeof orderId !== 'string' || !orderId) return reply(res, 400, { error: 'expected {orderId: string, eventId?, qty?}' });
    try {
      await deliver({ orderId, eventId, qty }, 'http');
    } catch (err) {
      return reply(res, 500, { error: 'notification_failed', orderId });
    }
    reply(res, 200, { status: 'sent', orderId });
  });

  // Helper for the experiments: how many distinct orders were notified (optionally for one event).
  app.get('/stats', async (req, res) => {
    const r = await pool.query(
      `SELECT count(*)::int AS sent,
              count(*) FILTER (WHERE channel = 'queue')::int AS via_queue,
              count(*) FILTER (WHERE channel = 'http')::int AS via_http
         FROM sent_notifications WHERE ($1::text IS NULL OR event_id = $1)`, [req.query.eventId || null]);
    reply(res, 200, r.rows[0]);
  });
});
