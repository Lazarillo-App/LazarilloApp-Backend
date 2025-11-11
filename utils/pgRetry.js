// utils/pgRetry.js
const RETRYABLE_SUBSTR = [
  'Connection terminated unexpectedly',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'socket hang up',
  'read ECONNRESET',
  'server closed the connection unexpectedly',
];

function isRetryablePgError(e) {
  const msg = `${e?.code || ''} ${e?.message || ''}`.toLowerCase();
  return RETRYABLE_SUBSTR.some(s => msg.includes(s.toLowerCase()));
}

async function pgQueryRetry(pool, text, params = [], { attempts = 3, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await pool.query(text, params);
    } catch (e) {
      lastErr = e;
      if (!isRetryablePgError(e) || i === attempts) throw e;
      await new Promise(r => setTimeout(r, baseDelayMs * i));
    }
  }
  throw lastErr;
}

module.exports = { pgQueryRetry };
