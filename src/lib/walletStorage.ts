/**
 * walletStorage.ts
 * Persists the user's Lightning address (and future wallet config) using
 * two complementary layers:
 *
 *   1. react-native-keychain  — on-device secure storage, encrypted at rest
 *      via Android Keystore (GrapheneOS) or iOS Keychain. This is the source
 *      of truth for the wallet address locally. Survives app restarts.
 *
 *   2. Supabase user_profiles  — syncs lightning_address and
 *      payment_preference to the server so the backend can use it for
 *      reward dispatch. Only written when a session exists (authenticated
 *      users only). Unauthenticated saves go to Keychain only; the sync
 *      happens on next sign-in.
 *
 * NOTE on Keychain simulator warning (CC-51 / CC-61):
 *   On the iOS simulator, react-native-keychain's getGenericPassword may
 *   return null and log a warning because the sim doesn't have a real
 *   Secure Enclave. This is sim-only behaviour — on a physical device
 *   (including GrapheneOS) the call succeeds silently. No fix needed;
 *   the try/catch below means the app never crashes on this.
 *
 * Keychain service names are namespaced under io.refueler.app.wallet.*
 * to avoid collisions with the Supabase auth tokens stored under
 * io.refueler.app.supabase-auth.*.
 */

import * as Keychain from 'react-native-keychain';
import { supabase } from './supabaseClient.native';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEYCHAIN_SERVICE = 'io.refueler.app.wallet.lightning_address';

// The username field in Keychain is not meaningful here — we're using the
// service namespace pattern. We store a fixed username so getGenericPassword
// can retrieve by service alone.
const KEYCHAIN_USERNAME = 'refueler_wallet';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WalletSaveResult =
  | { success: true }
  | { success: false; error: string };

export type WalletLoadResult =
  | { found: true; lightningAddress: string }
  | { found: false };

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * saveLightningAddress
 *
 * 1. Validates the address has a sane format before touching storage.
 * 2. Writes to on-device Keychain (always).
 * 3. If a Supabase session exists, upserts user_profiles.lightning_address
 *    and sets payment_preference = 'sats'.
 *
 * Returns { success: true } on full success.
 * Returns { success: false, error } if Keychain write fails (Supabase sync
 * failure is logged but does NOT cause a save failure — offline resilience).
 */
