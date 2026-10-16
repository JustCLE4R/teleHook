# Connecting your servers

How to get alerts from your own servers into Telegram through teleHook. There are two parts:

- **A. Run teleHook** somewhere your servers can reach (skip this if it already runs, e.g. at `https://telehook.yudistira.dev`).
- **B. Install `telehook-watch` on each server you want to monitor.** It checks the server every minute and, when something breaks, posts an alert with diagnostics attached to teleHook.

```text
your server ──(telehook-watch: checks every minute)──► teleHook API ──► Telegram Bot API ──► your chats
             POST /api/send (multipart, diagnostics attached)
```

Files in this repository:

| File                                               | Purpose                                                 |
| -------------------------------------------------- | ------------------------------------------------------- |
| `scripts/telehook-watch.sh`                        | The watcher, plus a `send` command for your own scripts |
| `scripts/telehook-watch.conf.example`              | Its settings, installed as `/etc/telehook-watch.conf`   |
| `scripts/systemd/telehook-watch.service`, `.timer` | Runs the watcher every minute                           |
| `scripts/systemd/telehook.service`                 | Runs the teleHook API itself (part A)                   |

---

## A. Run teleHook on a server

Requirements: Node.js 20.19+, 22.12+ or 24+, outbound HTTPS to `api.telegram.org`.

```bash
sudo useradd --system --home /opt/telehook --shell /usr/sbin/nologin telehook
sudo git clone <your repo URL> /opt/telehook
cd /opt/telehook
sudo npm ci && sudo npm run build
sudo cp .env.example .env && sudo nano .env      # set TELEGRAM_BOT_TOKEN, PORT, limits
sudo mkdir -p logs && sudo chown -R telehook: /opt/telehook/logs
sudo chmod 600 .env && sudo chown telehook: .env

sudo cp scripts/systemd/telehook.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now telehook
systemctl status telehook
curl -sS http://127.0.0.1:3000/api/send -F chat_ids=<your chat id> -F "message=teleHook is up"
```

**Exposure.** teleHook has no authentication (see [security.md](security.md)). Choose one of these setups:

- **Private only:** firewall the port so only your servers can reach it (e.g. `ufw allow from 10.0.0.0/8 to any port 3000`), or reach it over a VPN or WireGuard.
- **Through a reverse proxy with TLS and auth:** for a public hostname like `telehook.yudistira.dev`, **always** require authentication at the proxy. Example nginx:

  ```nginx
  server {
      server_name telehook.example.com;
      # listen 443 ssl; ssl_certificate …; (e.g. via certbot)
      client_max_body_size 60m;            # ≥ MAX_ATTACHMENTS_PER_REQUEST × MAX_ATTACHMENT_SIZE_MB
      proxy_read_timeout 300s;             # teleHook may retry Telegram for a while
      location /api/ {
          auth_basic "teleHook";
          auth_basic_user_file /etc/nginx/telehook.htpasswd;   # htpasswd -c … alerts
          proxy_pass http://127.0.0.1:3000;
          proxy_set_header Host $host;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      }
  }
  ```

  Behind a proxy, every client shares the proxy's IP for the rate limit (10 requests/minute by default). Raise `RATE_LIMIT_MAX_REQUESTS`, or enable Express `trust proxy` in `src/main.ts` (see [security.md](security.md#rate-limiting)).

---

## B. Install `telehook-watch` on a monitored server

Requirements: Linux with bash 4.4+, curl 7.52+, coreutils, procps, and systemd (or cron). Optional: `flock` (prevents overlapping runs), `logger` (writes to syslog/journal).

### 1. Copy the files

From your machine with this repository:

```bash
scp scripts/telehook-watch.sh scripts/telehook-watch.conf.example \
    scripts/systemd/telehook-watch.service scripts/systemd/telehook-watch.timer \
    user@your-server:/tmp/
```

On the server:

```bash
sudo install -m 755 /tmp/telehook-watch.sh /usr/local/bin/telehook-watch.sh
sudo install -m 600 /tmp/telehook-watch.conf.example /etc/telehook-watch.conf
sudo nano /etc/telehook-watch.conf
```

If the repository was cloned on Windows, make sure the script has LF line endings (`sed -i 's/\r$//' /usr/local/bin/telehook-watch.sh`), or bash will fail with `$'\r': command not found`.

### 2. Configure

The minimum settings:

```bash
TELEHOOK_URL="https://telehook.example.com/api/send"     # or http://127.0.0.1:3000/api/send on the same host
TELEHOOK_CHAT_IDS="5064323191,-5441480508"
TELEHOOK_HEADER="Authorization: Basic $(printf 'alerts:password' | base64)"   # only behind an auth proxy
```

Then pick the checks:

