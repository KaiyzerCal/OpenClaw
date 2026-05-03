'use strict';

/**
 * Fallback middleware for Claude API requests.
 *
 * On transient failures (rate-limit, overload, server error) it retries with
 * exponential back-off, then degrades to a cheaper model before giving up.
 *
 * Usage:
 *   const { createFallbackMiddleware } = require('./claude-fallback-middleware');
 *   const middleware = createFallbackMiddleware({ primaryModel: 'claude-opus-4-7' });
 *   app.use('/api/claude', middleware);
 */

const RETRYABLE_STATUS = new Set([429, 503, 529]);

const DEFAULT_OPTIONS = {
  primaryModel: 'claude-opus-4-7',
  fallbackModel: 'claude-haiku-4-5-20251001',
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  timeoutMs: 30_000,
};

/**
 * Sleep for `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute exponential back-off delay with jitter.
 * @param {number} attempt  0-based retry attempt number
 * @param {number} base     initial delay in ms
 * @param {number} max      ceiling in ms
 * @returns {number}
 */
function backoffDelay(attempt, base, max) {
  const exponential = base * 2 ** attempt;
  const jitter = Math.random() * exponential * 0.2;
  return Math.min(exponential + jitter, max);
}

/**
 * Attempt a single fetch-based Claude API call, returning the raw Response.
 * Throws on network/timeout errors.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Core retry + model-fallback logic.
 *
 * @param {string} url         Upstream Claude API endpoint
 * @param {RequestInit} init   Fetch options (method, headers, body)
 * @param {object} opts        Merged options
 * @returns {Promise<Response>}
 */
async function callWithFallback(url, init, opts) {
  const models = [opts.primaryModel, opts.fallbackModel].filter(Boolean);

  for (const model of models) {
    const body = init.body ? JSON.parse(init.body) : {};
    body.model = model;
    const modifiedInit = { ...init, body: JSON.stringify(body) };

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = backoffDelay(attempt - 1, opts.initialDelayMs, opts.maxDelayMs);
        await sleep(delay);
      }

      let response;
      try {
        response = await fetchWithTimeout(url, modifiedInit, opts.timeoutMs);
      } catch (err) {
        // Network error or timeout — retry within same model
        if (attempt < opts.maxRetries) continue;
        // Exhausted retries for this model, try next model
        break;
      }

      if (response.ok) return response;

      if (RETRYABLE_STATUS.has(response.status) && attempt < opts.maxRetries) {
        // Honour Retry-After header when present
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          const retryMs = parseFloat(retryAfter) * 1000;
          await sleep(Math.min(retryMs, opts.maxDelayMs));
        }
        continue;
      }

      // Non-retryable error or retries exhausted for this model
      break;
    }
  }

  // All models and retries exhausted
  return new Response(
    JSON.stringify({ error: 'Claude API unavailable after retries and model fallback' }),
    { status: 503, headers: { 'content-type': 'application/json' } }
  );
}

/**
 * Build an Express-compatible middleware that adds retry + model-fallback to
 * outbound Claude API requests.
 *
 * @param {Partial<typeof DEFAULT_OPTIONS>} userOptions
 * @returns {import('express').RequestHandler}
 */
function createFallbackMiddleware(userOptions = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...userOptions };

  return async function claudeFallbackMiddleware(req, res, next) {
    const upstreamBase =
      process.env.CLAUDE_API_BASE_URL || 'https://api.anthropic.com';

    // Only intercept requests that carry a JSON body bound for Claude
    if (!req.is('application/json')) {
      return next();
    }

    const url = `${upstreamBase}${req.path}`;

    // Forward all incoming headers, replacing the host
    const headers = { ...req.headers };
    delete headers['host'];
    delete headers['content-length']; // will be recalculated

    let rawBody;
    try {
      rawBody = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
    } catch (err) {
      return next(err);
    }

    let upstream;
    try {
      upstream = await callWithFallback(
        url,
        {
          method: req.method,
          headers: { ...headers, 'content-type': 'application/json' },
          body: rawBody,
        },
        opts
      );
    } catch (err) {
      return next(err);
    }

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    const body = await upstream.text();
    res.send(body);
  };
}

module.exports = { createFallbackMiddleware, callWithFallback, backoffDelay };
