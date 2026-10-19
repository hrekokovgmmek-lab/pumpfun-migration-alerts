import { PublicKey } from "@solana/web3.js";

export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMPSWAP_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const WSOL = "So11111111111111111111111111111111111111112";

/** First 8 bytes of every PumpSwap `Pool` account (Anchor discriminator). */
export const POOL_DISCRIMINATOR = "f19a6d0411b16dbc";
/** The pool layout published in the program's IDL ends here; new fields are appended after it, so older offsets never move. */
export const POOL_MIN_SIZE = 245;

const OFFSET = {
  baseMint: 43,
  quoteMint: 75,
  baseVault: 139,
  quoteVault: 171,
  mayhem: 243,
  cashback: 244,
} as const;

/**
 * Address of the pool pump.fun creates on migration — derived, not searched for.
 *   authority = PDA(["pool-authority", mint], pump)
 *   pool      = PDA(["pool", u16 0, authority, mint, WSOL], PumpSwap)
 */
export function canonicalPoolAddress(mint: string): string {
  const m = new PublicKey(mint);
  const [authority] = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), m.toBuffer()], PUMP_PROGRAM);
  const index = Buffer.alloc(2);
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), index, authority.toBuffer(), m.toBuffer(), new PublicKey(WSOL).toBuffer()],
    PUMPSWAP_PROGRAM,
  );
  return pool.toBase58();
}

export interface PoolState {
  address: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  mayhem: boolean;
  cashback: boolean;
}

export type PoolDecode = { ok: true; pool: PoolState } | { ok: false; reason: string; retry: boolean };

const key = (data: Buffer, at: number) => new PublicKey(data.subarray(at, at + 32)).toBase58();

export function decodePool(address: string, mint: string, acc: { owner: string; data: Buffer } | null): PoolDecode {
  if (!acc) return { ok: false, reason: "pool account not found yet", retry: true };
  if (acc.owner !== PUMPSWAP_PROGRAM.toBase58()) return { ok: false, reason: "account is not owned by PumpSwap", retry: false };
  if (acc.data.length < POOL_MIN_SIZE) return { ok: false, reason: `pool account is ${acc.data.length} bytes`, retry: true };
  if (acc.data.subarray(0, 8).toString("hex") !== POOL_DISCRIMINATOR) return { ok: false, reason: "not a Pool account", retry: false };
  const baseMint = key(acc.data, OFFSET.baseMint);
  if (baseMint !== mint) return { ok: false, reason: "pool base mint does not match", retry: false };
  const quoteMint = key(acc.data, OFFSET.quoteMint);
  if (quoteMint !== WSOL) return { ok: false, reason: "pool is not quoted in SOL", retry: false };
  return {
    ok: true,
    pool: {
      address,
      baseMint,
      quoteMint,
      baseVault: key(acc.data, OFFSET.baseVault),
      quoteVault: key(acc.data, OFFSET.quoteVault),
      mayhem: acc.data[OFFSET.mayhem] === 1,
      cashback: acc.data[OFFSET.cashback] === 1,
    },
  };
}

/** Raw amount of an SPL / Token-2022 token account (u64 at offset 64). */
export function tokenAccountAmount(data: Buffer): bigint {
  return data.readBigUInt64LE(64);
}

/** Supply (u64 at 36) and decimals (u8 at 44) of an SPL / Token-2022 mint. */
export function mintInfo(data: Buffer): { supply: bigint; decimals: number } {
  return { supply: data.readBigUInt64LE(36), decimals: data[44] ?? 0 };
}
