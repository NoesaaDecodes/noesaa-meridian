import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-paper-runtime-test-"));
const stateFile = path.join(tempDir, "state.json");

process.env.MERIDIAN_STATE_FILE = stateFile;
process.env.PAPER_ONLY = "true";
process.env.DRY_RUN = "true";
process.env.PAPER_STARTING_BALANCE_SOL = "0.5";
process.env.PAPER_MAX_OPEN_POSITIONS = "2";
process.env.PAPER_POSITION_SIZE_PCT = "0.2";
process.env.PAPER_MIN_DEPLOY_SOL = "0.05";
process.env.PAPER_MAX_DEPLOY_SOL = "0.1";

const state = await import("../state.js");
const { classifyApiError, config, getDefaultMinFeeActiveTvlRatio } = await import("../config.js");
const { buildSystemPrompt } = await import("../prompt.js");

config.paper.enabled = true;
config.paper.startingBalanceSol = 0.5;
config.paper.maxOpenPositions = 2;
config.paper.positionSizePct = 0.2;
config.paper.minDeploySol = 0.05;
config.paper.maxDeploySol = 0.1;
config.paper.gasReserveSol = 0;

function resetState() {
  fs.writeFileSync(stateFile, JSON.stringify({
    positions: {},
    recentEvents: [],
    paperLifecycleHistory: [],
    lastUpdated: null,
  }, null, 2));
}

test("paper-start health context uses virtual balance", () => {
  resetState();
  state.initPaperAccount({ startingBalanceSol: 0.5 });

  const health = state.getPaperHealthContext({
    startingBalanceSol: 0.5,
    maxOpenPositions: 2,
    positionSizePct: 0.2,
    minDeploySol: 0.05,
    maxDeploySol: 0.1,
    gasReserveSol: 0,
  });

  assert.equal(health.paper_only, true);
  assert.equal(health.virtual_balance_sol, 0.5);
  assert.equal(health.available_balance_sol, 0.5);
  assert.equal(health.open_positions, 0);
  assert.equal(health.deploy_amount_sol, 0.1);
});

test("api auth errors are classified as infrastructure, not candidate failure", () => {
  const error = new Error("401 Unauthorized invalid api key");
  error.status = 401;
  error.provider = "Agent Meridian OKX enrichment";

  const classified = classifyApiError(error, error.provider);

  assert.equal(classified.authFailure, true);
  assert.equal(classified.infrastructureFailure, true);
  assert.equal(classified.provider, "Agent Meridian OKX enrichment");
  assert.match(classified.operatorMessage, /INFRA\/AUTH/);
});

