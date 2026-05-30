const http = require('http');
const httpProxy = require('http-proxy');
const blocklist = require('./blocklist');
const ratelimit = require('./ratelimit');

const GHOST_TARGET = process.env.GHOST_URL || 'http://127.0.0.1:2368';
const PORT = parseInt(process.env.PORT, 10) || 2369;
const MAX_BODY = 10 * 1024; // 10 KB
const BLOCK_MESSAGE = process.env.BLOCK_MESSAGE ||
  'Disposable email addresses are not allowed. Please use a permanent email.';
const RATE_LIMIT_MESSAGE = process.env.RATE_LIMIT_MESSAGE ||
  'Too many signup attempts. Please try again later.';

const proxy = httpProxy.createProxyServer({ target: GHOST_TARGET, xfwd: true });

proxy.on('error', (err, req, res) => {
  console.error('[proxy] Error:', err.message);
  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ message: 'Upstream unavailable', type: 'ProxyError' }] }));
  }
});

function bufferBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function proxyWithBody(req, res, body) {
  proxy.web(req, res, {
    buffer: {
      pipe: function (proxyReq) {
        proxyReq.setHeader('Content-Length', Buffer.byteLength(body));
        proxyReq.write(body);
        proxyReq.end();
      },
      resume: function () {},
    },
  });
}

function sendBlock(res) {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    errors: [{
      message: BLOCK_MESSAGE,
      type: 'ValidationError',
    }],
  }));
}

const server = http.createServer(async (req, res) => {
  // Healthcheck
  if (req.method === 'GET' && req.url === '/healthz') {
    const bs = blocklist.stats();
    const rs = ratelimit.stats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', blocklist: bs.blocklist, allowlist: bs.allowlist, ratelimit: rs }));
    return;
  }

  // Only intercept POST to the magic-link endpoint
  if (req.method === 'POST' && req.url.startsWith('/members/api/send-magic-link')) {
    // Rate limiting by IP (checked before parsing body)
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.headers['x-real-ip']
      || req.socket.remoteAddress;
    if (ratelimit.isRateLimited(clientIP)) {
      const retryAfter = ratelimit.retryAfterSeconds(clientIP);
      console.log(`[ratelimited] IP ${clientIP} (retry after ${retryAfter}s)`);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
      });
      res.end(JSON.stringify({
        errors: [{ message: RATE_LIMIT_MESSAGE, type: 'TooManyRequestsError' }],
      }));
      return;
    }

    let body;
    try {
      body = await bufferBody(req);
    } catch (err) {
      proxy.web(req, res);
      return;
    }

    try {
      const parsed = JSON.parse(body.toString('utf-8'));
      if (parsed.email && typeof parsed.email === 'string') {
        const atIndex = parsed.email.lastIndexOf('@');
        if (atIndex > 0) {
          const domain = parsed.email.substring(atIndex + 1).toLowerCase();
          if (blocklist.isDisposable(domain)) {
            console.log(`[blocked] ${parsed.email} (domain: ${domain})`);
            sendBlock(res);
            return;
          }
        }
      }
    } catch {
      // Not valid JSON — let Ghost handle it
    }

    proxyWithBody(req, res, body);
    return;
  }

  // Everything else: transparent proxy
  proxy.web(req, res);
});

blocklist.init();
server.listen(PORT, () => {
  console.log(`[ghost-email-guard] Listening on port ${PORT}, proxying to ${GHOST_TARGET}`);
});
