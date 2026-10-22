'use strict';
// Postgres access for "tickets". Every method is a single SQL statement, so behaviour is easy to reason about.
const { Pool } = require('pg');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id       text PRIMARY KEY,
  name     text NOT NULL,
  capacity int  NOT NULL CHECK (capacity >= 0),
  sold     int  NOT NULL DEFAULT 0            -- deliberately NO "CHECK (sold <= capacity)": the database would hide the naive bug
);
CREATE TABLE IF NOT EXISTS reservations (
  id         bigserial PRIMARY KEY,
  request_id text NOT NULL,
  event_id   text NOT NULL REFERENCES events(id),
  qty        int  NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reservations_event_idx ON reservations (event_id);
CREATE TABLE IF NOT EXISTS reservation_requests (  -- idempotency records (IDEMPOTENCY=on)
  request_id  text PRIMARY KEY,
  fingerprint text,                           -- eventId:qty of the first request; a reused requestId with other content is refused
  status      text NOT NULL,                  -- 'pending' | 'done'
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);`;

class PgStore {
  // readConnectionString (optional): a second Postgres (a read replica) used ONLY by readEvent()/pingRead().
  // Every other method uses the primary, which is the source of truth.
  constructor(connectionString, max, onError = () => {}, readConnectionString = '') {
    this.pool = new Pool({ connectionString, max });
    this.pool.on('error', onError); // idle connections killed by a Postgres restart must not crash the process
    this.readPool = readConnectionString ? new Pool({ connectionString: readConnectionString, max }) : null;
    if (this.readPool) this.readPool.on('error', onError);
  }

  get readFrom() { return this.readPool ? 'replica' : 'primary'; }

  // Idempotent migration; the advisory lock makes concurrent replicas take turns instead of colliding.
  async migrate() {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(7001)');
      await c.query(SCHEMA);
      await c.query('ALTER TABLE reservation_requests ADD COLUMN IF NOT EXISTS fingerprint text'); // databases created by v1
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  ping() { return this.pool.query('SELECT 1'); }
  pingRead() { return (this.readPool || this.pool).query('SELECT 1'); }
  close() { return Promise.all([this.pool.end(), this.readPool ? this.readPool.end() : null]); }

  async getEvent(id) {
    const r = await this.pool.query('SELECT id, name, capacity, sold FROM events WHERE id = $1', [id]);
    return r.rows[0] || null;
  }

  // Same as getEvent, but may be answered by the read replica (possibly out of date). Only for read endpoints.
  async readEvent(id) {
    const r = await (this.readPool || this.pool).query('SELECT id, name, capacity, sold FROM events WHERE id = $1', [id]);
    return r.rows[0] || null;
  }

  async createEvent({ id, name, capacity }) {
    const r = await this.pool.query(
      'INSERT INTO events (id, name, capacity) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id, name, capacity, sold',
      [id, name, capacity]);
    return r.rows[0] || null; // null = already exists
  }

  // UPDATE (unguarded) + INSERT reservation in one statement. Returns { sold, capacity } as Postgres has them right after
  // the write (the ground truth, whichever strategy decided), or null if the event does not exist.
  async addUnguarded(eventId, qty, requestId) {
    const r = await this.pool.query(
      `WITH u AS (UPDATE events SET sold = sold + $2::int WHERE id = $1::text RETURNING sold, capacity),
            r AS (INSERT INTO reservations (request_id, event_id, qty) SELECT $3::text, $1::text, $2::int FROM u)
       SELECT sold, capacity FROM u`, [eventId, qty, requestId]);
    return r.rows[0] || null;
  }

  // Same, but the UPDATE only happens if stock is left: check and update are ONE atomic statement.
  async addGuarded(eventId, qty, requestId) {
    const r = await this.pool.query(
      `WITH u AS (UPDATE events SET sold = sold + $2::int WHERE id = $1::text AND sold + $2::int <= capacity RETURNING sold, capacity),
            r AS (INSERT INTO reservations (request_id, event_id, qty) SELECT $3::text, $1::text, $2::int FROM u)
       SELECT sold, capacity FROM u`, [eventId, qty, requestId]);
    return r.rows[0] || null;
  }

  // Ground truth = the reservations actually recorded (not the counter, not Redis).
  async audit(eventId) {
    const r = await this.pool.query(
      `SELECT e.capacity, e.sold AS counter,
              (SELECT count(*)::int FROM reservations WHERE event_id = e.id) AS reservations,
              (SELECT coalesce(sum(qty), 0)::int FROM reservations WHERE event_id = e.id) AS reserved_qty
         FROM events e WHERE e.id = $1`, [eventId]);
    return r.rows[0] || null;
  }

  // Event ids with the stock left according to Postgres (used to pre-load Redis at start-up).
  async stockLeft() {
    const r = await this.pool.query('SELECT id, greatest(0, capacity - sold) AS remaining FROM events');
    return r.rows;
  }

  // --- idempotency records ---
  async claim(requestId, fingerprint) {
    const r = await this.pool.query(
      "INSERT INTO reservation_requests (request_id, fingerprint, status) VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING", [requestId, fingerprint]);
    return r.rowCount === 1;
  }
  async getRequest(requestId) {
    const r = await this.pool.query('SELECT status, result, fingerprint FROM reservation_requests WHERE request_id = $1', [requestId]);
    return r.rows[0] || null;
  }
  finishRequest(requestId, result) {
    return this.pool.query("UPDATE reservation_requests SET status = 'done', result = $2 WHERE request_id = $1", [requestId, JSON.stringify(result)]);
  }
  releaseRequest(requestId) {
    return this.pool.query("DELETE FROM reservation_requests WHERE request_id = $1 AND status = 'pending'", [requestId]);
  }
}

module.exports = { PgStore };
