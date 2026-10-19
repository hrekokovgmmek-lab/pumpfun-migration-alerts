import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  canonicalPoolAddress,
  decodePool,
  mintInfo,
  POOL_DISCRIMINATOR,
  POOL_MIN_SIZE,
  PUMPSWAP_PROGRAM,
  tokenAccountAmount,
  WSOL,
} from "../src/pool.ts";

// Pairs checked against live pools on mainnet.
test("canonical pool address is derived from the mint", () => {
  assert.equal(canonicalPoolAddress("ADYt4LoCYdrt2RGvXyfgrXwcGjUJ8E69697mRrt5pump"), "C5Xz4F5SBtvywzxyKJ6cMezantUDFMXZ7dtG6xgYqqX1");
  assert.equal(canonicalPoolAddress("BVpFpksfdEwDgaUhZxdG8kSyfAekeYfKV4BdUfNJpump"), "2p3NgPodD5genag6MmoXjSmmkct2tZ5D9MWu2dJJeUbe");
});

const MINT = "ADYt4LoCYdrt2RGvXyfgrXwcGjUJ8E69697mRrt5pump";
const BASE_VAULT = new PublicKey("C5Xz4F5SBtvywzxyKJ6cMezantUDFMXZ7dtG6xgYqqX1");
const QUOTE_VAULT = new PublicKey("2p3NgPodD5genag6MmoXjSmmkct2tZ5D9MWu2dJJeUbe");

function poolData(o: { base?: string; quote?: string; mayhem?: boolean; cashback?: boolean; size?: number } = {}): Buffer {
  const d = Buffer.alloc(o.size ?? POOL_MIN_SIZE);
  Buffer.from(POOL_DISCRIMINATOR, "hex").copy(d, 0);
  new PublicKey(o.base ?? MINT).toBuffer().copy(d, 43);
  new PublicKey(o.quote ?? WSOL).toBuffer().copy(d, 75);
  BASE_VAULT.toBuffer().copy(d, 139);
  QUOTE_VAULT.toBuffer().copy(d, 171);
  d[243] = o.mayhem ? 1 : 0;
  d[244] = o.cashback ? 1 : 0;
  return d;
}

const owner = PUMPSWAP_PROGRAM.toBase58();

test("a valid pool account decodes", () => {
  const r = decodePool("pool", MINT, { owner, data: poolData({ mayhem: true }) });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.pool.baseVault, BASE_VAULT.toBase58());
  assert.equal(r.pool.quoteVault, QUOTE_VAULT.toBase58());
  assert.equal(r.pool.mayhem, true);
  assert.equal(r.pool.cashback, false);
});

test("missing or half-created accounts are retried, wrong ones are not", () => {
  assert.deepEqual(decodePool("p", MINT, null), { ok: false, reason: "pool account not found yet", retry: true });
  const short = decodePool("p", MINT, { owner, data: poolData({ size: 200 }) });
  assert.equal(short.ok, false);
  assert.equal(!short.ok && short.retry, true);
  for (const bad of [
    decodePool("p", MINT, { owner: WSOL, data: poolData() }),
    decodePool("p", MINT, { owner, data: Buffer.concat([Buffer.alloc(8), poolData().subarray(8)]) }),
    decodePool("p", MINT, { owner, data: poolData({ base: WSOL }) }),
    decodePool("p", MINT, { owner, data: poolData({ quote: MINT }) }),
  ]) {
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.retry, false);
  }
});

test("a longer pool account (new fields appended) still decodes", () => {
  assert.ok(decodePool("p", MINT, { owner, data: poolData({ size: 400 }) }).ok);
});

test("token account amount and mint info are read from their offsets", () => {
  const acc = Buffer.alloc(165);
  acc.writeBigUInt64LE(123_456_789n, 64);
  assert.equal(tokenAccountAmount(acc), 123_456_789n);
  const mint = Buffer.alloc(82);
  mint.writeBigUInt64LE(1_000_000_000_000_000n, 36);
  mint[44] = 6;
  assert.deepEqual(mintInfo(mint), { supply: 1_000_000_000_000_000n, decimals: 6 });
});
