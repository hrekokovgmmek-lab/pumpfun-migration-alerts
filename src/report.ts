import type { Config } from "./config.ts";
import type { HolderStats } from "./holders.ts";

export type Level = "danger" | "warn" | "info";

export interface Flag {
  level: Level;
  text: string;
}

export interface Snapshot {
  mint: string;
  signature?: string;
  pool: string;
  /** SOL in the pool's quote vault — what sellers can actually take out. */
  poolSol: number;
  /** Share of the token supply sitting in the pool's base vault. */
  poolTokenPct: number;
  mayhem: boolean;
  cashback: boolean;
  /** null when the RPC refused getTokenLargestAccounts (public endpoints often do). */
  holders: HolderStats | null;
  detectedAt: string;
  /** From the migration event to the finished inspection. */
  inspectMs: number;
}

type Thresholds = Pick<Config, "topHolderWarnPct" | "topHolderDangerPct" | "thinPoolSol">;

export function riskFlags(s: Snapshot, t: Thresholds): Flag[] {
  const flags: Flag[] = [];
  if (!s.holders) {
    flags.push({ level: "info", text: "holder data unavailable: the RPC refused getTokenLargestAccounts" });
  } else {
    const top = s.holders.top1Pct;
    if (top >= t.topHolderDangerPct) flags.push({ level: "danger", text: `one account holds ${top.toFixed(1)}% of supply` });
    else if (top >= t.topHolderWarnPct) flags.push({ level: "warn", text: `one account holds ${top.toFixed(1)}% of supply` });
  }
  // What sellers can take out is the SOL really in the pool.
  if (s.poolSol < t.thinPoolSol) {
    flags.push({ level: "warn", text: `thin pool: only ${s.poolSol.toFixed(2)} SOL of real liquidity` });
  }
  if (s.mayhem) flags.push({ level: "warn", text: "mayhem-mode pool" });
  if (s.cashback) flags.push({ level: "info", text: "cashback enabled" });
  return flags;
}

export function verdict(flags: Flag[]): "danger" | "warn" | "ok" {
  if (flags.some((f) => f.level === "danger")) return "danger";
  if (flags.some((f) => f.level === "warn")) return "warn";
  return "ok";
}

const sol = (n: number, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : "n/a");
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;

export function formatConsole(s: Snapshot, flags: Flag[]): string {
  const lines = [
    `[${verdict(flags).toUpperCase()}] ${s.mint}`,
    `  pool ${s.pool}`,
    `  liquidity ${sol(s.poolSol)} SOL · ${sol(s.poolTokenPct, 1)}% of supply in the pool`,
    s.holders
      ? `  holders: top-1 ${s.holders.top1Pct.toFixed(1)}% · top-10 ${s.holders.top10Pct.toFixed(1)}% (pool excluded, ${s.holders.counted} accounts)`
      : "  holders: n/a",
    ...flags.map((f) => `  ${f.level.padEnd(6)} ${f.text}`),
    `  inspected in ${s.inspectMs} ms`,
  ];
  return lines.join("\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function formatTelegramHtml(s: Snapshot, flags: Flag[]): string {
  const head = { danger: "DANGER", warn: "CAUTION", ok: "OK" }[verdict(flags)];
  const lines = [
    `<b>${head}</b> · new PumpSwap pool`,
    `<a href="https://pump.fun/coin/${esc(s.mint)}">${esc(short(s.mint))}</a> · <a href="https://solscan.io/account/${esc(s.pool)}">pool</a>` +
      (s.signature ? ` · <a href="https://solscan.io/tx/${esc(s.signature)}">migration tx</a>` : ""),
    `Liquidity ${sol(s.poolSol)} SOL · ${sol(s.poolTokenPct, 1)}% of supply in the pool` +
      (s.holders ? ` · top-1 ${s.holders.top1Pct.toFixed(1)}% · top-10 ${s.holders.top10Pct.toFixed(1)}%` : " · holders n/a"),
    ...flags.map((f) => `• ${esc(f.text)}`),
  ];
  return lines.join("\n");
}
