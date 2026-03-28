const { connection: redis } = require('./queue');
const logger = require('./logger');

const DEFAULT_TTL = 300; // 5 minutes

/**
 * Get-or-set pattern: returns cached value or calls fetcher and caches the result.
 * @param {string} key - Redis key (auto-prefixed with 'kosca:cache:')
 * @param {Function} fetcher - Async function that returns the data to cache
 * @param {number} [ttl=300] - TTL in seconds
 * @returns {Promise<*>} Parsed cached value or freshly fetched value
 */
async function cached(key, fetcher, ttl = DEFAULT_TTL) {
    const redisKey = `kosca:cache:${key}`;
    try {
        const hit = await redis.get(redisKey);
        if (hit) return JSON.parse(hit);
    } catch (err) {
        logger.warn({ err: err.message, key: redisKey }, 'Cache read failed, falling through to fetcher');
    }

    const data = await fetcher();

    try {
        await redis.set(redisKey, JSON.stringify(data), 'EX', ttl);
    } catch (err) {
        logger.warn({ err: err.message, key: redisKey }, 'Cache write failed');
    }

    return data;
}

/**
 * Invalidate a cached key.
 */
async function invalidate(key) {
    try {
        await redis.del(`kosca:cache:${key}`);
    } catch (_) { /* best-effort */ }
}

module.exports = { cached, invalidate };