export async function saveLightningAddress(
  address: string,
): Promise<WalletSaveResult> {
  const trimmed = address.trim().toLowerCase();

  if (!isValidLightningAddressFormat(trimmed)) {
    return {
      success: false,
      error: 'Not a valid Lightning address format (expected user@domain.tld)',
    };
  }

  // --- 1. Keychain write -----------------------------------------------
  try {
    await Keychain.setGenericPassword(KEYCHAIN_USERNAME, trimmed, {
      service: KEYCHAIN_SERVICE,
      // On Android (GrapheneOS), this maps to Android Keystore.
      // WHEN_UNLOCKED_THIS_DEVICE_ONLY is the correct security level:
      // accessible after first unlock, not backed up to cloud, device-bound.
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown Keychain error';
    console.error('[walletStorage] Keychain write failed:', message);
    return { success: false, error: `Keychain error: ${message}` };
  }

  // --- 2. Supabase sync (best-effort) ----------------------------------
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session?.user?.id) {
      const { error: upsertError } = await supabase
        .from('user_profiles')
        .upsert(
          {
            id: session.user.id,
            lightning_address: trimmed,
            payment_preference: 'sats',
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: 'id',
          },
        );

      if (upsertError) {
        // Log but don't surface to user — local Keychain save already succeeded.
        console.warn(
          '[walletStorage] Supabase sync failed (will retry on next open):',
          upsertError.message,
        );
      } else {
        console.log(
          '[walletStorage] Synced lightning_address to user_profiles:',
          trimmed,
        );
      }
    } else {
      console.log(
        '[walletStorage] No session — Keychain-only save. Will sync on next sign-in.',
      );
    }
  } catch (err) {
    // Network offline, etc. — local save still succeeded.
    console.warn('[walletStorage] Supabase sync threw:', err);
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * loadLightningAddress
 *
 * Reads from Keychain first. If not found locally, attempts to read from
 * Supabase user_profiles (catches the case where user signed in on a new
 * device and hasn't saved locally yet).
 *
 * Returns { found: true, lightningAddress } or { found: false }.
 */
export async function loadLightningAddress(): Promise<WalletLoadResult> {
  // --- 1. Try Keychain first ------------------------------------------
  try {
    const credentials = await Keychain.getGenericPassword({
      service: KEYCHAIN_SERVICE,
    });

    if (credentials && credentials.password) {
      console.log(
        '[walletStorage] Loaded lightning address from Keychain:',
        credentials.password,
      );
      return { found: true, lightningAddress: credentials.password };
    }
  } catch (err) {
    // iOS sim returns null here — this is the known sim-only warning.
    // On a real device this catch is never hit. Safe to log and continue.
    console.warn('[walletStorage] Keychain read returned null (sim-only?):', err);
  }

  // --- 2. Fall back to Supabase (new device / first install) ----------
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session?.user?.id) {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('lightning_address')
        .eq('id', session.user.id)
        .single();

      if (!error && data?.lightning_address) {
        console.log(
          '[walletStorage] Loaded lightning address from Supabase (re-caching to Keychain):',
          data.lightning_address,
        );

        // Re-cache locally so the next load is fast/offline.
        await Keychain.setGenericPassword(
          KEYCHAIN_USERNAME,
          data.lightning_address,
          {
            service: KEYCHAIN_SERVICE,
            accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          },
        ).catch((cacheErr) =>
          console.warn('[walletStorage] Re-cache to Keychain failed:', cacheErr),
        );

        return { found: true, lightningAddress: data.lightning_address };
      }
    }
  } catch (err) {
    console.warn('[walletStorage] Supabase fallback read failed:', err);
  }

  return { found: false };
}

// ---------------------------------------------------------------------------
// Clear (used when user removes wallet in Settings — future session)
// ---------------------------------------------------------------------------

export async function clearLightningAddress(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
  } catch (err) {
    console.warn('[walletStorage] Keychain clear failed:', err);
  }

  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session?.user?.id) {
      await supabase
        .from('user_profiles')
        .update({ lightning_address: null, updated_at: new Date().toISOString() })
        .eq('id', session.user.id);
    }
  } catch (err) {
    console.warn('[walletStorage] Supabase clear failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Validation helpers (exported for use in WalletSetupScreen)
// ---------------------------------------------------------------------------

/**
 * isValidLightningAddressFormat
 * RFC 5321-lite check: local@domain.tld — must have exactly one @,
 * non-empty local and domain parts, domain must contain at least one dot.
 * Intentionally permissive — the live LUD-16 check in WalletSetupScreen
 * is the definitive validator.
 */
export function isValidLightningAddressFormat(address: string): boolean {
  const parts = address.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length < 1) return false;
  if (!domain || !domain.includes('.')) return false;
  // Reject obvious junk
  if (domain.endsWith('.') || domain.startsWith('.')) return false;
  return true;
}

/**
 * validateLightningAddressLive
 * Performs a real LUD-16 LNURL-pay HTTP fetch against the address's domain.
 * Returns { valid: true, minSendable, maxSendable } on success.
 * Returns { valid: false, reason } on failure.
 *
 * Timeout: 6 seconds (CC-51 spec). Uses AbortController.
 *
 * The LUD-16 endpoint is: https://<domain>/.well-known/lnurlp/<local>
 * Spec: https://github.com/lnurl/luds/blob/luds/16.md
 */
export async function validateLightningAddressLive(address: string): Promise<
  | { valid: true; minSendable: number; maxSendable: number; description: string }
  | { valid: false; reason: string }
> {
  const trimmed = address.trim().toLowerCase();

  if (!isValidLightningAddressFormat(trimmed)) {
    return { valid: false, reason: 'Invalid format' };
  }

  const [local, domain] = trimmed.split('@');
  const url = `https://${domain}/.well-known/lnurlp/${local}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return {
        valid: false,
        reason: `Server returned ${res.status} — wallet address may not exist`,
      };
    }

    const json = await res.json();

    // LUD-16 requires: tag === 'payRequest', minSendable, maxSendable (in msats)
    if (json?.tag !== 'payRequest') {
      return {
        valid: false,
        reason: 'Not a valid LNURL-pay endpoint (missing payRequest tag)',
      };
    }

    if (
      typeof json.minSendable !== 'number' ||
      typeof json.maxSendable !== 'number'
    ) {
      return {
        valid: false,
        reason: 'LNURL-pay endpoint missing sendable range',
      };
    }

    return {
      valid: true,
      minSendable: json.minSendable,
      maxSendable: json.maxSendable,
      description: json.metadata ? extractDescriptionFromMetadata(json.metadata) : '',
    };
  } catch (err) {
    clearTimeout(timeout);

    if (err instanceof Error && err.name === 'AbortError') {
      return {
        valid: false,
        reason: 'Timed out after 6s — check your connection or try again',
      };
    }

    const message = err instanceof Error ? err.message : 'Unknown error';
    return { valid: false, reason: `Network error: ${message}` };
  }
}

/**
 * extractDescriptionFromMetadata
 * LUD-16 metadata is a JSON array of [mime, content] pairs.
 * We want the text/plain entry.
 */
function extractDescriptionFromMetadata(metadata: string): string {
  try {
    const parsed: [string, string][] = JSON.parse(metadata);
    const textEntry = parsed.find(([mime]) => mime === 'text/plain');
    return textEntry ? textEntry[1] : '';
  } catch {
    return '';
  }
}
