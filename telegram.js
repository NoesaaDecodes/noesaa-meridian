import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId   = process.env.TELEGRAM_CHAT_ID || null;
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;
const _lastNotifyAt = new Map();
const _digestItems = new Map();
let _digestTimer = null;

const PRIORITY = {
  critical: { icon: "🚨", rank: 4 },
  high: { icon: "🔴", rank: 3 },
  medium: { icon: "🟡", rank: 2 },
  low: { icon: "🟢", rank: 1 },
  info: { icon: "ℹ️", rank: 0 },
};

function telegramConfig() {
  return {
    digestMode: config.telegram?.digestMode !== false,
    verboseCycles: config.telegram?.verboseCycles === true,
    minNotifyIntervalSec: Number(config.telegram?.minNotifyIntervalSec ?? 300),
    verbosity: config.telegram?.verbosity || "normal",
  };
}

function shouldCooldown(key, priority) {
  if (!key || priority === "critical") return false;
  const minMs = Math.max(0, telegramConfig().minNotifyIntervalSec) * 1000;
  if (minMs <= 0) return false;
  const last = _lastNotifyAt.get(key);
  const now = Date.now();
  if (last && now - last < minMs) return true;
  _lastNotifyAt.set(key, now);
  return false;
}

function digestKey(event) {
  return event.key || `${event.type || "event"}:${event.title || ""}`;
}

async function flushDigestNow() {
  if (_digestTimer) clearTimeout(_digestTimer);
  _digestTimer = null;
  if (!_digestItems.size) return null;
  const items = [..._digestItems.values()];
  _digestItems.clear();
  const lines = ["🧾 <b>Operator Digest</b>"];
  for (const item of items.slice(0, 12)) {
    const meta = item.count > 1 ? ` x${item.count}` : "";
    lines.push(`${item.icon} <b>${escapeHtml(item.title)}</b>${meta}${item.text ? `\n${escapeHtml(item.text)}` : ""}`);
  }
  if (items.length > 12) lines.push(`…and ${items.length - 12} more`);
  return sendHTML(lines.join("\n\n"), { bypassDigest: true, priority: "high" });
}

