import { holderConcentration, type HolderStats } from "./holders.ts";
import { canonicalPoolAddress, decodePool, mintInfo, tokenAccountAmount, type PoolDecode } from "./pool.ts";
import type { Snapshot } from "./report.ts";
import type { AccountData, RpcClient } from "./rpc.ts";

export interface InspectOptions {
  /** Reads of the pool account while the RPC node may not see it yet. */
  attempts?: number;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Everything the alert needs about one migrated token, in three RPC calls:
 * pool + mint, the two pool vaults, the largest token accounts.
 */
export async function inspectMigration(
  rpc: Pick<RpcClient, "getMultipleAccounts" | "getTokenLargestAccounts">,
  mint: string,
  signature: string | undefined,
  startedAt: number,
  o: InspectOptions = {},
): Promise<Snapshot> {
  const poolAddress = canonicalPoolAddress(mint);
  const attempts = o.attempts ?? 10;
  let decoded: PoolDecode | undefined;
  let mintAcc: AccountData | null = null;
  for (let i = 0; i < attempts; i++) {
    const [poolAcc, mAcc] = await rpc.getMultipleAccounts([poolAddress, mint]);
    decoded = decodePool(poolAddress, mint, poolAcc ?? null);
    mintAcc = mAcc ?? null;
    if (decoded.ok && mintAcc) break;
    if (!decoded.ok && !decoded.retry) throw new Error(decoded.reason);
    if (i < attempts - 1) await (o.sleep ?? sleep)(o.retryMs ?? 1_000);
  }
  if (!decoded?.ok) throw new Error(decoded?.reason ?? "pool not read");
  if (!mintAcc) throw new Error("mint account not found");
  const pool = decoded.pool;
  const { supply } = mintInfo(mintAcc.data);

  const [baseVault, quoteVault] = await rpc.getMultipleAccounts([pool.baseVault, pool.quoteVault]);
  if (!baseVault || !quoteVault) throw new Error("pool vaults not readable");
  const baseRaw = tokenAccountAmount(baseVault.data);
  const quoteLamports = tokenAccountAmount(quoteVault.data);

  // Public endpoints often refuse this method; the alert still goes out, flagged.
  let holders: HolderStats | null = null;
  try {
    const largest = await rpc.getTokenLargestAccounts(mint);
    holders = holderConcentration(largest, supply, new Set([pool.baseVault]));
  } catch {
    holders = null;
  }

  return {
    mint,
    signature,
    pool: poolAddress,
    poolSol: Number(quoteLamports) / 1e9,
    poolTokenPct: supply > 0n ? (Number(baseRaw) / Number(supply)) * 100 : Number.NaN,
    mayhem: pool.mayhem,
    cashback: pool.cashback,
    holders,
    detectedAt: new Date(startedAt).toISOString(),
    inspectMs: Date.now() - startedAt,
  };
}
