/**
 * Browser-side helpers injected via CDP Runtime.evaluate.
 * No template interpolation — keep this a plain string.
 *
 * Scoped to the Agent pane so an open plan/doc mentioning
 * "Waiting for Approval" does not count as a live card.
 */
export const DECISION_HELPERS_JS = `
function decisionNorm(s) {
  return String(s || "").replace(/\\s+/g, " ").trim();
}

function decisionSlug(s) {
  var slug = decisionNorm(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 32) || "x";
}

function decisionAgentRoot() {
  return (
    document.getElementById("workbench.parts.auxiliarybar") ||
    document.querySelector(".composer-bar") ||
    document.querySelector(".composer-messages-container") ||
    null
  );
}

function decisionInChrome(el) {
  if (!el || !el.closest) return true;
  return !!(
    el.closest(".statusbar") ||
    el.closest("#workbench.parts.statusbar") ||
    el.closest(".composer-tab-label") ||
    el.closest("#composer-toolbar-section") ||
    el.closest(".part.statusbar")
  );
}

function decisionInInputBox(el) {
  if (!el || !el.closest) return false;
  return !!(
    el.closest(".ai-input-full-input-box") ||
    el.closest(".composer-input-blur-wrapper")
  );
}

function decisionLabelOf(el) {
  if (!el) return "";
  var aria = el.getAttribute && el.getAttribute("aria-label");
  var text = el.innerText || el.textContent || "";
  if (el.labels && el.labels[0]) {
    text = el.labels[0].innerText || text;
  }
  return decisionNorm(aria || text);
}

function decisionClickables(root) {
  return Array.prototype.slice.call(
    root.querySelectorAll("button, [role=button], [role=radio], input[type=radio], a.monaco-button")
  );
}

function decisionIsApprovalLabel(label) {
  if (!label || label.length > 56) return false;
  if (/accepted out of|acceptance rate|shell command|stop command|show full|plan progress|extra high/i.test(label)) {
    return false;
  }
  return /^(Allow(?: and remember)?|Allowlist|Add to allowlist|Always(?: allow)?|Once|Allow once|Run(?: command)?|Skip|Reject|Deny|Permitir(?: e lembrar)?|Lista de permiss(?:ões|oes)?|Adicionar à lista|Executar|Recusar|Pular|Sempre(?: permitir)?|Uma vez)(?:\\b|[.…]*$)/i.test(label);
}

function decisionIsWaitingText(text) {
  return /Waiting for Approval|Aguardando aprova/i.test(text);
}

function decisionCleanPrompt(text, labels) {
  var t = String(text || "");
  t = t.replace(/Waiting for Approval[.…\\s]*/gi, " ");
  t = t.replace(/Aguardando aprova[^\\n]*/gi, " ");
  for (var i = 0; i < labels.length; i++) {
    if (labels[i]) t = t.split(labels[i]).join(" ");
  }
  return decisionNorm(t).slice(0, 280);
}

function decisionOptionId(index, label) {
  return "opt-" + index + "-" + decisionSlug(label);
}

function decisionFindWaitingEl(root) {
  var nodes = root.querySelectorAll("div, span, p, h1, h2, h3, h4");
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (decisionInChrome(el) || decisionInInputBox(el)) continue;
    var own = "";
    try {
      own = decisionNorm(el.childNodes && el.childNodes.length === 1 ? (el.innerText || "") : "");
      if (!own) {
        var direct = "";
        for (var c = 0; c < el.childNodes.length; c++) {
          if (el.childNodes[c].nodeType === 3) direct += el.childNodes[c].textContent || "";
        }
        own = decisionNorm(direct);
      }
    } catch (e) {
      own = "";
    }
    if (own && own.length < 80 && decisionIsWaitingText(own)) return el;
  }
  var all = decisionNorm(root.innerText || "").split("\\n");
  for (var j = 0; j < all.length; j++) {
    if (all[j].length < 80 && decisionIsWaitingText(all[j])) return root;
  }
  return null;
}

function decisionCollectApproval(root) {
  var buttons = decisionClickables(root).filter(function (el) {
    return !decisionInChrome(el) && !decisionInInputBox(el);
  });
  var hits = [];
  var seen = {};
  for (var i = 0; i < buttons.length; i++) {
    var label = decisionLabelOf(buttons[i]);
    if (!decisionIsApprovalLabel(label)) continue;
    var key = label.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    hits.push({ el: buttons[i], label: label });
  }
  var waitingEl = decisionFindWaitingEl(root);
  if (hits.length === 0) return null;
  if (hits.length === 1 && !waitingEl) return null;

  var labels = hits.map(function (h) { return h.label; });
  var prompt = "";
  var anchor = waitingEl || hits[0].el;
  var card = null;
  if (anchor && anchor.closest) {
    card = anchor.closest("[class*='tool-call'], [class*='approval'], [class*='permission'], [class*='composer-rendered-message']");
  }
  if (card) prompt = decisionNorm(card.innerText).slice(0, 400);
  if (!prompt) {
    var shells = root.querySelectorAll(".ui-shell-tool-call");
    if (shells.length) prompt = decisionNorm(shells[shells.length - 1].innerText).slice(0, 400);
  }
  if (!prompt && waitingEl && waitingEl.parentElement) {
    prompt = decisionNorm(waitingEl.parentElement.innerText).slice(0, 400);
  }

  return {
    kind: "approval",
    prompt: decisionCleanPrompt(prompt, labels),
    options: hits.map(function (h, idx) {
      return { id: decisionOptionId(idx, h.label), label: h.label };
    }),
  };
}

function decisionPromptFrom(el) {
  if (!el) return "";
  var msg = el.closest && el.closest("[data-message-role], .composer-rendered-message");
  var text = decisionNorm((msg || el).innerText || "");
  var lines = text.split("\\n").map(function (l) { return l.trim(); }).filter(Boolean);
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf("?") !== -1 && lines[i].length < 240) return lines[i];
  }
  return text.slice(0, 280);
}

function decisionCollectQuestion(root) {
  var transcript = root.querySelector(".composer-messages-container") || root;
  var groups = Array.prototype.slice.call(transcript.querySelectorAll("[role=radiogroup]"));
  var radios = [];
  var host = null;
  if (groups.length) {
    host = groups[groups.length - 1];
    if (decisionInChrome(host) || decisionInInputBox(host)) host = null;
    if (host) {
      radios = Array.prototype.slice.call(host.querySelectorAll("[role=radio], input[type=radio]"));
    }
  }
  if (!host) {
    radios = Array.prototype.slice.call(transcript.querySelectorAll("[role=radio], input[type=radio]")).filter(function (el) {
      return !decisionInChrome(el) && !decisionInInputBox(el);
    });
    if (radios.length >= 2) host = radios[0].parentElement;
  }
  if (!host || radios.length < 2) return null;

  var options = [];
  var seen = {};
  for (var i = 0; i < radios.length; i++) {
    var label = decisionLabelOf(radios[i]);
    if (!label || label.length > 160) continue;
    var key = label.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    options.push({ id: decisionOptionId(options.length, label), label: label });
  }
  if (options.length < 2) return null;

  return {
    kind: "question",
    prompt: decisionPromptFrom(host),
    options: options,
  };
}

function collectPendingDecision() {
  var root = decisionAgentRoot();
  if (!root) return null;
  return decisionCollectApproval(root) || decisionCollectQuestion(root);
}

function decisionFindByLabel(root, label) {
  var want = decisionNorm(label).toLowerCase();
  if (!want) return null;
  var els = decisionClickables(root);
  for (var i = 0; i < els.length; i++) {
    if (decisionInChrome(els[i])) continue;
    if (decisionLabelOf(els[i]).toLowerCase() === want) return els[i];
  }
  return null;
}

function decisionFindSubmit(root) {
  var els = decisionClickables(root);
  for (var i = 0; i < els.length; i++) {
    if (decisionInChrome(els[i]) || decisionInInputBox(els[i])) continue;
    var label = decisionLabelOf(els[i]);
    if (/^(Submit|Continue|Confirm|Enviar|Continuar|Confirmar)$/i.test(label)) return els[i];
  }
  return null;
}

function clickPendingOption(optionId) {
  var pending = collectPendingDecision();
  if (!pending) return { ok: false, error: "no-card" };
  var opt = null;
  for (var i = 0; i < pending.options.length; i++) {
    if (pending.options[i].id === optionId) {
      opt = pending.options[i];
      break;
    }
  }
  if (!opt) return { ok: false, error: "unknown-option" };
  var root = decisionAgentRoot();
  if (!root) return { ok: false, error: "no-root" };
  var el = decisionFindByLabel(root, opt.label);
  if (!el) return { ok: false, error: "not-found" };
  try {
    el.scrollIntoView({ block: "center", behavior: "instant" });
  } catch (e) {}
  el.click();
  if (pending.kind === "question") {
    var submit = decisionFindSubmit(root);
    if (submit && submit !== el) submit.click();
  }
  return { ok: true, label: opt.label };
}
`;

export type ClickDecisionResult = {
  ok: boolean;
  error?: string;
  label?: string;
};