test("PAPER_ONLY deploy_position ignores endpoint failures and creates simulated position", () => {
  resetState();
  state.initPaperAccount({ startingBalanceSol: 0.5 });
  const code = `
    process.env.MERIDIAN_STATE_FILE = ${JSON.stringify(stateFile)};
    process.env.PAPER_ONLY = "true";
    process.env.DRY_RUN = "true";
    process.env.PAPER_STARTING_BALANCE_SOL = "0.5";
    process.env.PAPER_MIN_DEPLOY_SOL = "0.05";
    process.env.PAPER_MAX_DEPLOY_SOL = "0.1";
    globalThis.fetch = async () => { throw new Error("endpoint relay/live fetch should not be called"); };
    const { executeTool } = await import(${JSON.stringify(pathToFileURL(path.resolve("tools/executor.js")).href)});
    const result = await executeTool("deploy_position", {
      pool_address: "Pool111111111111111111111111111111111111111",
      amount_y: 0.05,
      amount_x: 0,
      bins_below: 35,
      bins_above: 0,
      volatility: 1,
      fee_tvl_ratio: 0.05,
      bin_step: 100,
      pool_name: "SAFE-SOL",
    });
    console.log("RESULT:" + JSON.stringify(result));
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env },
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const line = child.stdout.split(/\r?\n/).find((entry) => entry.startsWith("RESULT:"));
  assert.ok(line, child.stdout);
  const result = JSON.parse(line.slice("RESULT:".length));
  assert.equal(result.success, true);
  assert.equal(result.paper_only, true);
  assert.equal(result.simulated, true);
  assert.equal(result.message, "PAPER DEPLOY SIMULATED");
  assert.ok(result.position);

  const stored = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(Object.keys(stored.positions).length, 1);
  assert.equal(stored.paperAccount.available_balance_sol, 0.45);
});

test("live deploy verification endpoint failures still block deploy", () => {
  resetState();
  const code = `
    process.env.MERIDIAN_STATE_FILE = ${JSON.stringify(stateFile)};
    process.env.PAPER_ONLY = "false";
    process.env.DRY_RUN = "true";
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      async text() { return "invalid api key"; },
      async json() { return { error: "invalid api key" }; },
    });
    const { executeTool } = await import(${JSON.stringify(pathToFileURL(path.resolve("tools/executor.js")).href)});
    const result = await executeTool("deploy_position", {
      pool_address: "Pool111111111111111111111111111111111111111",
      amount_y: 0.05,
      amount_x: 0,
      bins_below: 35,
      bins_above: 0,
      volatility: 1,
    });
    console.log("RESULT:" + JSON.stringify(result));
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env, PAPER_ONLY: "false", DRY_RUN: "true" },
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const line = child.stdout.split(/\r?\n/).find((entry) => entry.startsWith("RESULT:"));
  assert.ok(line, child.stdout);
  const result = JSON.parse(line.slice("RESULT:".length));
  assert.equal(result.blocked, true);
  assert.equal(result.type, "infrastructure_auth");
  assert.equal(result.authFailure, true);
});

test("deploy verification logs metric source and mismatch audit", () => {
  resetState();
  const code = `
    process.env.MERIDIAN_STATE_FILE = ${JSON.stringify(stateFile)};
    process.env.PAPER_ONLY = "false";
    process.env.DRY_RUN = "true";
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return { data: [{
          pool_address: "Pool111111111111111111111111111111111111111",
          tvl: 50000,
          active_tvl: 50000,
          fee_active_tvl_ratio: 0.005,
          volatility: 1,
          dlmm_params: { bin_step: 100 },
        }] };
      },
      async text() { return ""; },
    });
    const { config } = await import(${JSON.stringify(pathToFileURL(path.resolve("config.js")).href)});
    config.screening.minFeeActiveTvlRatio = 0.02;
    config.screening.timeframe = "5m";
    const { executeTool } = await import(${JSON.stringify(pathToFileURL(path.resolve("tools/executor.js")).href)});
    const result = await executeTool("deploy_position", {
      pool_address: "Pool111111111111111111111111111111111111111",
      amount_y: 0.05,
      amount_x: 0,
      bins_below: 35,
      bins_above: 0,
      volatility: 1,
      fee_tvl_ratio: 0.53,
      bin_step: 100,
    });
    console.log("RESULT:" + JSON.stringify(result));
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env, PAPER_ONLY: "false", DRY_RUN: "true" },
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /DEPLOY_VERIFY/);
  assert.match(child.stdout, /screening_metric=fee_active_tvl_ratio/);
  assert.match(child.stdout, /deploy_verification_metric=fee_active_tvl_ratio/);
  assert.match(child.stdout, /Metric mismatch/);

  const line = child.stdout.split(/\r?\n/).find((entry) => entry.startsWith("RESULT:"));
  assert.ok(line, child.stdout);
  const result = JSON.parse(line.slice("RESULT:".length));
  assert.equal(result.blocked, true);
  assert.equal(result.metric_audit.screening_metric.value, 0.53);
  assert.equal(result.metric_audit.deploy_verification_metric.value, 0.005);
});

test("toxic token symbols and names are rejected", async () => {
  const { getToxicTokenRejectReason } = await import("../tools/screening.js");

  assert.match(getToxicTokenRejectReason({
    name: "SCAM-SOL",
    base: { symbol: "SCAM" },
  }), /SCAM/);
  assert.match(getToxicTokenRejectReason({
    name: "Friendly RUG Pool",
    base: { symbol: "FRIEND" },
  }), /RUG/);
  assert.equal(getToxicTokenRejectReason({
    name: "CLEAN-SOL",
    base: { symbol: "CLEAN" },
  }), null);
});

test("agent retry guard blocks same deploy after safety rejection but allows next candidate", () => {
  const code = `
    process.env.OPENAI_API_KEY = "test-key";
    const { createToolRetryGuard } = await import(${JSON.stringify(pathToFileURL(path.resolve("agent.js")).href)});
    const guard = createToolRetryGuard();
    const first = guard.reserve("deploy_position", { pool_address: "pool_a" });
    const parallel = guard.reserve("deploy_position", { pool_address: "pool_b" });
    guard.recordResult("deploy_position", { blocked: true, type: "safety_filter", reason: "fee too low" });
    const duplicate = guard.reserve("deploy_position", { pool_address: "pool_a" });
    const next = guard.reserve("deploy_position", { pool_address: "pool_b" });
    console.log("RESULT:" + JSON.stringify({ first, parallel, duplicate, next }));
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env, OPENAI_API_KEY: "test-key" },
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const line = child.stdout.split(/\r?\n/).find((entry) => entry.startsWith("RESULT:"));
  assert.ok(line, child.stdout);
  const result = JSON.parse(line.slice("RESULT:".length));
  assert.equal(result.first.allowed, true);
  assert.equal(result.parallel.allowed, false);
  assert.match(result.parallel.reason, /in-flight attempt/);
  assert.equal(result.duplicate.allowed, false);
  assert.match(result.duplicate.reason, /already attempted for pool pool_a/);
  assert.equal(result.next.allowed, true);
});

