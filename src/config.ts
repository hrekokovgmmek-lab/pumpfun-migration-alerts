export interface Config {
  rpcUrl: string;
  rpcMaxRps: number;
  telegramToken?: string;
  telegramChatId?: string;
  topHolderWarnPct: number;
  topHolderDangerPct: number;
  thinPoolSol: number;
  alertsJsonl?: string;
}

function num(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${value}"`);
  return n;
}

function text(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const warn = num(env.TOP_HOLDER_WARN_PCT, 25, "TOP_HOLDER_WARN_PCT");
  const danger = num(env.TOP_HOLDER_DANGER_PCT, 50, "TOP_HOLDER_DANGER_PCT");
  if (danger < warn) throw new Error("TOP_HOLDER_DANGER_PCT must not be below TOP_HOLDER_WARN_PCT");
  return {
    rpcUrl: text(env.RPC_URL) ?? "https://api.mainnet-beta.solana.com",
    rpcMaxRps: num(env.RPC_MAX_RPS, 2, "RPC_MAX_RPS"),
    telegramToken: text(env.TELEGRAM_BOT_TOKEN),
    telegramChatId: text(env.TELEGRAM_CHAT_ID),
    topHolderWarnPct: warn,
    topHolderDangerPct: danger,
    thinPoolSol: num(env.THIN_POOL_SOL, 5, "THIN_POOL_SOL"),
    alertsJsonl: text(env.ALERTS_JSONL),
  };
}

/** Hide API keys and tokens in any URL before it reaches a log line. */
export function maskSecrets(s: string): string {
  return s
    .replace(/(api[-_]?key=)[^&\s"']+/gi, "$1***")
    .replace(/(bot)\d+:[A-Za-z0-9_-]+/g, "$1***");
}
