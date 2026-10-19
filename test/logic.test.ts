import assert from "node:assert/strict";
import { test } from "node:test";
import { Backoff } from "../src/backoff.ts";
import { loadConfig, maskSecrets } from "../src/config.ts";
import { holderConcentration } from "../src/holders.ts";
import { parseMigration } from "../src/pumpportal.ts";
import { formatTelegramHtml, riskFlags, verdict, type Snapshot } from "../src/report.ts";

test("holder concentration excludes the pool vault and sorts by amount", () => {
  const supply = 1_000_000_000_000_000n;
  const largest = [
    { address: "POOL", amount: "206900000000000" },
    { address: "A", amount: "50000000000000" },
    { address: "B", amount: "250000000000000" },
    { address: "C", amount: "10000000000000" },
  ];
  const h = holderConcentration(largest, supply, new Set(["POOL"]));
  assert.equal(h.top1Account, "B");
  assert.equal(h.top1Pct, 25);
  assert.equal(h.top10Pct, 31);
  assert.equal(h.counted, 3);
  assert.deepEqual(holderConcentration([], supply, new Set()), { top1Pct: 0, top10Pct: 0, top1Account: undefined, counted: 0 });
});

test("backoff doubles, caps, and resets only after a stable connection", () => {
  const b = new Backoff({ baseMs: 1000, maxMs: 8000, stableMs: 60_000, rand: () => 0.5 });
  assert.deepEqual([1, 2, 3, 4, 5].map(() => b.next(0).delayMs), [1000, 2000, 4000, 8000, 8000]);
  b.opened(0);
  assert.equal(b.next(10_000).delayMs, 8000, "a short-lived connection does not reset the delay");
  b.opened(0);
  const r = b.next(60_000);
  assert.equal(r.healthy, true);
  assert.equal(r.delayMs, 1000);
});

test("backoff jitter stays within ±20%", () => {
  const lo = new Backoff({ baseMs: 1000, rand: () => 0 }).next(0).delayMs;
  const hi = new Backoff({ baseMs: 1000, rand: () => 1 }).next(0).delayMs;
  assert.deepEqual([lo, hi], [800, 1200]);
});

test("only migration messages become events", () => {
  assert.deepEqual(parseMigration('{"txType":"migrate","mint":"M","signature":"S","pool":"pump-amm"}', 5), {
    mint: "M",
    signature: "S",
    receivedAt: 5,
  });
  assert.equal(parseMigration('{"message":"Successfully subscribed to keys."}'), null);
  assert.equal(parseMigration('{"txType":"create","mint":"M","signature":"S"}'), null);
  assert.equal(parseMigration("not json"), null);
  assert.equal(parseMigration(42), null);
});

const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  mint: "ADYt4LoCYdrt2RGvXyfgrXwcGjUJ8E69697mRrt5pump",
  signature: "sig",
  pool: "C5Xz4F5SBtvywzxyKJ6cMezantUDFMXZ7dtG6xgYqqX1",
  poolSol: 70,
  poolTokenPct: 20.7,
  mayhem: false,
  cashback: false,
  holders: { top1Pct: 3, top10Pct: 12, counted: 19 },
  detectedAt: "2026-10-19T00:00:00.000Z",
  inspectMs: 900,
  ...o,
});
const t = { topHolderWarnPct: 25, topHolderDangerPct: 50, thinPoolSol: 5 };

test("risk flags follow the thresholds", () => {
  assert.equal(verdict(riskFlags(snap(), t)), "ok");
  assert.equal(verdict(riskFlags(snap({ holders: { top1Pct: 30, top10Pct: 40, counted: 19 } }), t)), "warn");
  assert.equal(verdict(riskFlags(snap({ holders: { top1Pct: 61, top10Pct: 70, counted: 19 } }), t)), "danger");
  assert.equal(verdict(riskFlags(snap({ poolSol: 2.36 }), t)), "warn", "thin pool");
  assert.equal(verdict(riskFlags(snap({ mayhem: true }), t)), "warn");
  assert.equal(verdict(riskFlags(snap({ cashback: true }), t)), "ok", "info flags do not change the verdict");
});

test("missing holder data is flagged, not fatal", () => {
  const s = snap({ holders: null });
  const flags = riskFlags(s, t);
  assert.equal(verdict(flags), "ok");
  assert.match(flags[0]?.text ?? "", /holder data unavailable/);
  assert.match(formatTelegramHtml(s, flags), /holders n\/a/);
});

test("telegram message links the coin, the pool and the transaction", () => {
  const s = snap({ holders: { top1Pct: 61, top10Pct: 70, counted: 19 } });
  const html = formatTelegramHtml(s, riskFlags(s, t));
  assert.match(html, /^<b>DANGER<\/b>/);
  assert.match(html, /top-1 61\.0%/);
  assert.match(html, /pump\.fun\/coin\/ADYt4LoCYdrt2RGvXyfgrXwcGjUJ8E69697mRrt5pump/);
  assert.match(html, /solscan\.io\/tx\/sig/);
  assert.match(html, /one account holds 61\.0% of supply/);
});

test("config validates thresholds and secrets never reach logs", () => {
  assert.throws(() => loadConfig({ TOP_HOLDER_WARN_PCT: "70", TOP_HOLDER_DANGER_PCT: "40" }));
  assert.throws(() => loadConfig({ RPC_MAX_RPS: "-1" }));
  assert.equal(loadConfig({}).rpcMaxRps, 2);
  assert.equal(maskSecrets("https://rpc.example/?api-key=abc123&x=1"), "https://rpc.example/?api-key=***&x=1");
  assert.equal(maskSecrets("https://api.telegram.org/bot123456:AAH-secret_x/sendMessage"), "https://api.telegram.org/bot***/sendMessage");
});
