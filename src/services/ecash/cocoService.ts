/**
 * cocoService.ts
 * Device-side Cashu ecash layer for Refueler.
 * Uses @cashu/coco-expo-sqlite (expo-sqlite adapter) so tokens
 * live entirely on-device — never in Supabase.
 *
 * Seed: 32 random bytes generated once, stored in Keychain under
 * key 'refueler.ecash.seed'. Completely separate from the Lightning
 * address wallet seed. Never transmitted to any server.
 */

import * as Keychain from 'react-native-keychain';
import * as ExpoSQLite from 'expo-sqlite';
import {
  initializeCoco,
  ConsoleLogger,
  type Manager,
} from '@cashu/coco-core';
import {
  ExpoSqliteRepositories,
  ensureSchema,
} from '@cashu/coco-expo-sqlite';

// ─── Constants ──────────────────────────────────────────────────────────────

const KEYCHAIN_SERVICE = 'io.refueler.app';
const KEYCHAIN_KEY = 'ecash_seed';
const DB_NAME = 'refueler-ecash.db';

/**
 * The mint Refueler uses for loyalty ecash tokens.
 * Beta: Minibits public mint (NUT-11 + NUT-17 supported).
 * Long-term: replace with self-hosted nutshell once operational.
 * NEVER change this without migrating existing on-device proofs first.
 */
export const REFUELER_MINT_URL = 'REFUELER_INTERNAL_MINT_URL_PENDING';

/** Unit for all Refueler ecash (sats). */
export const ECASH_UNIT = 'sat';

// ─── Singleton ───────────────────────────────────────────────────────────────

let _manager: Manager | null = null;

// ─── Seed helpers ────────────────────────────────────────────────────────────

/**
 * Loads or generates the ecash wallet seed.
 * Stored in Keychain — never in Supabase, AsyncStorage, or any remote store.
 */
async function getOrCreateEcashSeed(): Promise<Uint8Array> {
  // Try loading existing seed
  const existing = await Keychain.getGenericPassword({
    service: KEYCHAIN_SERVICE,
    account: KEYCHAIN_KEY,
  } as any);

  if (existing) {
    // Stored as hex
    const hex = existing.password;
    return Uint8Array.from(Buffer.from(hex, 'hex'));
  }

  // Generate fresh 32-byte seed
  const seedBytes = new Uint8Array(32);
  // Use crypto.getRandomValues — available in Hermes/RN via polyfill
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(seedBytes);
  } else {
    // Fallback: Math.random (weaker, flag for review)
    for (let i = 0; i < 32; i++) seedBytes[i] = Math.floor(Math.random() * 256);
  }

  const hex = Buffer.from(seedBytes).toString('hex');
  await Keychain.setGenericPassword(KEYCHAIN_KEY, hex, {
    service: KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  } as any);

  return seedBytes;
}

// ─── Initialisation ──────────────────────────────────────────────────────────

/**
 * Initialise the Coco manager. Call once at app startup (e.g., in App.tsx
 * after Keychain is confirmed available). Subsequent calls return the
 * cached manager.
 */
export async function initCoco(): Promise<Manager> {
  if (_manager) return _manager;

  // 1. Open expo-sqlite database
  const database = await ExpoSQLite.openDatabaseAsync(DB_NAME, {
    useNewConnection: false,
  });

  // 2. Build repositories
  const repos = new ExpoSqliteRepositories({ database });

  // 3. Run schema migrations
  await ensureSchema(repos.db);

  // 4. Build seed getter (lazy — only called when Coco needs keys)
  const seedGetter = () => getOrCreateEcashSeed();

  // 5. Initialise Coco manager
  const logger = new ConsoleLogger('refueler-ecash', { level: __DEV__ ? 'debug' : 'warn' });

  _manager = await initializeCoco({
    repo: repos,
    seedGetter,
    logger,
    // Watchers: enable proof-state watcher (NUT-17 WebSocket + polling fallback)
    // so tokens settle without manual polling.
    watchers: {
      mintOperationWatcher: { disabled: false, watchExistingPendingOnStart: true },
      proofStateWatcher: { disabled: false, watchExistingInflightOnStart: true },
    },
    subscriptions: {
      // Poll every 5 s when WS unavailable (mobile network resilience)
      fastPollingIntervalMs: 5_000,
      slowPollingIntervalMs: 20_000,
    },
  });

  // 6. Register the Refueler mint (no-op if already known)
  await _manager.mint.addMint(REFUELER_MINT_URL);

  return _manager;
}

/**
 * Returns the cached manager. Throws if initCoco() has not been called.
 */
