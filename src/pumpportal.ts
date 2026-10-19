import { Backoff } from "./backoff.ts";

export const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";

export interface MigrationEvent {
  mint: string;
  signature: string;
  receivedAt: number;
}

/** One PumpPortal message → a migration event, or null for anything else (acks, other tx types, junk). */
export function parseMigration(raw: unknown, now = Date.now()): MigrationEvent | null {
  if (typeof raw !== "string") return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const o = m as Record<string, unknown>;
  if (o.txType !== "migrate" || typeof o.mint !== "string" || typeof o.signature !== "string") return null;
  return { mint: o.mint, signature: o.signature, receivedAt: now };
}

export interface FeedOptions {
  onMigration: (e: MigrationEvent) => void;
  log?: (msg: string) => void;
  url?: string;
  backoff?: Backoff;
  /** Reconnect if the socket has been silent this long. */
  silenceMs?: number;
}

/**
 * One websocket to PumpPortal, subscribed to migrations.
 *
 * PumpPortal asks clients to keep a single connection, and an address that
 * reconnects in a tight loop can get refused for hours. So: one socket at a
 * time, exponential backoff with jitter that resets only after a stable
 * connection, and a silence watchdog for sockets that stay "open" but deliver
 * nothing.
 */
export class MigrationFeed {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private silenceTimer?: NodeJS.Timeout;
  private lastMessageAt = 0;
  private stopped = true;
  private readonly backoff: Backoff;
  private readonly log: (msg: string) => void;

  constructor(private readonly o: FeedOptions) {
    this.backoff = o.backoff ?? new Backoff();
    this.log = o.log ?? (() => undefined);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.silenceTimer);
    this.ws?.close();
  }

  private connect(): void {
    const ws = new WebSocket(this.o.url ?? PUMPPORTAL_WS);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.backoff.opened();
      this.lastMessageAt = Date.now();
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      this.log("connected to PumpPortal, subscribed to migrations");
      this.watchSilence(ws);
    });
    ws.addEventListener("message", (ev) => {
      this.lastMessageAt = Date.now();
      const e = parseMigration(typeof ev.data === "string" ? ev.data : String(ev.data));
      if (e) this.o.onMigration(e);
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      clearInterval(this.silenceTimer);
      if (this.stopped) return;
      const b = this.backoff.next();
      this.log(
        `disconnected; reconnecting in ${Math.round(b.delayMs / 1000)} s (attempt ${b.attempt}` +
          `${b.healthy ? "" : ", the previous connection was not stable"})`,
      );
      this.reconnectTimer = setTimeout(() => this.connect(), b.delayMs);
    });
    // An error is always followed by a close; reconnecting happens there only.
    ws.addEventListener("error", () => undefined);
  }

  private watchSilence(ws: WebSocket): void {
    const silenceMs = this.o.silenceMs ?? 15 * 60_000;
    clearInterval(this.silenceTimer);
    this.silenceTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > silenceMs) {
        this.log(`no messages for ${Math.round(silenceMs / 60_000)} min — reconnecting`);
        ws.close();
      }
    }, Math.min(60_000, silenceMs));
  }
}
