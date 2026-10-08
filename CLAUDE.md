# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Student coursework for CDN (Computação Distribuída e em Nuvem), MEI · ESTG P.PORTO · 2026/27. Each `plNN/` folder holds the code handed out for one lab session (ficha); `docs/` holds the runbooks written while doing the labs.

- Code and code READMEs from the course are in English. Runbooks, commit messages and the root README are in European Portuguese (pt-PT); keep that.
- Runbooks follow a fixed shape: environment line, numbered sections with copy-pasteable bash blocks, "Resultados obtidos" tables with measured values, a "Problemas encontrados" table (Sintoma | Causa | Solução), and for PL03 a mapping to the theory class (T04).
- Target environment: Windows 11 + WSL2 Ubuntu + Docker Desktop + kubectl + k3d. Commands in runbooks run in the Ubuntu terminal from `~/cdn/plNN` (the course handouts say `~/plNN`). The exception is PL01: it was run from this checkout (`/mnt/c/.../Computacao-Distribuida-Nuvem/pl01`).
- Runbooks are being renamed to `docs/PLNN-<Tema>.md`, with a folder tree at the top and a "Resumo da execução" table at the end. `docs/PL01-Docker.md` is the first; PL02 and PL03 still use the old `runbook-plNN.md` names.
- To run WSL commands from the Git Bash tool, prefix with `MSYS_NO_PATHCONV=1`. Without it, `/mnt/c/...` paths get rewritten to Windows paths.

## pl01 — Docker

Express app (`GET /`, `/health`, `/db`) + Postgres. `compose.yaml` deliberately has `depends_on` without a health condition (the "first attempt" that races Postgres); `compose.healthcheck.yaml` is the fixed version.

```bash
cd pl01 && npm ci && node app.js            # local, port 3000
docker compose up -d --build                # app + Postgres
docker compose -f compose.healthcheck.yaml up -d --build
```

## pl02 — Kubernetes on k3d

The PL01 app with one change: `GET /` also returns `version` from `APP_VERSION`. `k8s/` has one manifest per object (app Deployment/Service, Ingress, Postgres ConfigMap/Secret/PVC/Deployment/Service). The student edits `k8s/app-deployment.yaml` in sections 5 and 6. `k8s/solucao/app-deployment-s5.yaml` and `-s6.yaml` show how it should look after each section (compare with `diff`); s6 bumps the image to `cdn-app:1.1` for the rolling update.

```bash
k3d cluster create cdn --servers 1 --agents 2 -p "8080:80@loadbalancer" --registry-config registries.yaml
docker build -t cdn-app:1.0 app && k3d image import cdn-app:1.0 -c cdn
kubectl apply -f k8s/app-deployment.yaml -f k8s/app-service.yaml -f k8s/ingress.yaml
kubectl apply -f k8s/db-config.yaml -f k8s/db-secret.yaml -f k8s/db-pvc.yaml -f k8s/db-deployment.yaml -f k8s/db-service.yaml
```

## pl03 — Flash-sale ticketing on k3d

Three Node.js/Express 5 services (`tickets` :3001, `orders` :3002, `notifications` :3003), one Postgres with three databases, one RabbitMQ, exposed by a Traefik Ingress at `http://localhost:8080/{tickets,orders}`. `pl03/README.md` is the authoritative reference for every endpoint and env var; `docs/runbook-pl03.md` has the full sequence of commands and results.

The lab premise is that service code is **not** edited: the work is building images, writing manifests (`k8s/notifications.yaml`, `k8s/orders.yaml`, `k8s/ingress.yaml` are student-written; the others were provided), and changing behaviour through ConfigMap values.

### Architecture points that span files

- `src/lib.js` is an identical copy in each service (logging, `/health`, `/ready`, `/metrics`, request-id, graceful shutdown, `retry`, `createService`). Change all three copies together or none. Same for `amqp.js` in `orders` and `notifications`.
- `orders` → `tickets`: HTTP with per-attempt timeout, retries with doubling backoff, and **one `requestId` per order reused on every retry** (`tickets-client.js`). `tickets` deduplicates on that `requestId` when `IDEMPOTENCY=on`; the lab's challenge (section 8) shows oversell with `IDEMPOTENCY=off` + `RESPONSE_DELAY_MS` > `TICKETS_TIMEOUT_MS`.
- `orders` → `notifications`: `NOTIFY_MODE=sync` calls `POST /notify`; `async` uses a transactional outbox (`outbox.js`: order + outbox row in one transaction, relay with `FOR UPDATE SKIP LOCKED` and publisher confirms) feeding the durable `order.created` queue. Delivery is at-least-once; `notifications` dedupes by `orderId`. A notification failure never fails an order.
- `tickets` picks its stock logic with `STOCK_STRATEGY` (`naive` | `db-atomic` | `redis-atomic`; see `stock.js`). The lab keeps `db-atomic`. Redis is only connected when `redis-atomic` is set along with `REDIS_URL`. Oversell is always counted from the reservations in Postgres, whichever strategy is used.
- Env vars are read only at startup: after editing a ConfigMap, `kubectl apply` **and** `kubectl rollout restart deployment/<name>`.
- Ingress uses the Traefik-specific `strip-prefix` Middleware (`k8s/traefik-middleware.yaml`), so `/orders/orders` = Ingress prefix + service route.

### Commands (from `pl03/`, in WSL)

```bash
k3d cluster create cdn --servers 1 --agents 2 -p "8080:80@loadbalancer" --registry-config registries.yaml
docker build -t cdn-tickets:1.0 services/tickets      # same for orders, notifications
k3d image import cdn-tickets:1.0 cdn-orders:1.0 cdn-notifications:1.0 -c cdn
kubectl apply -f k8s/secrets.yaml -f k8s/postgres.yaml -f k8s/rabbitmq.yaml
kubectl apply -f k8s/tickets.yaml -f k8s/notifications.yaml -f k8s/orders.yaml
kubectl apply -f k8s/traefik-middleware.yaml -f k8s/ingress.yaml

# load test (k6 in Docker on the cluster network)
docker run --rm --network k3d-cdn -v "$PWD/k6:/k6" \
  -e TICKETS_URL=http://k3d-cdn-serverlb/tickets -e ORDERS_URL=http://k3d-cdn-serverlb/orders \
  -e TARGET=orders -e VUS=10 -e DURATION=10s -e CAPACITY=100000 \
  grafana/k6 run --quiet /k6/flash-sale.js

k3d cluster delete cdn
```

Images use `imagePullPolicy: IfNotPresent` and are imported, not pushed; verify the import with `docker exec k3d-cdn-<node> crictl images`. `registries.yaml` routes `docker.io` pulls through `mirror.gcr.io`.

There are no tests or linters in the repo: the services' `npm test` points at `test/*.test.js` (and `lib.js` mentions `scripts/check-lib.sh`), neither of which was included in the handout.
