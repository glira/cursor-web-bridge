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
  status: 400 | 401 | 404 | 409 | 429 | 500,
  vars: Record<string, string> = {},
) {
  return c.json({ error: tApi(localeFromContext(c), key, vars) }, status);
}