test("PAPER_ONLY PnL refresh uses market data without RPC or relay endpoint", () => {
  resetState();
  state.initPaperAccount({ startingBalanceSol: 0.5 });
  state.trackPaperPosition({
    position: "paper_pnl_refresh",
    pool: "Pool111111111111111111111111111111111111111",
    pool_name: "PNL-SOL",
    strategy: "bid_ask",
    bin_range: { min: 95, max: 105 },
    amount_sol: 0.05,
    active_bin: 100,
    entry_price_sol: 1,
    paper_options: {
      startingBalanceSol: 0.5,
      maxOpenPositions: 2,
      minDeploySol: 0.05,
      maxDeploySol: 0.1,
    },
  });

  const code = `
    process.env.MERIDIAN_STATE_FILE = ${JSON.stringify(stateFile)};
    process.env.PAPER_ONLY = "true";
    process.env.DRY_RUN = "true";
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.RPC_URL;
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (!text.startsWith("https://pool-discovery-api.datapi.meteora.ag/")) {
        throw new Error("unexpected endpoint " + text);
      }
      return {
        ok: true,
        async json() {
          return { data: [{
            pool_address: "Pool111111111111111111111111111111111111111",
            pool_price: 1.1,
            active_bin: 102,
            volume: 1234,
            fee_active_tvl_ratio: 0.05,
          }] };
        },
        async text() { return ""; },
      };
    };
    const { refreshPaperPositionPnl } = await import(${JSON.stringify(pathToFileURL(path.resolve("index.js")).href)});
    const { getTrackedPosition } = await import(${JSON.stringify(pathToFileURL(path.resolve("state.js")).href)});
    const result = await refreshPaperPositionPnl(getTrackedPosition("paper_pnl_refresh"));
    console.log("RESULT:" + JSON.stringify({ result, stored: getTrackedPosition("paper_pnl_refresh") }));
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env, PAPER_ONLY: "true", DRY_RUN: "true", OPENAI_API_KEY: "test-key", RPC_URL: "" },
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.doesNotMatch(child.stdout + child.stderr, /Endpoint URL must start/i);
  assert.match(child.stdout, /Paper simulated PnL refreshed/);
  const line = child.stdout.split(/\r?\n/).find((entry) => entry.startsWith("RESULT:"));
  assert.ok(line, child.stdout);
  const { result, stored } = JSON.parse(line.slice("RESULT:".length));
  assert.equal(result.pnl_source, "paper_simulated_pnl");
  assert.equal(result.market_source, "Meteora Pool Discovery");
  assert.equal(result.pnl_pct, 10);
  assert.equal(result.in_range, true);
  assert.equal(stored.last_paper_pnl_source, "paper_simulated_pnl");
  assert.equal(stored.last_paper_active_bin, 102);
});

test("paper PnL refresh initializes missing entry price from market data", () => {
  resetState();
  state.initPaperAccount({ startingBalanceSol: 0.5 });
  state.trackPaperPosition({
    position: "paper_pnl_entry",
    pool: "Pool222222222222222222222222222222222222222",
    pool_name: "ENTRY-SOL",
    strategy: "bid_ask",
    bin_range: { min: 95, max: 105 },
    amount_sol: 0.05,
    active_bin: 100,
    paper_options: { startingBalanceSol: 0.5, maxOpenPositions: 2 },
  });

  const code = `
    process.env.MERIDIAN_STATE_FILE = ${JSON.stringify(stateFile)};
    process.env.PAPER_ONLY = "true";
    process.env.DRY_RUN = "true";
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = async () => ({
      ok: true,
      async json() { return { data: [{ pool_price: 2, active_bin: 100 }] }; },
      async text() { return ""; },
    });
    const { refreshPaperPositionPnl } = await import(${JSON.stringify(pathToFileURL(path.resolve("index.js")).href)});
    const { getTrackedPosition } = await import(${JSON.stringify(pathToFileURL(path.resolve("state.js")).href)});
    const result = await refreshPaperPositionPnl(getTrackedPosition("paper_pnl_entry"));
    console.log("RESULT:" + JSON.stringify({ result, stored: getTrackedPosition("paper_pnl_entry") }));
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env, PAPER_ONLY: "true", DRY_RUN: "true", OPENAI_API_KEY: "test-key" },
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const line = child.stdout.split(/\r?\n/).find((entry) => entry.startsWith("RESULT:"));
  assert.ok(line, child.stdout);
  const { result, stored } = JSON.parse(line.slice("RESULT:".length));
  assert.equal(result.pnl_pct, 0);
  assert.equal(stored.entry_price_sol, 2);
  assert.equal(stored.last_paper_pnl_source, "paper_simulated_pnl");
});

