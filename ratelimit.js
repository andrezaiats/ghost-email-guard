const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 5;
const RATE_LIMIT_WINDOW_MS = (parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES, 10) || 60) * 60000;
const CLEANUP_INTERVAL_MS = 5 * 60000; // clean up expired entries every 5 min

// Map<ip, { count, resetAt }>
const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);

  if (!entry || now >= entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return true;
  }

  return false;
}

function retryAfterSeconds(ip) {
  const entry = hits.get(ip);
  if (!entry) return 0;
  return Math.ceil((entry.resetAt - Date.now()) / 1000);
}

function stats() {
  return { trackedIPs: hits.size, maxPerWindow: RATE_LIMIT_MAX, windowMinutes: RATE_LIMIT_WINDOW_MS / 60000 };
}

// Periodically clean up expired entries to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [ip, entry] of hits) {
    if (now >= entry.resetAt) {
      hits.delete(ip);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[ratelimit] Cleaned ${cleaned} expired entries, ${hits.size} active`);
  }
}, CLEANUP_INTERVAL_MS);

module.exports = { isRateLimited, retryAfterSeconds, stats };
