'use strict';
// Redis side of STOCK_STRATEGY=redis-atomic: one counter per event ("stock:<id>" = units still available).
const Redis = require('ioredis');
const { REDIS_MISSING, REDIS_SOLD_OUT } = require('./stock');

// The Lua script runs atomically inside Redis: check and decrement cannot interleave with another request.
const TAKE = `
local left = redis.call('GET', KEYS[1])
if not left then return ${REDIS_MISSING} end
if tonumber(left) < tonumber(ARGV[1]) then return ${REDIS_SOLD_OUT} end
return redis.call('DECRBY', KEYS[1], ARGV[1])`;

class RedisStock {
  constructor(url) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2 });
    this.redis.on('error', () => {}); // connection errors surface through the failed commands and /ready
    this.redis.defineCommand('takeStock', { numberOfKeys: 1, lua: TAKE });
  }
  key(id) { return `stock:${id}`; }
  ping() { return this.redis.ping(); }
  close() { return this.redis.quit(); }
  async take(id, qty) { return Number(await this.redis.takeStock(this.key(id), qty)); }
  async giveBack(id, qty) { await this.redis.incrby(this.key(id), qty); }
  async init(id, remaining, { onlyIfMissing = false } = {}) {
    if (onlyIfMissing) await this.redis.set(this.key(id), remaining, 'NX');
    else await this.redis.set(this.key(id), remaining);
  }
}

module.exports = { RedisStock };