test("paper mode uses exploratory fee threshold without changing live default", () => {
  assert.equal(getDefaultMinFeeActiveTvlRatio({ paperOnly: true, timeframe: "5m" }), 0.02);
  assert.equal(getDefaultMinFeeActiveTvlRatio({ paperOnly: false, timeframe: "5m" }), 0.05);
  assert.equal(getDefaultMinFeeActiveTvlRatio({ paperOnly: true, timeframe: "5m", configuredValue: 0.07 }), 0.07);
});

test("paper prompt explicitly prevents live wallet funding recommendations", () => {
  resetState();
  const prompt = buildSystemPrompt(
    "MANAGER",
    { paper_only: true, sol: 0.5, virtual_balance_sol: 0.5 },
    { paper_only: true, total_positions: 0, positions: [] },
  );

  assert.match(prompt, /PAPER_ONLY MODE/);
  assert.match(prompt, /Virtual balance available: 0\.5 SOL/);
  assert.match(prompt, /Never recommend funding the live wallet/);
  assert.doesNotMatch(prompt, /fund your live wallet/i);
  assert.doesNotMatch(prompt, /fund your wallet/i);
});

test("telegram concise prompt requests tactical operator replies", () => {
  const prompt = buildSystemPrompt(
    "GENERAL",
    { paper_only: true, sol: 0.5, virtual_balance_sol: 0.5 },
    { paper_only: true, total_positions: 0, positions: [] },
    null,
    null,
    null,
    null,
    null,
    { telegramConcise: true },
  );

  assert.match(prompt, /TELEGRAM OPERATOR REPLY MODE/);
  assert.match(prompt, /Prioritize: action, reason, key metrics, next recommendation/);
  assert.match(prompt, /Maximum \d+ lines/);
});

