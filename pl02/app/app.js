// PL02 — Express app from PL01, deployed on Kubernetes (k3d).
// Endpoints:
//   GET /       -> plain info (hostname, version, uptime); version comes from APP_VERSION
//   GET /health -> JSON health payload (hostname, uptime)
//   GET /db     -> runs SELECT now() against Postgres (needs DATABASE_URL, set in section 5 of the PL02 guide)
'use strict';

const express = require('express');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({
    message: 'Hello from PL02!',
    version: process.env.APP_VERSION || 'unset',
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
    // (e.g. before the Secret from section 5 is wired in, or `node app.js` locally with no Postgres).
    // We fail with a clear, explicit error instead of crashing.
    return res.status(500).json({
      status: 'error',
      error: 'DATABASE_URL is not set. Set it through the Secret (section 5 of the PL02 guide).',
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
  console.log(`PL02 app listening on port ${PORT} (hostname: ${os.hostname()})`);
});
