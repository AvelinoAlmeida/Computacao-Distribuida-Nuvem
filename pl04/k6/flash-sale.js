// Flash-sale load test. Everyone hits the same event at the same time; at the end we ask tickets for the truth (/audit).
//
//   bash k6/run.sh -e VUS=50 -e DURATION=10s -e CAPACITY=100
// (k6/run.sh runs k6 in a container on the cluster network and passes the Ingress URLs;
// inside a container, localhost is the container itself, not your laptop)
//
// Parameters (environment variables):
//   TARGET       tickets | orders        what to hammer: POST /reservations or POST /orders   (default tickets)
//   TICKETS_URL  base URL of tickets     (default http://localhost:3001; via Ingress: http://localhost:8080/tickets)
//   ORDERS_URL   base URL of orders      (default http://localhost:3002; via Ingress: http://localhost:8080/orders)
//   VUS          concurrent virtual users (default 200)      DURATION   test length (default 20s)
//   CAPACITY     tickets of the new event (default 100)      QTY        tickets per request (default 1)
//   EVENT_ID     id of the event to create (default flash-<timestamp>)
//   THINK_MS     pause between requests of one user (default 0)
// 201 (reserved/confirmed) and 409 (sold out) are expected answers; anything else (5xx, timeout) counts as an error.
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const int = (name, def) => (__ENV[name] ? parseInt(__ENV[name], 10) : def);
const TICKETS = __ENV.TICKETS_URL || 'http://localhost:3001';
const ORDERS = __ENV.ORDERS_URL || 'http://localhost:3002';
const TARGET = __ENV.TARGET || 'tickets';
const CAPACITY = int('CAPACITY', 100);
const QTY = int('QTY', 1);
const THINK_MS = int('THINK_MS', 0);
const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };

export const options = {
  scenarios: { flash: { executor: 'constant-vus', vus: int('VUS', 200), duration: __ENV.DURATION || '20s' } },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'max'],
};

http.setResponseCallback(http.expectedStatuses(201, 409));
const latency = new Trend('flash_latency', true); // ms, main requests only (not setup/audit)
const errors = new Rate('flash_errors');
const requests = new Counter('flash_requests'); // ALL main requests, errors included
const accepted = new Counter('flash_accepted'); // 201
const soldOut = new Counter('flash_sold_out'); // 409
const errNoReply = new Counter('flash_err_no_reply'); // status 0: timeout, connection refused/reset
const err5xx = new Counter('flash_err_5xx'); // 5xx answers (502/503/504 also come from the Ingress)

export function setup() {
  const eventId = __ENV.EVENT_ID || `flash-${Date.now()}`;
  const res = http.post(`${TICKETS}/events`, JSON.stringify({ id: eventId, name: 'Flash sale', capacity: CAPACITY }), JSON_HEADERS);
  if (res.status !== 201) throw new Error(`could not create event ${eventId}: HTTP ${res.status} ${res.body}`);
  return { eventId };
}

export default function (data) {
  let res;
  if (TARGET === 'orders') {
    res = http.post(`${ORDERS}/orders`, JSON.stringify({ eventId: data.eventId, qty: QTY }), JSON_HEADERS);
  } else {
    const requestId = `k6-${data.eventId}-${__VU}-${__ITER}`;
    res = http.post(`${TICKETS}/reservations`, JSON.stringify({ eventId: data.eventId, qty: QTY, requestId }), JSON_HEADERS);
  }
  requests.add(1);
  latency.add(res.timings.duration);
  errors.add(res.status !== 201 && res.status !== 409);
  if (res.status === 201) accepted.add(1);
  if (res.status === 409) soldOut.add(1);
  if (res.status === 0) errNoReply.add(1);
  if (res.status >= 500) err5xx.add(1);
  if (THINK_MS > 0) sleep(THINK_MS / 1000);
}

export function handleSummary(data) {
  const v = (metric, key) => (data.metrics[metric] && data.metrics[metric].values[key]) || 0;
  const eventId = data.setup_data && data.setup_data.eventId;
  const audit = http.get(`${TICKETS}/events/${eventId}/audit`);
  const a = audit.status === 200 ? audit.json() : {};
  const total = v('flash_requests', 'count');
  const out = [
    '',
    '================ flash-sale result ================',
    `target        : ${TARGET}   event: ${eventId}   capacity: ${CAPACITY}   VUs: ${int('VUS', 200)}   duration: ${__ENV.DURATION || '20s'}`,
    `strategy      : ${a.strategy}`,
    `sold          : ${a.sold}   (capacity ${a.capacity}; recorded reservations in Postgres)`,
    `OVERSOLD      : ${a.oversold}`,
    `requests      : ${total}   accepted(201): ${v('flash_accepted', 'count')}   sold-out(409): ${v('flash_sold_out', 'count')}`,
    `errors        : ${Math.round(v('flash_errors', 'passes'))} of ${total}   (${total ? (v('flash_errors', 'passes') / total * 100).toFixed(2) : '0.00'}%)   [no reply: ${v('flash_err_no_reply', 'count')}, 5xx: ${v('flash_err_5xx', 'count')}]`,
    `latency (ms)  : avg ${v('flash_latency', 'avg').toFixed(1)}   med ${v('flash_latency', 'med').toFixed(1)}   p95 ${v('flash_latency', 'p(95)').toFixed(1)}   max ${v('flash_latency', 'max').toFixed(1)}`,
    `throughput    : ${(total / (data.state.testRunDurationMs / 1000)).toFixed(0)} req/s`,
    '===================================================',
    '',
  ].join('\n');
  return { stdout: out };
}