export function getCoco(): Manager {
  if (!_manager) throw new Error('[ecash] Coco not initialised — call initCoco() first');
  return _manager;
}

// ─── Balance ─────────────────────────────────────────────────────────────────

/** Total spendable ecash balance in sats. */
export async function getEcashBalance(): Promise<number> {
  const manager = getCoco();
  const snapshot = await manager.wallet.balances.total();
  return snapshot.spendable;
}

/** Balance at the Refueler mint specifically. */
export async function getRefuelerMintBalance(): Promise<number> {
  const manager = getCoco();
  const byMint = await manager.wallet.balances.byMint();
  return byMint[REFUELER_MINT_URL]?.spendable ?? 0;
}

// ─── Token receipt (reward issuance path) ────────────────────────────────────

/**
 * Step 1 of reward flow: create a mint quote at the Refueler mint.
 * Returns the BOLT11 invoice to be paid by the Refueler server,
 * plus the operationId needed to claim tokens after payment.
 *
 * Privacy: this BOLT11 is sent to the Refueler Edge Function only.
 * The mint cannot link the resulting tokens to this invoice once
 * blind signatures are applied.
 */
export async function prepareMintQuote(amountSats: number): Promise<{
  bolt11: string;
  operationId: string;
  quoteId: string;
}> {
  const manager = getCoco();

  const pendingMint = await manager.ops.mint.prepare({
    mintUrl: REFUELER_MINT_URL,
    amount: amountSats,
    method: 'bolt11',
    methodData: {},
  });

  // pendingMint.request is the BOLT11 invoice
  // pendingMint.quoteId is the mint's quote identifier
  // pendingMint.id is our local operation ID
  return {
    bolt11: (pendingMint as any).request as string,
    operationId: pendingMint.id,
    quoteId: (pendingMint as any).quoteId as string,
  };
}

/**
 * Step 3 of reward flow: once the Refueler server confirms the BOLT11
 * was paid, execute the mint operation to claim tokens on-device.
 * The Coco background watcher will usually do this automatically;
 * call this for immediate confirmation.
 */
export async function executeMintQuote(operationId: string): Promise<void> {
  const manager = getCoco();
  await manager.ops.mint.execute(operationId);
}

// ─── Token spending (redemption path) ────────────────────────────────────────

/**
 * Redeem ecash for sats over Lightning.
 * User provides a BOLT11 invoice (e.g., generated from their own wallet).
 * No user-identifying data touches Supabase in this flow — it's a
 * direct wallet-to-mint-to-Lightning settlement.
 */
export async function redeemForLightning(bolt11: string): Promise<void> {
  const manager = getCoco();

  const meltOp = await manager.ops.melt.prepare({
    mintUrl: REFUELER_MINT_URL,
    paymentRequest: bolt11,
    method: 'bolt11',
    methodData: {},
  });

  await manager.ops.melt.execute(meltOp.id);
}

/**
 * Send ecash tokens to another Cashu user (e.g., another Refueler
 * commuter or a merchant accepting Cashu). Returns an encoded
 * cashuA... token string.
 *
 * NUT-11 P2PK: pass targetPubkeyHex to lock the token to a recipient's
 * public key (prevents interception). If omitted, token is bearer.
 */
export async function sendEcashToken(
  amountSats: number,
  targetPubkeyHex?: string,
): Promise<string> {
  const manager = getCoco();

  const sendOp = await manager.ops.send.prepare({
    mintUrl: REFUELER_MINT_URL,
    amount: amountSats,
    method: targetPubkeyHex ? 'p2pk' : 'default',
    ...(targetPubkeyHex ? { methodData: { pubkey: targetPubkeyHex } } : {}),
  } as any);

  const result = await manager.ops.send.execute(sendOp.id);
  // result.token is the cashuA... encoded token string
  return (result as any).token as string;
}

/**
 * Receive a cashuA... encoded token string (e.g., received from another
 * Refueler user or a merchant reward). Tokens are swapped at the mint
 * for fresh proofs (breaks the link to the original sender).
 */
export async function receiveEcashToken(encodedToken: string): Promise<number> {
  const manager = getCoco();

  const receiveOp = await manager.ops.receive.prepare({ token: encodedToken });
  const result = await manager.ops.receive.execute(receiveOp.id);

  return (result as any).amount as number;
}

// ─── History ─────────────────────────────────────────────────────────────────

/** Last N ecash history entries (mint + melt + send + receive). */
export async function getEcashHistory(limit = 20) {
  const manager = getCoco();
  return manager.history.list({ limit });
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/** Call on app teardown / logout. Does NOT delete proofs. */
export async function teardownCoco(): Promise<void> {
  _manager = null;
}