| Setting                     | Default | Alerts when                                                                                                                              |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DISK_MAX_PERCENT`          | `90`    | Any filesystem is at least this full (tmpfs, overlay, snap and similar are skipped; `DISK_EXCLUDE` is a regex of mount points to ignore) |
| `MEM_MIN_AVAILABLE_PERCENT` | `10`    | `MemAvailable` drops below this share of RAM                                                                                             |
| `LOAD_MAX_PER_CPU`          | `2.0`   | The 5-minute load average divided by the CPU count exceeds this                                                                          |
| `SERVICES`                  | empty   | A listed systemd unit is not `active` (e.g. `"nginx docker postgresql"`)                                                                 |
| `URLS`                      | empty   | A listed URL does not answer 2xx/3xx within `URL_TIMEOUT` seconds (redirects are followed)                                               |

And what gets attached:

| Setting          | Default | Meaning                                                                                      |
| ---------------- | ------- | -------------------------------------------------------------------------------------------- |
| `LOG_FILES`      | empty   | The last `LOG_LINES` (200) lines of each readable file are attached                          |
| `MAX_FILES`      | `5`     | Keep ≤ the server's `MAX_ATTACHMENTS_PER_REQUEST`                                            |
| `MAX_FILE_BYTES` | 9 MiB   | Larger files are cut to their last N bytes; keep below the server's `MAX_ATTACHMENT_SIZE_MB` |

Alert behaviour: `REPEAT_MINUTES` (60) re-alerts about a problem that lasts, `NOTIFY_RESOLVED` (1) sends a "resolved" message when it clears, and `STATE_DIR` (`/var/lib/telehook-watch`) remembers what was reported.

### 3. Test

```bash
sudo telehook-watch.sh test
```

You should receive "🧪 Test alert from <host>" with `diagnostics.txt` attached, and see teleHook's JSON response. To see a real alert, temporarily set `DISK_MAX_PERCENT=1` and run `sudo telehook-watch.sh check`.

### 4. Schedule

With systemd:

```bash
sudo install -m 644 /tmp/telehook-watch.service /tmp/telehook-watch.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now telehook-watch.timer
systemctl list-timers telehook-watch.timer       # next run
journalctl -t telehook-watch -f                  # what it did
```

Or with cron (`sudo crontab -e`):

```cron
* * * * * /usr/local/bin/telehook-watch.sh check
```

## What an alert looks like

One message per run, listing every current problem, with the diagnostics as files replying to it (silently):

```text
🔥 web-1: 2 problem(s)
• Disk / is 93% full (limit 90%)
• Service nginx is failed
   ↳ diagnostics.txt        uptime, load, memory, disks, top CPU/memory processes, failed units, kernel messages
   ↳ nginx.journal.txt      last 200 journal lines of the failed service
   ↳ error.log              last 200 lines of each LOG_FILES entry
```

- A problem alerts when it first appears, then again every `REPEAT_MINUTES` while it lasts. Runs in between stay quiet.
- When it clears: `✅ web-1: 1 problem(s) resolved` / `• was: Disk / is 93% full (limit 90%)`.
- With a single attachment, teleHook sends one post with the alert as its caption (see [delivery.md](delivery.md)).

## Reliability built in

- **teleHook unreachable:** curl retries 3 times, 5 seconds apart (`--retry-connrefused`). teleHook itself retries Telegram for up to about 47 s, so the script waits up to `SEND_TIMEOUT` (180 s).
- **Files rejected** (400/413, e.g. limits lower on the server than in the script): the alert is re-sent as text only, so it is not lost.
- **Failed delivery:** the problem is not marked as reported, so the next run tries again.
- Empty files are never attached (teleHook would reject the whole request).
- The message is sent from a file, so emoji and text starting with `@` arrive unchanged.
- Each request carries `X-Request-Id: telehook-watch-<host>-<time>`, which you can find in teleHook's error log.
- Overlapping runs are prevented with `flock`.

## Use it from your own scripts

The `send` command delivers any message with files, using the same settings and fallbacks:

```bash
# After a backup
if ! /usr/local/bin/backup.sh > /tmp/backup.log 2>&1; then
    telehook-watch.sh send "❌ Backup failed on $(hostname)" /tmp/backup.log
fi

# After a deploy
telehook-watch.sh send "🚀 Deployed $(git rev-parse --short HEAD) to $(hostname)"

# Wrap any cron job: alert with its output when it fails
out=$(mktemp); /usr/local/bin/nightly-job > "$out" 2>&1 || telehook-watch.sh send "nightly-job failed on $(hostname)" "$out"; rm -f "$out"
```

A config file other than `/etc/telehook-watch.conf` can be used with `TELEHOOK_WATCH_CONF=/path/to.conf telehook-watch.sh …`. Settings in the config file override environment variables.

## Without the script

Any tool that can send HTTP can post directly. See [api-reference.md](api-reference.md#examples):

```bash
curl -sS https://telehook.example.com/api/send -u alerts:password \
  -F "chat_ids=5064323191" --form-string "message=Disk full on $(hostname)" -F files=@/tmp/df.txt
```

## Troubleshooting

| Symptom                                          | Check                                                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEHOOK_URL and TELEHOOK_CHAT_IDS must be set` | `/etc/telehook-watch.conf` exists and is readable by the user running the script                                                                                 |
| `alert not accepted by teleHook (HTTP 000)`      | The server cannot reach `TELEHOOK_URL` (firewall, DNS, TLS); the curl error follows in the log                                                                   |
| `HTTP 401`                                       | Proxy authentication: check `TELEHOOK_HEADER`                                                                                                                    |
| `HTTP 403 Cross-site requests…`                  | Something adds an `Origin` header; plain curl doesn't                                                                                                            |
| `HTTP 429`                                       | teleHook's rate limit; behind a proxy all servers share one IP (see part A)                                                                                      |
| `HTTP 207` with per-chat errors                  | Delivery to some chats failed: wrong chat ID, bot blocked or not in the group; see [error-catalog.md](error-catalog.md#4-per-chat-error-in-dataresults-http-207) |
| Alert repeats every minute                       | `STATE_DIR` is not writable, so nothing is remembered                                                                                                            |
| Never alerts                                     | Run `sudo telehook-watch.sh check` by hand with a low threshold; check `journalctl -t telehook-watch`                                                            |
| `$'\r': command not found`                       | Windows line endings: `sed -i 's/\r$//' /usr/local/bin/telehook-watch.sh`                                                                                        |
