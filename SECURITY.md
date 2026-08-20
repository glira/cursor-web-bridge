# Segurança

Quem tiver a senha da sala e a URL (local, Cloudflare Tunnel ou Ngrok) pode enviar prompts a um agente Cursor com acesso de leitura/escrita ao workspace configurado. Trate isso como acesso ao repositório.

Com Tunnel + **Cloudflare Access**, o time passa por um gate na borda (e-mail) antes da tela de login da sala. A senha `BRIDGE_PASSWORD` continua obrigatória — Access não a substitui.

## Não abra issue pública com

- `BRIDGE_PASSWORD`, `BRIDGE_SESSION_SECRET` ou `CURSOR_API_KEY`
- URL pública em uso (`BRIDGE_PUBLIC_URL`, Ngrok, ou hostname do Tunnel)
- conteúdo de `.env`
- dumps de `data/room-history.jsonl` ou `data/artifacts.json`
- IDs de túnel / arquivos de credenciais `~/.cloudflared/*.json`

## Reportar um problema

Descreva o vetor sem colar segredos. Se o relato exigir credenciais de reprodução, use um canal privado com o maintainer.

## Tunnel estável (`bridge.example.com`)

- Preferir **Cloudflare Tunnel + Access** para URL fixa do time; Ngrok só para sessão ad-hoc
- Confirmar no dashboard que a zona do hostname está **Active** na mesma conta do `cloudflared login`
- Não anexar **Worker Domain** no mesmo hostname do túnel — conflita com o CNAME. O MCP Workers da conta não cria Tunnel/Access e não alcança localhost
- Ao fim da sessão: parar `./start-local.sh` (encerra `cloudflared`) e, se apropriado, revogar/desativar a app Access
- Preferir HTTPS (Tunnel ou Ngrok) fora de localhost — o browser bloqueia câmera/mic em HTTP remoto

## Boas práticas

- Senha forte e distinta da conta Cursor
- Não commitar `.env`
- Limitar a política Access aos e-mails do time
- Revogar o túnel Ngrok (ou parar o processo) quando a sessão ad-hoc acabar
