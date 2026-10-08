// PL01 — minimal Express app used throughout the Docker lab.
// Endpoints:
//   GET /       -> plain info (hostname, uptime)
//   GET /health -> JSON health payload (hostname, uptime)
//   GET /db     -> runs SELECT now() against Postgres (used from section 5, Compose)
'use strict';

const express = require('express');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({
    message: 'Hello from PL01!',
    hostname: os.hostname(),
    uptime: process.uptime(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    hostname: os.hostname(),
    uptime: process.uptime(),
  });
});

app.get('/db', async (req, res) => {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    // No DATABASE_URL set: this happens when the app runs without Compose
    // (e.g. `docker run` alone, or `node app.js` locally with no Postgres).
    // We fail with a clear, explicit error instead of crashing.
    return res.status(500).json({
      status: 'error',
      error: 'DATABASE_URL is not set. Run this app via `docker compose up` (section 5) to get a database.',
    });
  }

  // Lazy require so that / and /health keep working even if the "pg"
  // package or the database itself is unavailable.
  const { Client } = require('pg');
  const client = new Client({ connectionString });

  try {
    await client.connect();
    const result = await client.query('SELECT now()');
    res.json({ status: 'ok', now: result.rows[0].now });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: err.message,
    });
  } finally {
    await client.end().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`PL01 app listening on port ${PORT} (hostname: ${os.hostname()})`);
});