test("paper health context is independent of live wallet fetch", async () => {
  resetState();
  state.initPaperAccount({ startingBalanceSol: 0.5 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("live network fetch should not be called");
  };
  try {
    const result = state.getPaperHealthContext({
      startingBalanceSol: 0.5,
      maxOpenPositions: 2,
      positionSizePct: 0.2,
      minDeploySol: 0.05,
      maxDeploySol: 0.1,
      gasReserveSol: 0,
    });
    assert.equal(result.paper_only, true);
    assert.equal(result.virtual_balance_sol, 0.5);
    assert.equal(result.deploy_amount_sol, 0.1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paper executor balance tool returns virtual account without live fetch", () => {
  resetState();
  state.initPaperAccount({ startingBalanceSol: 0.5 });
  const code = `
    process.env.MERIDIAN_STATE_FILE = ${JSON.stringify(stateFile)};
    process.env.PAPER_ONLY = "true";
    process.env.DRY_RUN = "true";
    process.env.PAPER_STARTING_BALANCE_SOL = "0.5";
    process.env.PAPER_MAX_OPEN_POSITIONS = "2";
    process.env.PAPER_POSITION_SIZE_PCT = "0.2";
    process.env.PAPER_MIN_DEPLOY_SOL = "0.05";
    process.env.PAPER_MAX_DEPLOY_SOL = "0.1";
    globalThis.fetch = async () => { throw new Error("live fetch should not be called"); };
    const { executeTool } = await import(${JSON.stringify(pathToFileURL(path.resolve("tools/executor.js")).href)});
    const result = await executeTool("get_wallet_balance", {});
    console.log("RESULT:" + JSON.stringify(result));
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env },
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const line = child.stdout.split(/\r?\n/).find((entry) => entry.startsWith("RESULT:"));
  assert.ok(line, child.stdout);
  const result = JSON.parse(line.slice("RESULT:".length));
  assert.equal(result.paper_only, true);
  assert.equal(result.sol, 0.5);
  assert.equal(result.virtual_balance_sol, 0.5);
  assert.equal(result.deploy_amount_sol, 0.1);
});

test("paper deploy amount respects paper config only", () => {
  resetState();
  state.initPaperAccount({ startingBalanceSol: 0.5 });

  assert.equal(state.computePaperDeployAmount({
    startingBalanceSol: 0.5,
    positionSizePct: 0.2,
    minDeploySol: 0.05,
    maxDeploySol: 0.1,
    gasReserveSol: 0,
  }), 0.1);

  state.trackPaperPosition({
    position: "paper_size_default",
    pool: "pool_size_default",
    pool_name: "SIZE/SOL",
    strategy: "test",
    bin_range: { min: 1, max: 2 },
    amount_sol: 0.45,
    active_bin: 1,
    entry_price_sol: 1,
    paper_options: { startingBalanceSol: 0.5, maxOpenPositions: 2 },
  });

  assert.equal(state.computePaperDeployAmount({
    startingBalanceSol: 0.5,
    positionSizePct: 0.2,
    minDeploySol: 0.05,
    maxDeploySol: 0.1,
    gasReserveSol: 0,
  }), 0.05);
});
