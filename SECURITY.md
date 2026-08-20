# Security

Anyone who has the room password and the URL (localhost, Cloudflare Tunnel, or Ngrok) can send prompts to a Cursor agent with read/write access to the configured workspace. Treat that as repository access.

If you put **Cloudflare Access** in front of the tunnel, teammates hit an edge login before the room screen. `BRIDGE_PASSWORD` is still required — Access does not replace it.

## Do not file a public issue with

- `BRIDGE_PASSWORD`, `BRIDGE_SESSION_SECRET`, or `CURSOR_API_KEY`
- A live public URL (`BRIDGE_PUBLIC_URL`, Ngrok, or the tunnel hostname)
- `.env` contents
- Dumps of `data/room-history.jsonl` or `data/artifacts.json`
- Tunnel IDs or `~/.cloudflared/*.json` credential files

## Reporting a problem

Describe the vector without pasting secrets. If the report needs reproduction credentials, use a private channel with the maintainer.

## Stable tunnel (`bridge.example.com`)

- Prefer **Cloudflare Tunnel + Access** for a fixed team hostname; use Ngrok only for ad-hoc sessions
- Confirm the hostname’s zone is **Active** in the same account used for `cloudflared login`
- Do not attach a **Worker Domain** to the same hostname as the tunnel — it conflicts with the CNAME. The Workers MCP cannot create Tunnel/Access and cannot reach localhost
- When the session ends: stop `./start-local.sh` (this stops `cloudflared`) and, if appropriate, revoke or disable the Access app
- Prefer HTTPS (Tunnel or Ngrok) off localhost — browsers block camera/mic on remote HTTP

## Good practice

- Strong password, distinct from the Cursor account
- Do not commit `.env`
- Limit Access policies to team emails when Access is enabled
- Revoke the Ngrok tunnel (or stop the process) when an ad-hoc session ends
