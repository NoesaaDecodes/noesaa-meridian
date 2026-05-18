import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-state-test-"));
const stateFile = path.join(tempDir, "state.json");
const decisionLogPath = path.join(tempDir, "decision-log-as-directory");

fs.mkdirSync(decisionLogPath);
process.env.MERIDIAN_STATE_FILE = stateFile;
process.env.MERIDIAN_DECISION_LOG_FILE = decisionLogPath;

const state = await import("../state.js");
const decisionLog = await import("../decision-log.js");

function resetState() {
  fs.writeFileSync(stateFile, JSON.stringify({ positions: {}, recentEvents: [], paperLifecycleHistory: [], lastUpdated: null }, null, 2));
}

function readState() {
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function trackPaper(position = "paper_test_position") {
  state.trackPaperPosition({
    position,
    pool: `pool_${position}`,
    pool_name: "TEST/SOL",
    strategy: "test",
    bin_range: { min: 10, max: 20 },
    amount_sol: 1,
    active_bin: 15,
    bin_step: 20,
    volatility: 1,
    fee_tvl_ratio: 10,
    organic_score: 80,
    entry_price_sol: 1,
    signal_snapshot: {
      volume: 1000,
      smart_wallet_score: 0.75,
      smart_wallets_present: true,
      narrative_strength: "strong",
      narrative_quality: "present",
    },
  });
}

function captureLogs(fn) {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  try {
    const result = fn();
    return { result, lines };
  } finally {
    console.log = original;
  }
}

test("peak confirmation logs never use current: ?%", () => {
  resetState();
  trackPaper("paper_peak_reject");

  state.queuePeakConfirmation("paper_peak_reject", 10);
  const { result, lines } = captureLogs(() => (
    state.resolvePendingPeak("paper_peak_reject", 4, 0.85)
  ));

  assert.equal(result.rejected, true);
  assert.doesNotMatch(lines.join("\n"), /current:\s*\?%/);
  assert.doesNotMatch(fs.readFileSync(path.resolve("state.js"), "utf8"), /currentPnlPct\s*\?\?\s*"\?"/);
});

test("pending peak confirmation is deferred when PnL fetch fails", () => {
  resetState();
  trackPaper("paper_peak_defer");

  assert.equal(state.queuePeakConfirmation("paper_peak_defer", 15), true);
  const { result, lines } = captureLogs(() => (
    state.resolvePendingPeak("paper_peak_defer", null, 0.85)
  ));

  assert.equal(result.deferred, true);
  assert.equal(result.pending, true);
  assert.doesNotMatch(lines.join("\n"), /current:\s*\?%/);

  const stored = readState().positions.paper_peak_defer;
  assert.equal(stored.pending_peak_pnl_pct, 15);
  assert.equal(stored.peak_pnl_pct, 0);
});

test("stale paper positions skip PnL exit logic safely", () => {
  resetState();
  trackPaper("paper_stale");

  const exit = state.updatePnlAndCheckExits(
    "paper_stale",
    {
      pnl_pct: -99,
      pnl_pct_suspicious: true,
      in_range: true,
      fee_per_tvl_24h: 20,
      age_minutes: 120,
    },
    {
      stopLossPct: -10,
      trailingTakeProfit: true,
      trailingTriggerPct: 5,
      trailingDropPct: 2,
      outOfRangeWaitMinutes: 30,
      minFeePerTvl24h: 1,
    },
  );

  assert.equal(exit, null);
});

test("trailing stop logic ignores invalid and non-finite PnL", () => {
  resetState();
  trackPaper("paper_trailing_invalid");

  state.queuePeakConfirmation("paper_trailing_invalid", 20, { immediate: true });
  state.updatePnlAndCheckExits(
    "paper_trailing_invalid",
    { pnl_pct: 20, pnl_pct_suspicious: false, in_range: true, fee_per_tvl_24h: 20, age_minutes: 20 },
    { trailingTakeProfit: true, trailingTriggerPct: 5, trailingDropPct: 2, stopLossPct: -10, outOfRangeWaitMinutes: 30, minFeePerTvl24h: 1 },
  );

  for (const invalidPnl of [null, Number.NaN, Infinity, -Infinity]) {
    const exit = state.updatePnlAndCheckExits(
      "paper_trailing_invalid",
      { pnl_pct: invalidPnl, pnl_pct_suspicious: false, in_range: true, fee_per_tvl_24h: 20, age_minutes: 20 },
      { trailingTakeProfit: true, trailingTriggerPct: 5, trailingDropPct: 2, stopLossPct: -10, outOfRangeWaitMinutes: 30, minFeePerTvl24h: 1 },
    );
    assert.equal(exit, null);
  }
});

test("decision log write failures do not crash appendDecision", () => {
  assert.doesNotThrow(() => {
    const decision = decisionLog.appendDecision({
      type: "test",
      actor: "TEST",
      pool: "pool_test",
      summary: "write failure should be logged, not thrown",
    });
    assert.equal(decision.type, "test");
  });
});

test("closed paper positions append deterministic lifecycle analytics", () => {
  resetState();
  trackPaper("paper_lifecycle");

  state.updatePaperPositionPnl("paper_lifecycle", { pnl_pct: 3, current_price_sol: 1.03, active_bin: 15, in_range: true, volume: 800 });
  state.updatePaperPositionPnl("paper_lifecycle", { pnl_pct: -4, current_price_sol: 0.96, active_bin: 9, in_range: false, volume: 650 });
  state.updatePaperPositionPnl("paper_lifecycle", { pnl_pct: 12, current_price_sol: 1.12, active_bin: 16, in_range: true, volume: 500 });

  const beforeClose = readState();
  beforeClose.positions.paper_lifecycle.deployed_at = new Date(Date.now() - 20 * 60_000).toISOString();
  beforeClose.positions.paper_lifecycle.paper_out_of_range_total_ms = 5 * 60_000;
  beforeClose.positions.paper_lifecycle.paper_out_of_range_since = null;
  fs.writeFileSync(stateFile, JSON.stringify(beforeClose, null, 2));

  const closed = state.closePaperPosition("paper_lifecycle", "Trailing TP test", 7, 0.07);
  const stored = readState();
  const lifecycle = stored.paperLifecycleHistory.at(-1);

  assert.equal(stored.paperLifecycleHistory.length, 1);
  assert.equal(closed.paper_lifecycle.position, "paper_lifecycle");
  assert.equal(lifecycle.position, "paper_lifecycle");
  assert.equal(lifecycle.max_unrealized_pnl_pct, 12);
  assert.equal(lifecycle.min_unrealized_pnl_pct, -4);
  assert.equal(lifecycle.realized_pnl_pct, 7);
  assert.equal(lifecycle.close_reason, "Trailing TP test");
  assert.equal(lifecycle.trailing_stop_used, true);
  assert.equal(lifecycle.out_of_range_duration_minutes, 5);
  assert.equal(lifecycle.volume_at_entry, 1000);
  assert.equal(lifecycle.volume_at_close, 500);
  assert.equal(lifecycle.volume_decay_pct, 50);
  assert.equal(lifecycle.smart_wallet_score_at_entry, 0.75);
  assert.equal(lifecycle.smart_wallets_present_at_entry, true);
  assert.equal(lifecycle.narrative_strength_at_entry, "strong");
  assert.equal(lifecycle.hold_quality.range_efficiency_pct, 75);
  assert.equal(lifecycle.exit_quality.gave_back_from_peak_pct, 5);
});

test("failed paper refresh cycles do not mutate lifecycle quality metrics", () => {
  resetState();
  trackPaper("paper_failed_refresh_lifecycle");

  state.updatePaperPositionPnl("paper_failed_refresh_lifecycle", { pnl_pct: 8, current_price_sol: 1.08, active_bin: 15, in_range: true, volume: 900 });
  state.updatePaperPositionPnl("paper_failed_refresh_lifecycle", { refresh_error: "temporary API failure" });

  const beforeClose = readState().positions.paper_failed_refresh_lifecycle;
  assert.equal(beforeClose.paper_max_unrealized_pnl_pct, 8);
  assert.equal(beforeClose.paper_min_unrealized_pnl_pct, 8);
  assert.equal(beforeClose.paper_failed_refresh_count, 1);

  state.closePaperPosition("paper_failed_refresh_lifecycle", "manual test close", 6, 0.06);
  const lifecycle = readState().paperLifecycleHistory.at(-1);
  assert.equal(lifecycle.max_unrealized_pnl_pct, 8);
  assert.equal(lifecycle.min_unrealized_pnl_pct, 6);
  assert.equal(lifecycle.hold_quality.failed_refresh_count, 1);
});
