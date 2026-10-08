# Flash-sale ticketing: services for PL03

Three small Node.js/Express services that sell tickets for a flash sale. You do not edit the code: you build the images, write the Kubernetes manifests, operate the system and measure it. Read `services/<name>/src/` if you want to see what a variable does.

```
                    HTTP (timeout, retries)
  client --> Ingress --> orders ------------------> tickets --> Postgres (db tickets)
                           |  \
              sync: HTTP   |   \ async: message "order.created"
                           v    v
                     notifications <------ RabbitMQ (durable queue, manual ack)
                           |
                           +--> Postgres (db notifications)
```

`orders` has its own database (`orders`). One Postgres server hosts the three databases.

## Content

| Path | What it is |
|---|---|
| `services/` | The three services (`tickets`, `orders`, `notifications`), each with a `Dockerfile`. |
| `k8s/` | Provided manifests: `secrets.yaml`, `postgres.yaml`, `rabbitmq.yaml`, `tickets.yaml`, `traefik-middleware.yaml`. You write `notifications.yaml`, `orders.yaml` and `ingress.yaml` here. |
| `k6/flash-sale.js` | Load test: creates an event, sends requests, prints errors and p95. |
| `registries.yaml` | Makes the cluster nodes pull `docker.io` images through the public mirror `mirror.gcr.io`. |

## Common to all services

| Endpoint | Meaning |
|---|---|
| `GET /health` | Liveness: the process is up. |
| `GET /ready` | Readiness: the dependencies the active configuration needs answer. |
| `GET /metrics` | Prometheus metrics. |

- Every JSON answer contains `hostname`: the Pod that answered.
- Logs: one JSON object per line. `LOG_LEVEL` = `debug`, `info`, `warn` or `error` (default `info`).
- Environment variables are read only at start-up: to change one, edit the ConfigMap, `kubectl apply` it and run `kubectl rollout restart deployment/<name>`.
- Services wait up to about 90 s for Postgres and RabbitMQ at start-up, and exit with an error afterwards.
- `PG_POOL_MAX` (default 10): size of the Postgres connection pool.

## tickets (port 3001)

| Endpoint | Body / answer |
|---|---|
| `POST /events` | `{id, name, capacity}` -> `201`; `409` if the id exists. |
| `GET /events/:id` | `{id, name, capacity, sold, available}` |
| `POST /reservations` | `{eventId, qty, requestId}` -> `201` reserved, `409` sold out, `404` unknown event, `422` if the `requestId` was used with another `eventId` or `qty` (idempotency on). |
| `GET /events/:id/audit` | `{capacity, sold, oversold, reservations, ...}`: `sold` is the sum of the reservations recorded in Postgres. |

| Variable | Default | Meaning |
|---|---|---|
| `STOCK_STRATEGY` | `db-atomic` | How stock is decided. Keep `db-atomic`. |
| `IDEMPOTENCY` | `on` | `on`: a repeated `requestId` returns the stored result and never reserves twice. `off`: every request reserves. |
| `RESPONSE_DELAY_MS` | `0` | Delay **after** a reservation is made and before answering: the work happens, the answer is late. |
| `DATABASE_URL` | local Postgres | Postgres connection string (database `tickets`). |

## orders (port 3002)

| Endpoint | Body / answer |
|---|---|
| `POST /orders` | `{eventId, qty}` -> `201 {id, status, attempts, notification}` where `notification` is `sent` (sync) or `queued` (async); `409` sold out; `404` unknown event; `504` / `502` if `tickets` never answered properly. |
| `GET /orders/:id` | The order. |
| `GET /stats?eventId=` | `{orders, units}` for an event. |

`POST /orders` creates one `requestId` per order, calls `tickets` (`POST /reservations`) and **reuses the same `requestId` on every retry**, stores the order, then notifies.

| Variable | Default | Meaning |
|---|---|---|
| `TICKETS_URL` | `http://localhost:3001` | Where `tickets` is. |
| `TICKETS_TIMEOUT_MS` | `2000` | Timeout of each attempt. |
| `TICKETS_RETRIES` | `2` | Extra attempts after the first (network errors, timeouts, 5xx; never for 409 or 404). |
| `TICKETS_BACKOFF_MS` | `100` | Wait before the first retry; doubles on each retry. |
| `NOTIFY_MODE` | `sync` | `sync`: call `notifications` over HTTP and wait for it. `async`: publish `order.created` to RabbitMQ and answer. |
| `NOTIFICATIONS_URL` | `http://localhost:3003` | Where `notifications` is (`sync` mode). |
| `NOTIFY_TIMEOUT_MS` | `5000` | Timeout of the call to `notifications` (`sync` mode). |
| `RABBITMQ_URL` | local RabbitMQ | RabbitMQ connection string (`async` mode). |
| `DATABASE_URL` | local Postgres | Postgres connection string (database `orders`). |

In `async` mode the order and an *outbox* row are written in one Postgres transaction, and a relay inside `orders` publishes the row to RabbitMQ (`OUTBOX=on`, the default). A failed notification never fails the order.

## notifications (port 3003)

| Entry point | Meaning |
|---|---|
| `POST /notify` | `{orderId, eventId?, qty?}` -> `200`. Used by `orders` in `sync` mode. |
| queue `order.created` | Durable queue, manual `ack`. Used by `orders` in `async` mode. |
| `GET /stats?eventId=` | `{sent, via_queue, via_http}`: distinct orders notified. |

"Sending" waits `NOTIFY_DELAY_MS` (a slow e-mail or SMS provider) and then records the order id in Postgres.

| Variable | Default | Meaning |
|---|---|---|
| `CONSUMER` | `on` | `on`: consume the queue. `off`: HTTP only. |
| `PREFETCH` | `10` | Messages the consumer may hold without acknowledging. |
| `NOTIFY_DELAY_MS` | `0` | Time one notification takes. |
| `NOTIFY_FAIL_RATE` | `0` | Probability (0 to 1) that one delivery attempt fails. Keep `0`. |
| `RABBITMQ_URL` | local RabbitMQ | RabbitMQ connection string. |
| `DATABASE_URL` | local Postgres | Postgres connection string (database `notifications`). |

## Load test

`k6/flash-sale.js` creates an event, sends requests from `VUS` concurrent users for `DURATION`, then asks `tickets` for the audit and prints requests, errors and latency (`p95`).

| Variable | Default | Meaning |
|---|---|---|
| `TARGET` | `tickets` | `tickets`: `POST /reservations`. `orders`: `POST /orders`. |
| `TICKETS_URL`, `ORDERS_URL` | `http://localhost:3001`, `http://localhost:3002` | Base URLs. Through the Ingress they end in `/tickets` and `/orders`. |
| `VUS`, `DURATION` | `200`, `20s` | Concurrent users and test length. |
| `CAPACITY` | `100` | Tickets of the new event. |
| `EVENT_ID` | `flash-<timestamp>` | Id of the event to create. |

`201` and `409` (sold out) are expected answers; anything else counts as an error.
