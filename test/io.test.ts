import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { inspectMigration } from "../src/inspect.ts";
import { POOL_DISCRIMINATOR, POOL_MIN_SIZE, PUMPSWAP_PROGRAM, WSOL } from "../src/pool.ts";
import { RpcClient } from "../src/rpc.ts";
import { sendTelegram } from "../src/telegram.ts";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test("rpc retries 429 after 2 s and returns the result", async () => {
  const replies = [json(429, {}), json(200, { result: { value: 7 } })];
  const waits: number[] = [];
  const rpc = new RpcClient("http://rpc", 1000, async () => replies.shift()!, async (ms) => void waits.push(ms));
  assert.deepEqual(await rpc.call("getSlot", []), { value: 7 });
  assert.ok(waits.includes(2000));
});

test("rpc surfaces JSON-RPC errors without retrying", async () => {
  let calls = 0;
  const rpc = new RpcClient("http://rpc", 1000, async () => {
    calls++;
    return json(200, { error: { message: "invalid param" } });
  });
  await assert.rejects(rpc.call("getAccountInfo", []), /invalid param/);
  assert.equal(calls, 1);
});

test("rpc hides API keys in network errors", async () => {
  const rpc = new RpcClient("http://rpc", 1000, async () => {
    throw new Error("connect failed https://rpc.example/?api-key=SECRET");
  }, async () => undefined);
  await assert.rejects(rpc.call("getSlot", []), (e: Error) => !e.message.includes("SECRET") && e.message.includes("api-key=***"));
});

test("rpc spaces calls to stay under the request rate", async () => {
  const waits: number[] = [];
  const rpc = new RpcClient("http://rpc", 2, async () => json(200, { result: 1 }), async (ms) => void waits.push(ms));
  await Promise.all([rpc.call("a", []), rpc.call("b", []), rpc.call("c", [])]);
  assert.equal(waits.length, 2);
  assert.ok(waits.every((ms) => ms > 0 && ms <= 500));
});

test("telegram waits retry_after on 429 and never leaks the token", async () => {
  const replies = [json(429, { parameters: { retry_after: 2 } }), json(200, { ok: true })];
  const waits: number[] = [];
  await sendTelegram("123:SECRET", "42", "<b>hi</b>", async () => replies.shift()!, async (ms) => void waits.push(ms));
  assert.deepEqual(waits, [2000]);
  await assert.rejects(sendTelegram("123:SECRET", "42", "x", async () => json(403, {})), (e: Error) => !e.message.includes("SECRET"));
});

const MINT = "ADYt4LoCYdrt2RGvXyfgrXwcGjUJ8E69697mRrt5pump";
const POOL = "C5Xz4F5SBtvywzxyKJ6cMezantUDFMXZ7dtG6xgYqqX1";
const BASE_VAULT = PublicKey.unique().toBase58();
const QUOTE_VAULT = PublicKey.unique().toBase58();

function poolAccount() {
  const d = Buffer.alloc(POOL_MIN_SIZE);
  Buffer.from(POOL_DISCRIMINATOR, "hex").copy(d, 0);
  new PublicKey(MINT).toBuffer().copy(d, 43);
  new PublicKey(WSOL).toBuffer().copy(d, 75);
  new PublicKey(BASE_VAULT).toBuffer().copy(d, 139);
  new PublicKey(QUOTE_VAULT).toBuffer().copy(d, 171);
  return { owner: PUMPSWAP_PROGRAM.toBase58(), data: d };
}

function tokenAccount(amount: bigint) {
  const d = Buffer.alloc(165);
  d.writeBigUInt64LE(amount, 64);
  return { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: d };
}

function mintAccount() {
  const d = Buffer.alloc(82);
  d.writeBigUInt64LE(1_000_000_000_000_000n, 36);
  d[44] = 6;
  return { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: d };
}

test("inspection waits for a pool the node does not see yet, then reports it", async () => {
  let poolReads = 0;
  const rpc = {
    async getMultipleAccounts(keys: string[]) {
      if (keys[0] === POOL) return ++poolReads < 3 ? [null, mintAccount()] : [poolAccount(), mintAccount()];
      return [tokenAccount(206_900_000_000_000n), tokenAccount(70_000_000_000n)];
    },
    async getTokenLargestAccounts() {
      return [
        { address: BASE_VAULT, amount: "206900000000000" },
        { address: "W1", amount: "30000000000000" },
      ];
    },
  };
  const s = await inspectMigration(rpc, MINT, "sig", Date.now(), { sleep: async () => undefined });
  assert.equal(poolReads, 3);
  assert.equal(s.pool, POOL);
  assert.equal(s.poolSol, 70);
  assert.ok(Math.abs(s.poolTokenPct - 20.69) < 1e-9);
  assert.equal(s.holders?.top1Pct, 3);
});

test("inspection still reports when the holder read is refused", async () => {
  const rpc = {
    async getMultipleAccounts(keys: string[]) {
      if (keys[0] === POOL) return [poolAccount(), mintAccount()];
      return [tokenAccount(206_900_000_000_000n), tokenAccount(70_000_000_000n)];
    },
    async getTokenLargestAccounts(): Promise<{ address: string; amount: string }[]> {
      throw new Error("RPC getTokenLargestAccounts: HTTP 429");
    },
  };
  const s = await inspectMigration(rpc, MINT, undefined, Date.now(), { sleep: async () => undefined });
  assert.equal(s.holders, null);
  assert.equal(s.poolSol, 70);
});

test("inspection gives up on an account that is not a pool", async () => {
  const rpc = {
    async getMultipleAccounts() {
      return [{ owner: WSOL, data: Buffer.alloc(POOL_MIN_SIZE) }, mintAccount()];
    },
    async getTokenLargestAccounts() {
      return [];
    },
  };
  await assert.rejects(inspectMigration(rpc, MINT, undefined, Date.now(), { sleep: async () => undefined }), /not owned by PumpSwap/);
});
