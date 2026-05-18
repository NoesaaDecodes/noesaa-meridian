import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "12345";

const fetchCalls = [];
global.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : {};
  fetchCalls.push({ url: String(url), body });
  return {
    ok: true,
    async json() {
      return { ok: true, result: { message_id: fetchCalls.length } };
    },
    async text() {
      return "";
    },
  };
};

const { config } = await import("../config.js");
const telegram = await import("../telegram.js");

function resetTelegramConfig({ digestMode = true, verboseCycles = false, minNotifyIntervalSec = 300 } = {}) {
  config.telegram.digestMode = digestMode;
  config.telegram.verboseCycles = verboseCycles;
  config.telegram.minNotifyIntervalSec = minNotifyIntervalSec;
  config.telegram.verbosity = "normal";
}

function sentMessages() {
  return fetchCalls.filter((call) => call.url.includes("/sendMessage"));
}

beforeEach(() => {
  fetchCalls.length = 0;
  resetTelegramConfig();
});

afterEach(async () => {
  await telegram.flushTelegramDigest();
  fetchCalls.length = 0;
});

test("engine cycle live messages are suppressed in digest mode when verbose cycles are off", async () => {
  resetTelegramConfig({ digestMode: true, verboseCycles: false });

  const live = await telegram.createLiveMessage("Management Cycle", "Evaluating positions...", { cycle: true });

  assert.equal(live, null);
  assert.equal(fetchCalls.length, 0);
});

test("engine cycle live messages are allowed when verbose cycles are on", async () => {
  resetTelegramConfig({ digestMode: true, verboseCycles: true });

  const live = await telegram.createLiveMessage("Management Cycle", "Evaluating positions...", { cycle: true });
  assert.ok(live);
  await live.finalize("No changes.");

  assert.ok(sentMessages().some((call) => String(call.body.text).includes("Management Cycle")));
});

test("critical runtime errors bypass digest suppression", async () => {
  resetTelegramConfig({ digestMode: true, verboseCycles: false });

  await telegram.notifyRuntimeError({ scope: "test-critical", error: new Error("boom") });

  const messages = sentMessages();
  assert.equal(messages.length, 1);
  assert.match(messages[0].body.text, /Runtime error: test-critical/);
  assert.match(messages[0].body.text, /boom/);
});

test("important paper deploy and close notifications are still sent immediately", async () => {
  resetTelegramConfig({ digestMode: true, verboseCycles: false });

  await telegram.notifyPaperDeploy({ pair: "AAA/SOL", amountSol: 1.25, position: "paper_abc123", balanceSol: 3.75 });
  await telegram.notifyPaperClose({ pair: "AAA/SOL", pnlPct: 8.5, pnlSol: 0.085, reason: "Trailing TP", balanceSol: 4.085 });

  const texts = sentMessages().map((call) => call.body.text).join("\n");
  assert.match(texts, /Paper deploy opened: AAA\/SOL/);
  assert.match(texts, /Paper position closed: AAA\/SOL/);
  assert.match(texts, /8\.50%/);
});

test("repeated digest-only OOR notifications are batched or cooldowned", async () => {
  resetTelegramConfig({ digestMode: true, verboseCycles: false, minNotifyIntervalSec: 300 });

  await telegram.notifyOutOfRange({ pair: "COOL/SOL", minutesOOR: 31 });
  await telegram.notifyOutOfRange({ pair: "COOL/SOL", minutesOOR: 32 });

  assert.equal(sentMessages().length, 0);
  await telegram.flushTelegramDigest();

  const messages = sentMessages();
  assert.equal(messages.length, 1);
  assert.match(messages[0].body.text, /Operator Digest/);
  assert.match(messages[0].body.text, /Out of range: COOL\/SOL/);
  assert.doesNotMatch(messages[0].body.text, /x2/);
});

test("digest-only OOR notifications with distinct keys are grouped into one digest", async () => {
  resetTelegramConfig({ digestMode: true, verboseCycles: false, minNotifyIntervalSec: 300 });

  await telegram.notifyOutOfRange({ pair: "ONE/SOL", minutesOOR: 31 });
  await telegram.notifyOutOfRange({ pair: "TWO/SOL", minutesOOR: 45 });
  await telegram.flushTelegramDigest();

  const messages = sentMessages();
  assert.equal(messages.length, 1);
  assert.match(messages[0].body.text, /Out of range: ONE\/SOL/);
  assert.match(messages[0].body.text, /Out of range: TWO\/SOL/);
});

test("user-driven Telegram command replies are not suppressed", async () => {
  resetTelegramConfig({ digestMode: true, verboseCycles: false, minNotifyIntervalSec: 300 });

  await telegram.sendMessage("No open positions.");
  await telegram.sendMessage("No open positions.");

  const messages = sentMessages();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].body.text, "No open positions.");
  assert.equal(messages[1].body.text, "No open positions.");
});

test("telegram connectivity status reports configured command channel", () => {
  const status = telegram.getTelegramConnectivityStatus();

  assert.equal(status.tokenConfigured, true);
  assert.equal(status.chatIdConfigured, true);
  assert.equal(status.polling, false);
});

test("concise Telegram replies are capped for operator readability", async () => {
  config.telegram.conciseReplies = true;
  config.telegram.maxReplyLines = 6;

  await telegram.sendMessage([
    "# Full Analysis",
    "",
    "Action: hold",
    "Reason: no qualifying setup",
    "Metric: fee/TVL 0.01%",
    "Metric: API 401 auth issue",
    "What this means: long explanatory paragraph that should not dominate.",
    "Recommendation: refresh API key",
    "Extra: ask for details",
  ].join("\n"));

  const [message] = sentMessages();
  const lines = message.body.text.split(/\r?\n/);
  assert.ok(lines.length <= 6);
  assert.equal(lines[0], "Full Analysis");
  assert.match(message.body.text, /More: ask for details\./);
});
