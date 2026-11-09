# Swap backend

A Node server that converts files and limits each visitor to 10 free conversions per day. It also serves the web page in `public/`.

## Run with Docker (easiest)

```bash
docker build -t swap .
docker run -p 3000:3000 -v swap-data:/data -e IP_SALT=$(openssl rand -hex 16) swap
```

Open http://localhost:3000.

## Run without Docker

You need Node 20+, plus `ffmpeg` and `libreoffice` on your PATH.

```bash
npm install
npm start
```

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DAILY_LIMIT` | 10 | Free conversions per visitor per day (UTC) |
| `MAX_MB` | 50 | Largest upload |
| `MAX_JOBS` | 2 | Conversions running at once |
| `TIMEOUT_MS` | 120000 | Time limit per conversion |
| `IP_SALT` | change-me | Secret used to hash IPs. Set your own. |
| `TRUST_PROXY` | 0 | Set to 1 behind one reverse proxy (Nginx, Caddy, most hosts), or every visitor will look like the same IP |
| `DB_PATH` | ./usage.db | Where the daily counts are stored |

## API

- `GET /api/formats` lists supported conversions.
- `GET /api/usage` returns `{limit, used, left}` for the caller.
- `POST /api/convert` takes multipart fields `file` and `target` (such as `pdf`) and returns the converted file. A `429` means the daily limit is reached.

## Notes

- Put it behind HTTPS (Caddy, Nginx or your host's proxy).
- Failed conversions don't count toward the limit.
- Uploads and outputs are deleted right after each request.
- The limit is per IP address, so a VPN gets around it. For strict limits, add user accounts and key the counter on the user ID instead of the IP.
