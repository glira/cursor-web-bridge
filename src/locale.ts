import type { Context } from "hono";

export type UiLocale = "en" | "pt";

const messages: Record<UiLocale, Record<string, string>> = {
  en: {
    too_many_attempts: "Too many attempts. Wait and try again.",
    name_required: "Enter your name to join the room.",
    invalid_password: "Invalid password",
    invalid_json: "Invalid JSON",
    signal_required: "toClientId and type are required.",
    invalid_destination: "Invalid destination.",
    peer_offline: "Peer is not in live or is offline.",
    draft_too_long: "Draft is too long.",
    path_required: "path is required.",
    agent_busy_by: "Agent is busy with {name}. Wait for the turn to finish.",
    agent_busy: "A reply is already in progress. Wait for it to finish.",
    invalid_payload: "Invalid payload",
    text_or_file: "Send text and/or a file.",
    download_failed: "Download failed",
    no_file: "No file uploaded",
    upload_failed: "Upload failed",
    unknown_error: "Unknown error",
    finished: "(finished: {status})",
    error_wrap: "(error: {message})",
    unauthenticated: "Not authenticated",
    image_only: "(image)",
    attachments_prefix: "[attachments: {names}]",
    history_clear_failed: "Could not clear history",
    history_id_required: "Message id is required.",
    history_message_missing: "Message not found.",
    history_message_in_progress: "Cannot delete a reply that is still running.",
    history_delete_failed: "Could not delete the message",
    history_before_invalid: "Cannot load older messages from that point.",
    no_pending_decision: "There is no decision waiting in Cursor.",
    decision_already: "Someone already chose an option.",
    unknown_decision_option: "That option is not on the current card.",
    decision_click_failed: "Could not click the option in Cursor.",
    decision_sdk_unsupported:
      "Team decisions are only available in CDP mode. SDK mode auto-runs tools.",
    invalid_login: "Invalid username or password",
    forbidden: "You do not have permission to do that.",
    room_unknown: "That tab does not exist.",
    room_not_ready: "That tab is not ready yet.",
    room_fixed: "The general tab cannot be removed.",
    user_exists: "That username is already in use.",
    user_invalid: "Invalid username.",
    user_missing: "User not found.",
    password_short: "Password must be at least 8 characters.",
    cannot_delete_self: "You cannot delete your own user.",
    cannot_delete_last_admin: "The last admin cannot be deleted.",
    workspace_blocked: "Not enough disk or memory for another tab.",
    workspace_warn: "Resources are tight. Confirm to create the tab anyway.",
    workspace_dirty: "The tab has uncommitted changes.",
    workspace_title_invalid: "Invalid tab name.",
    workspace_path: "Could not choose a folder for that tab.",
    workspace_failed: "Could not create the tab.",
    opening_window: "Opening window…",
    disk_full: "The server is out of disk space.",
  },
  pt: {
    too_many_attempts: "Muitas tentativas. Aguarde e tente de novo.",
    name_required: "Informe seu nome para entrar na sala.",
    invalid_password: "Senha inválida",
    invalid_json: "JSON inválido",
    signal_required: "toClientId e type são obrigatórios.",
    invalid_destination: "Destino inválido.",
    peer_offline: "Peer fora do live ou offline.",
    draft_too_long: "Rascunho muito longo.",
    path_required: "Parâmetro path é obrigatório.",
    agent_busy_by: "Agente ocupado por {name}. Aguarde terminar.",
    agent_busy: "Já existe uma resposta em andamento. Aguarde terminar.",
    invalid_payload: "Payload inválido",
    text_or_file: "Envie texto e/ou arquivo.",
    download_failed: "Falha no download",
    no_file: "Nenhum arquivo enviado",
    upload_failed: "Falha no upload",
    unknown_error: "Erro desconhecido",
    finished: "(concluído: {status})",
    error_wrap: "(erro: {message})",
    unauthenticated: "Não autenticado",
    image_only: "(imagem)",
    attachments_prefix: "[anexos: {names}]",
    history_clear_failed: "Não foi possível limpar o histórico",
    history_id_required: "O id da mensagem é obrigatório.",
    history_message_missing: "Mensagem não encontrada.",
    history_message_in_progress: "Não é possível apagar uma resposta ainda em execução.",
    history_delete_failed: "Não foi possível apagar a mensagem",
    history_before_invalid: "Não é possível carregar mensagens anteriores a partir desse ponto.",
    no_pending_decision: "Não há decisão aguardando no Cursor.",
    decision_already: "Alguém já escolheu uma opção.",
    unknown_decision_option: "Essa opção não está no cartão atual.",
    decision_click_failed: "Não foi possível clicar na opção no Cursor.",
    decision_sdk_unsupported:
      "Decisões do time só existem no modo CDP. O modo SDK executa as ferramentas sozinho.",
    invalid_login: "Usuário ou senha inválidos",
    forbidden: "Você não tem permissão para isso.",
    room_unknown: "Essa aba não existe.",
    room_not_ready: "Essa aba ainda não está pronta.",
    room_fixed: "A aba Geral não pode ser removida.",
    user_exists: "Esse usuário já existe.",
    user_invalid: "Usuário inválido.",
    user_missing: "Usuário não encontrado.",
    password_short: "A senha precisa ter pelo menos 8 caracteres.",
    cannot_delete_self: "Você não pode apagar o próprio usuário.",
    cannot_delete_last_admin: "O último admin não pode ser apagado.",
    workspace_blocked: "Sem disco ou memória para mais uma aba.",
    workspace_warn: "Os recursos estão apertados. Confirme para criar mesmo assim.",
    workspace_dirty: "A aba tem alterações sem commit.",
    workspace_title_invalid: "Nome de aba inválido.",
    workspace_path: "Não foi possível escolher a pasta dessa aba.",
    workspace_failed: "Não foi possível criar a aba.",
    opening_window: "abrindo janela…",
    disk_full: "servidor sem espaço em disco",
  },
};

export function requestLocale(header: string | undefined): UiLocale {
  const parts = (header || "")
    .split(",")
    .map((raw) => {
      const [tag, ...params] = raw.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number(qParam.split("=")[1]) : 1;
      return { tag: (tag || "en").toLowerCase(), q: Number.isFinite(q) ? q : 1 };
    })
    .sort((a, b) => b.q - a.q);

  for (const part of parts) {
    if (part.tag.startsWith("pt")) return "pt";
    if (part.tag.startsWith("en")) return "en";
  }
  return "en";
}

export function localeFromContext(c: Context): UiLocale {
  return requestLocale(c.req.header("accept-language"));
}

export function tApi(
  locale: UiLocale,
  key: string,
  vars: Record<string, string> = {},
): string {
  let text = messages[locale][key] || messages.en[key] || key;
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, value);
  }
  return text;
}

export function apiError(
  c: Context,
  key: string,
  status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 507,
  vars: Record<string, string> = {},
) {
  return c.json({ error: tApi(localeFromContext(c), key, vars) }, status);
}
