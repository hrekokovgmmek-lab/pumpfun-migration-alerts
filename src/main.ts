import { appendFileSync } from "node:fs";
import { loadConfig, maskSecrets } from "./config.ts";
import { inspectMigration } from "./inspect.ts";
import { MigrationFeed } from "./pumpportal.ts";
import { formatConsole, formatTelegramHtml, riskFlags } from "./report.ts";
import { RpcClient } from "./rpc.ts";
import { sendTelegram } from "./telegram.ts";

const cfg = loadConfig();
const rpc = new RpcClient(cfg.rpcUrl, cfg.rpcMaxRps);
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

async function handle(mint: string, signature: string | undefined, startedAt: number): Promise<void> {
  try {
    const snap = await inspectMigration(rpc, mint, signature, startedAt);
    const flags = riskFlags(snap, cfg);
    console.log(formatConsole(snap, flags));
    if (cfg.alertsJsonl) appendFileSync(cfg.alertsJsonl, JSON.stringify({ ...snap, flags }) + "\n");
    if (cfg.telegramToken && cfg.telegramChatId) {
      await sendTelegram(cfg.telegramToken, cfg.telegramChatId, formatTelegramHtml(snap, flags)).catch((e) =>
        log(`telegram: ${maskSecrets(String(e instanceof Error ? e.message : e))}`),
      );
    }
  } catch (e) {
    log(`skipped ${mint}: ${maskSecrets(String(e instanceof Error ? e.message : e))}`);
  }
}

const [mode, arg] = process.argv.slice(2);

if (mode === "replay") {
  if (!arg) {
    console.error("usage: npm run replay -- <mint address>");
    process.exit(2);
  }
  await handle(arg, undefined, Date.now());
} else {
  // One queue: inspections of overlapping migrations never burst the RPC together.
  let queue: Promise<void> = Promise.resolve();
  const feed = new MigrationFeed({
    log,
    onMigration: (e) => {
      log(`migration ${e.mint}`);
      queue = queue.then(() => handle(e.mint, e.signature, e.receivedAt));
    },
  });
  feed.start();
  log(
    `watching pump.fun migrations · RPC ${maskSecrets(cfg.rpcUrl)} at ≤${cfg.rpcMaxRps} req/s` +
      (cfg.telegramToken && cfg.telegramChatId ? " · Telegram alerts on" : ""),
  );
  process.on("SIGINT", () => {
    feed.stop();
    log("stopped");
    process.exit(0);
  });
}
