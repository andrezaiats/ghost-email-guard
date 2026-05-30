# ghost-email-guard

<p align="center">
  <img src="logo.webp" alt="ghost-email-guard logo" width="280">
</p>

A lightweight sidecar proxy that blocks disposable/temporary email signups on [Ghost](https://ghost.org).

Ghost doesn't have built-in protection against throwaway email addresses. Trolls can use services like 10minutemail.com or guerrillamail.com to create accounts and post abusive comments. **ghost-email-guard** sits between your reverse proxy and Ghost, intercepting signup requests and rejecting disposable emails before they ever reach Ghost.

## How it works

```
Reverse Proxy (Nginx, Caddy, etc.)
  ├── /members/api/send-magic-link/  →  ghost-email-guard (:2369)  →  Ghost (:2368)
  └── everything else               →  Ghost (:2368) directly
```

Only the signup endpoint is routed through the guard. All other traffic goes straight to Ghost, so if the guard goes down, your blog stays up — only new signups are affected.

When a signup request arrives, the guard:

1. Checks **rate limiting** by client IP — if the IP has exceeded the configured threshold, returns `429 Too Many Requests` immediately
2. Buffers and parses the JSON body
3. Extracts the email domain (case-insensitive)
4. Checks it against a blocklist of ~5,500 known disposable email domains
5. If disposable → returns `400` with a user-friendly error message
6. If legitimate → proxies the request to Ghost unchanged

The blocklist comes from the community-maintained [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) project. A snapshot is baked into the Docker image at build time (works offline), and the list auto-updates every 24 hours.

## Quick start

### 1. Add to your Docker Compose

```yaml
services:
  ghost-email-guard:
    build: ./ghost-email-guard
    container_name: ghost-email-guard
    restart: unless-stopped
    network_mode: host
    environment:
      - PORT=2369
      - GHOST_URL=http://127.0.0.1:2368
      - ALLOWLIST_PATH=/app/allowlist.conf
    volumes:
      - ./ghost-email-guard/allowlist.conf:/app/allowlist.conf
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:2369/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
```

### 2. Build and start

```bash
docker compose up -d --build ghost-email-guard
```

### 3. Verify it's running

```bash
curl http://localhost:2369/healthz
# {"status":"ok","blocklist":5488,"allowlist":0}
```

### 4. Route the signup endpoint through the guard

Add a location block in your reverse proxy config to route **only** `/members/api/send-magic-link/` to port 2369. Everything else should keep going directly to Ghost on port 2368.

**Nginx / Nginx Proxy Manager (Advanced tab):**

```nginx
location /members/api/send-magic-link/ {
    proxy_pass http://YOUR_HOST_IP:2369;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

> **Note:** If your reverse proxy runs inside a Docker container (like Nginx Proxy Manager), use the host machine's actual IP address, not `127.0.0.1`. From inside a container, `127.0.0.1` refers to the container itself.

**Caddy:**

```
aipster.com {
    handle /members/api/send-magic-link/* {
        reverse_proxy YOUR_HOST_IP:2369
    }
    handle {
        reverse_proxy localhost:2368
    }
}
```

## Configuration

All settings are via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `2369` | Port the guard listens on |
| `GHOST_URL` | `http://127.0.0.1:2368` | Ghost upstream URL |
| `ALLOWLIST_PATH` | `/app/allowlist.conf` | Path to the allowlist file |
| `UPDATE_INTERVAL_HOURS` | `24` | Hours between blocklist updates |
| `BLOCK_MESSAGE` | `Disposable email addresses are not allowed. Please use a permanent email.` | Error message shown to blocked users |
| `RATE_LIMIT_MAX` | `5` | Maximum signup requests per IP per window |
| `RATE_LIMIT_WINDOW_MINUTES` | `60` | Time window in minutes for rate limiting |
| `RATE_LIMIT_MESSAGE` | `Too many signup attempts. Please try again later.` | Error message shown to rate-limited users |

## Allowlist

If a legitimate domain gets caught by the blocklist, add it to `allowlist.conf` (one domain per line):

```
mycompany.com
university.edu
```

The allowlist is reloaded automatically every update cycle, or you can restart the container:

```bash
docker restart ghost-email-guard
```

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/healthz` | GET | Health check — returns blocklist/allowlist/ratelimit stats |
| `/members/api/send-magic-link/` | POST | Intercepted: rate limit → validate email → block or proxy |
| `*` | any | Transparent proxy to Ghost |

## Testing

```bash
# Should be blocked — disposable email (400)
curl -s -w "\n%{http_code}\n" -X POST http://localhost:2369/members/api/send-magic-link/ \
  -H 'Content-Type: application/json' \
  -d '{"email":"troll@10minutemail.com","emailType":"signup"}'

# Should pass through to Ghost
curl -s -w "\n%{http_code}\n" -X POST http://localhost:2369/members/api/send-magic-link/ \
  -H 'Content-Type: application/json' \
  -d '{"email":"real@gmail.com","emailType":"signup"}'

# Should be rate limited after exceeding threshold (429)
for i in $(seq 1 6); do
  echo "Request $i:"
  curl -s -w "\n%{http_code}\n" -X POST http://localhost:2369/members/api/send-magic-link/ \
    -H 'Content-Type: application/json' \
    -d '{"email":"test'$i'@gmail.com","emailType":"signup"}'
  echo "---"
done
```

## Rate limiting

The guard includes per-IP rate limiting on the signup endpoint to prevent enumeration attacks and brute-force spam. When an IP exceeds the configured threshold, subsequent requests receive a `429 Too Many Requests` response with a `Retry-After` header.

Rate limiting runs **before** email validation, so an attacker flooding the endpoint gets cut off without the guard even reading the request body.

The rate limiter uses a fixed window strategy with automatic cleanup of expired entries every 5 minutes. It reads the client IP from `X-Forwarded-For` (first entry) or `X-Real-IP` headers, falling back to the socket address.

## How the blocklist stays fresh

1. At **build time**, the Dockerfile downloads the latest snapshot from [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) and bakes it into the image
2. At **startup**, the snapshot is loaded immediately (works even if GitHub is down)
3. Every **24 hours** (configurable), it downloads the latest version in the background; if the download fails, the current list is kept
4. The in-memory swap is atomic — no window where the list is empty

To force an update, rebuild the image:

```bash
docker compose up -d --build ghost-email-guard
```

## License

MIT