function queueDigest(event) {
  const key = digestKey(event);
  const existing = _digestItems.get(key);
  if (existing) {
    existing.count += 1;
    existing.text = event.text || existing.text;
    existing.icon = event.icon || existing.icon;
  } else {
    _digestItems.set(key, { ...event, count: 1 });
  }
  if (!_digestTimer) {
    _digestTimer = setTimeout(() => {
      flushDigestNow().catch((e) => log("telegram_warn", `Digest flush failed: ${e.message}`));
    }, 60_000);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== chatId) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function postTelegram(method, body) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text, options = {}) {
  if (!TOKEN || !chatId) return;
  if (options.key && shouldCooldown(options.key, options.priority || "medium")) return null;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendMessageWithButtons(text, inlineKeyboard) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function sendHTML(html, options = {}) {
  if (!TOKEN || !chatId) return;
  if (options.key && shouldCooldown(options.key, options.priority || "medium")) return null;
  return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

export async function notifyOperator({
  type = "event",
  title,
  text = "",
  priority = "medium",
  key = null,
  digest = true,
} = {}) {
  const cfg = telegramConfig();
  const meta = PRIORITY[priority] || PRIORITY.medium;
  const event = {
    type,
    title: title || type,
    text,
    priority,
    key: key || `${type}:${title || ""}`,
    icon: meta.icon,
  };

  if (shouldCooldown(event.key, priority)) return null;

  const shouldDigest =
    cfg.digestMode &&
    digest &&
    meta.rank <= PRIORITY.medium.rank &&
    !cfg.verboseCycles;

  if (shouldDigest) {
    queueDigest(event);
    return null;
  }

  const html = `${event.icon} <b>${escapeHtml(event.title)}</b>${text ? `\n${escapeHtml(text)}` : ""}`;
  return sendHTML(html, { bypassDigest: true, priority, key: null });
}

export async function flushTelegramDigest() {
  return flushDigestNow();
}

function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...", options = {}) {
  if (!TOKEN || !chatId) return null;
  const cfg = telegramConfig();
  if (options.cycle === true && cfg.digestMode && !cfg.verboseCycles) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render() {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) {
      const sent = await sendMessage(text);
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await editMessage(text, state.messageId);
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee }) {
  if (hasActiveLiveMessage()) return;
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const coverageStr = rangeCoverage
    ? `Range cover: ${fmtPct(rangeCoverage.downside_pct)} downside | ${fmtPct(rangeCoverage.upside_pct)} upside | ${fmtPct(rangeCoverage.width_pct)} total\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
    : "";
  await notifyOperator({
    type: "deploy",
    priority: "high",
    key: `deploy:${position || pair}`,
    digest: false,
    title: `Deploy opened: ${pair}`,
    text: `Amount: ${amountSol} SOL\n${priceStr}${coverageStr}${poolStr}Position: ${position?.slice(0, 8) || "?"}...\nTx: ${tx?.slice(0, 16) || "n/a"}...`,
  });
  return;
  await sendHTML(
    `✅ <b>Deployed</b> ${pair}\n` +
    `Amount: ${amountSol} SOL\n` +
    priceStr +
    coverageStr +
    poolStr +
    `Position: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyClose({ pair, pnlUsd, pnlPct }) {
  if (hasActiveLiveMessage()) return;
  const sign = pnlUsd >= 0 ? "+" : "";
  await notifyOperator({
    type: "close",
    priority: "high",
    key: `close:${pair}:${pnlPct}`,
    digest: false,
    title: `Position closed: ${pair}`,
    text: `PnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)`,
  });
  return;
  await sendHTML(
    `🔒 <b>Closed</b> ${pair}\n` +
    `PnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)`
  );
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;
  await notifyOperator({
    type: "swap",
    priority: "medium",
    key: `swap:${inputSymbol}:${outputSymbol}`,
    title: `Swapped ${inputSymbol} to ${outputSymbol}`,
    text: `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\nTx: ${tx?.slice(0, 16) || "n/a"}...`,
    digest: true,
  });
  return;
  await sendHTML(
    `🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\n` +
    `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  if (hasActiveLiveMessage()) return;
  await notifyOperator({
    type: "oor",
    priority: "medium",
    key: `oor:${pair}`,
    title: `Out of range: ${pair}`,
    text: `Been OOR for ${minutesOOR} minutes`,
    digest: true,
  });
  return;
  await sendHTML(
    `⚠️ <b>Out of Range</b> ${pair}\n` +
    `Been OOR for ${minutesOOR} minutes`
  );
}

export async function notifyPaperDeploy({ pair, amountSol, position, balanceSol }) {
  await notifyOperator({
    type: "paper_deploy",
    priority: "high",
    key: `paper_deploy:${position || pair}`,
    digest: false,
    title: `Paper deploy opened: ${pair}`,
    text: `Amount: ${amountSol} SOL\nPosition: ${position?.slice(0, 10) || "?"}\nVirtual balance: ${balanceSol ?? "?"} SOL`,
  });
}

export async function notifyPaperClose({ pair, pnlPct, pnlSol, reason, balanceSol }) {
  await notifyOperator({
    type: "paper_close",
    priority: "high",
    key: `paper_close:${pair}:${reason}:${pnlPct}`,
    digest: false,
    title: `Paper position closed: ${pair}`,
    text: `PnL: ${fmtPct(pnlPct)} (${pnlSol ?? "?"} SOL)\nReason: ${reason || "unknown"}\nVirtual balance: ${balanceSol ?? "?"} SOL`,
  });
}

export async function notifyExitSignal({ pair, action, reason, pnlPct }) {
  const actionText = String(action || "").toLowerCase();
  const priority = actionText.includes("stop") ? "critical" : "high";
  await notifyOperator({
    type: "exit",
    priority,
    key: `exit:${pair}:${action}`,
    digest: false,
    title: `${action || "Exit"} triggered: ${pair}`,
    text: `${reason || ""}${pnlPct != null ? `\nPnL: ${fmtPct(pnlPct)}` : ""}`,
  });
}

export async function notifyRuntimeError({ scope, error }) {
  await notifyOperator({
    type: "runtime_error",
    priority: "critical",
    key: `runtime_error:${scope}`,
    digest: false,
    title: `Runtime error: ${scope}`,
    text: error?.message || error || "unknown error",
  });
}

export async function notifyLifecycleMilestone({ title, text }) {
  await notifyOperator({ type: "lifecycle", priority: "medium", key: `lifecycle:${title}`, title, text, digest: true });
}

export async function notifyDailyPerformanceDigest({ title = "Daily performance digest", text }) {
  await notifyOperator({ type: "daily_digest", priority: "medium", key: `daily_digest:${new Date().toISOString().slice(0, 10)}`, title, text, digest: false });
}

export async function notifyStartup({ mode, text }) {
  await notifyOperator({ type: "startup", priority: "high", key: `startup:${mode}`, title: `Startup: ${mode}`, text, digest: false });
}

export async function notifyShutdown({ signal, text }) {
  await notifyOperator({ type: "shutdown", priority: "high", key: `shutdown:${signal}`, title: `Shutdown: ${signal}`, text, digest: false });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}
