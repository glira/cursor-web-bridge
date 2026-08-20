const dictionaries = {
  en: {
    "login.title": "Cursor Bridge — Login",
    "login.lead": "Join the shared room with your name and the team password.",
    "login.name": "Your name",
    "login.namePlaceholder": "e.g. Ana",
    "login.password": "Password",
    "login.submit": "Enter room",
    "login.failed": "Login failed",
    "chat.title": "Cursor Bridge — Room",
    "chat.sharedRoom": "Shared room",
    "chat.meRoom": "{name} · shared room",
    "chat.presenceTitle": "Who is online",
    "chat.logout": "Log out",
    "chat.liveAria": "Live audio and video",
    "chat.liveHint": "Audio and video in the room — no Google Meet.",
    "chat.liveJoin": "Join live",
    "chat.liveLeave": "Leave",
    "chat.agentActivity": "Agent activity",
    "chat.composerPlaceholder":
      "Write a message… (Shift+Enter for a new line). Typing is mirrored live in the room.",
    "chat.attach": "Attach",
    "chat.send": "Send",
    "live.micOn": "Mic on",
    "live.micOff": "Mic off",
    "live.camOn": "Cam on",
    "live.camOff": "Cam off",
    "live.onlyYou": "Only you in live.",
    "live.nobody": "Nobody in live yet.",
    "live.with": "In live: {names}",
    "live.joinFailed": "Could not join live",
    "live.failed": "Failed",
    "live.askingMedia": "Asking for camera/mic…",
    "live.inLive": "In live",
    "live.you": "{name} (you)",
    "live.youFallback": "You",
    "meta.user": "User",
    "meta.agent": "Agent",
    "meta.by": "by {name}",
    "meta.started": "started {time}",
    "meta.awaiting": "waiting for the final reply…",
    "meta.running": "running…",
    "meta.timeout": "timeout (partial — it may still be running in Cursor)",
    "dl.file": "Download {name}",
    "dl.dir": "Download {name}.zip",
    "ui.turn": "Turn {duration}",
    "ui.replyingBy": "Replying… ({name})",
    "ui.replying": "Replying…",
    "ui.offline": "offline",
    "ui.online": "online: {names}",
    "ui.typing": "{name} is typing…",
    "ui.emptyRoom": "Shared room is ready. Typing, activity, and downloads stay in the chat.",
    "ui.roomError": "Room error",
    "ui.sendFailed": "Could not send",
  },
  pt: {
    "login.title": "Cursor Bridge — Login",
    "login.lead": "Entre na sala compartilhada com seu nome e a senha do time.",
    "login.name": "Seu nome",
    "login.namePlaceholder": "Ex.: Ana",
    "login.password": "Senha",
    "login.submit": "Entrar na sala",
    "login.failed": "Falha no login",
    "chat.title": "Cursor Bridge — Sala",
    "chat.sharedRoom": "Sala compartilhada",
    "chat.meRoom": "{name} · sala compartilhada",
    "chat.presenceTitle": "Quem está online",
    "chat.logout": "Sair",
    "chat.liveAria": "Live áudio e vídeo",
    "chat.liveHint": "Áudio e vídeo na sala — sem Google Meet.",
    "chat.liveJoin": "Entrar no live",
    "chat.liveLeave": "Sair",
    "chat.agentActivity": "Atividade do agente",
    "chat.composerPlaceholder":
      "Escreva sua mensagem… (Shift+Enter para nova linha). Digitação espelhada ao vivo na sala.",
    "chat.attach": "Anexar",
    "chat.send": "Enviar",
    "live.micOn": "Mic on",
    "live.micOff": "Mic off",
    "live.camOn": "Câm on",
    "live.camOff": "Câm off",
    "live.onlyYou": "Só você no live.",
    "live.nobody": "Ninguém no live ainda.",
    "live.with": "No live: {names}",
    "live.joinFailed": "Falha ao entrar no live",
    "live.failed": "Falhou",
    "live.askingMedia": "Pedindo câmera/mic…",
    "live.inLive": "No live",
    "live.you": "{name} (você)",
    "live.youFallback": "Você",
    "meta.user": "Usuário",
    "meta.agent": "Agente",
    "meta.by": "por {name}",
    "meta.started": "iniciado {time}",
    "meta.awaiting": "aguardando resposta final…",
    "meta.running": "em execução…",
    "meta.timeout": "timeout (parcial — ainda pode estar rodando no Cursor)",
    "dl.file": "Baixar {name}",
    "dl.dir": "Baixar {name}.zip",
    "ui.turn": "Turno {duration}",
    "ui.replyingBy": "Respondendo… ({name})",
    "ui.replying": "Respondendo…",
    "ui.offline": "offline",
    "ui.online": "online: {names}",
    "ui.typing": "{name} está digitando…",
    "ui.emptyRoom": "Sala compartilhada pronta. Digitação, atividade e downloads no fluxo do chat.",
    "ui.roomError": "Erro na sala",
    "ui.sendFailed": "Falha ao enviar",
  },
};

function detectLocale() {
  const langs = navigator.languages?.length
    ? navigator.languages
    : [navigator.language || "en"];
  for (const lang of langs) {
    const base = String(lang || "").toLowerCase().split("-")[0];
    if (base === "pt") return "pt";
    if (base === "en") return "en";
  }
  return "en";
}

export const locale = detectLocale();

export function t(key, vars = {}) {
  const dict = dictionaries[locale] || dictionaries.en;
  let text = dict[key] || dictionaries.en[key] || key;
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, value);
  }
  return text;
}

export function applyI18n(root = document) {
  document.documentElement.lang = locale === "pt" ? "pt-BR" : "en";
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
  });
  root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
  });
  const titleEl = document.querySelector("title[data-i18n]");
  if (titleEl) document.title = t(titleEl.getAttribute("data-i18n"));
}
