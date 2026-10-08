# PL01 — code

Minimal Express app + Postgres, used throughout the PL01 guide (`../MEI.CDN-2627-PL01.md`).

- `app.js` / `package.json` — the app (`GET /`, `GET /health`, `GET /db`).
- `Dockerfile`, `.dockerignore` — build the app image (identical to the T02 reference).
- `compose.yaml` — app + Postgres, `depends_on` without a health condition (section 5, first attempt).
- `compose.healthcheck.yaml` — same stack with a Postgres `healthcheck` and `condition: service_healthy` (the fix).

Run locally without Docker: `npm ci && node app.js`, then `curl localhost:3000/health`.
With Docker: `docker compose up -d --build`, then `curl localhost:3000/db`.
