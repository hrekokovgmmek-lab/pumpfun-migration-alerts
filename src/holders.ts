import type { LargestAccount } from "./rpc.ts";

export interface HolderStats {
  /** Largest token account outside the pool, % of supply. */
  top1Pct: number;
  /** Ten largest token accounts outside the pool, % of supply. */
  top10Pct: number;
  top1Account?: string;
  counted: number;
}

const pct = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 1_000_000n) / whole) / 10_000 : 0);

/**
 * Concentration of supply outside the pool. Counts token accounts, not owners:
 * two accounts of one wallet show up separately, so this is a lower bound.
 */
export function holderConcentration(largest: LargestAccount[], supplyRaw: bigint, exclude: Set<string>): HolderStats {
  const outside = largest
    .filter((a) => !exclude.has(a.address))
    .map((a) => ({ address: a.address, amount: BigInt(a.amount) }))
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  const top1 = outside[0];
  const top10 = outside.slice(0, 10).reduce((sum, a) => sum + a.amount, 0n);
  return {
    top1Pct: top1 ? pct(top1.amount, supplyRaw) : 0,
    top10Pct: pct(top10, supplyRaw),
    top1Account: top1?.address,
    counted: outside.length,
  };
}
