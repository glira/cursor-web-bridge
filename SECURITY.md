# Segurança

Quem tiver a senha da sala e a URL (local ou Ngrok) pode enviar prompts a um agente Cursor com acesso de leitura/escrita ao workspace configurado. Trate isso como acesso ao repositório.

## Não abra issue pública com

- `BRIDGE_PASSWORD`, `BRIDGE_SESSION_SECRET` ou `CURSOR_API_KEY`
- URL do Ngrok em uso
- conteúdo de `.env`
- dumps de `data/room-history.jsonl` ou `data/artifacts.json`

## Reportar um problema

Descreva o vetor sem colar segredos. Se o relato exigir credenciais de reprodução, use um canal privado com o maintainer.

## Boas práticas

- Senha forte e distinta da conta Cursor
- Não commitar `.env`
- Revogar o túnel Ngrok quando a sessão do time acabar
- Preferir HTTPS (Ngrok) fora de localhost — o browser bloqueia câmera/mic em HTTP remoto
