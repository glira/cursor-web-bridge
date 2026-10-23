# Security

Anyone who can sign in, and who has the URL (localhost, Cloudflare Tunnel, or Ngrok), can send prompts on every tab. Each tab can read and write its workspace: Geral is `CURSOR_CWD`, and extra tabs are git worktrees. Treat an account as access to those checkouts.

Sign-in is a username and password stored as a scrypt hash in `data/users.json`. `BRIDGE_PASSWORD` is still required for the process to start. It is not the login password.

If you put **Cloudflare Access** in front of the tunnel, teammates hit an edge login before the room screen. Access does not replace the account login.

## Do not file a public issue with

- `BRIDGE_ADMIN_PASSWORD`, `BRIDGE_SESSION_SECRET`, `BRIDGE_PASSWORD`, or `CURSOR_API_KEY`
- A live public URL (`BRIDGE_PUBLIC_URL`, Ngrok, or the tunnel hostname)
- `.env` contents
- `data/users.json`, `data/rooms.json`, or dumps of `data/rooms/*/history.jsonl` and `artifacts.json`
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

- Distinct account passwords, not the Cursor account password. Admins create accounts in the panel; do not put real usernames or passwords in the repository
- Do not commit `.env`
- Limit Access policies to team emails when Access is enabled
- Revoke the Ngrok tunnel (or stop the process) when an ad-hoc session ends
