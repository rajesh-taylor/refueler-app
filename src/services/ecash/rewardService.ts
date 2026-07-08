/**
 * rewardService.ts
 * Orchestrates the ecash loyalty reward flow triggered after Lightning
 * payment settlement.
 *
 * Flow:
 *   1. OrderStatusScreen detects order → PAID via Supabase Realtime
 *   2. rewardService.claimReward(orderId, rewardSats) is called
 *   3. App creates a mint quote → gets BOLT11 invoice
 *   4. App sends {orderId, bolt11, amountSats} to pay-reward-invoice Edge Function
 *   5. Edge Function validates order ownership, pays BOLT11 via Blink, marks reward_status = 'pending'
 *   6. Coco's background watcher detects quote paid → executes → tokens on-device
 *   7. rewardService polls for completion and returns
 *
 * Privacy contract:
 *   - The BOLT11 invoice sent to the server contains NO user identity
 *   - The mint issues tokens via blind signatures — unlinkable to the invoice
 *   - Supabase stores: orderId + reward_status ('pending'|'settled') only
 *   - No token data, no proof secrets, no ecash pubkeys ever reach Supabase
 */

import { supabase } from '../supabaseClient.native';
import {
  prepareMintQuote,
  executeMintQuote,
  getEcashBalance,
  getCoco,
  REFUELER_MINT_URL,
} from './cocoService';

// ─── Types ───────────────────────────────────────────────────────────────────

export type RewardResult =
  | { status: 'settled'; amountSats: number; newBalance: number }
  | { status: 'already_claimed' }
  | { status: 'error'; reason: string };

// ─── Reward amounts ──────────────────────────────────────────────────────────

/** Reward sats per completed order. Configurable; hardcoded for beta. */
export const REWARD_SATS_PER_ORDER = 21;

// ─── Core reward claim ───────────────────────────────────────────────────────

/**
 * Claim the ecash loyalty reward for a settled order.
 * Safe to call multiple times — idempotent via server-side reward_status check.
 *
 * @param orderId - The Supabase order UUID
 * @param rewardSats - Sats to issue (defaults to REWARD_SATS_PER_ORDER)
 */
export async function claimReward(
  orderId: string,
  rewardSats: number = REWARD_SATS_PER_ORDER,
): Promise<RewardResult> {
  try {
    // 1. Check if reward already issued server-side (fast exit)
    const { data: order, error: fetchErr } = await supabase
      .from('orders')
      .select('ecash_reward_status')
      .eq('id', orderId)
      .single();

    if (fetchErr) return { status: 'error', reason: fetchErr.message };
    if (order?.ecash_reward_status === 'settled') return { status: 'already_claimed' };

    // 2. Prepare mint quote on-device
    const { bolt11, operationId, quoteId } = await prepareMintQuote(rewardSats);

    // 3. Ask the server to pay the BOLT11 via Blink
    const { data: payResult, error: payErr } = await supabase.functions.invoke(
      'pay-reward-invoice',
      {
        body: {
          order_id: orderId,
          bolt11,
          amount_sats: rewardSats,
          quote_id: quoteId,
        },
      },
    );

    if (payErr || !payResult?.ok) {
      return {
        status: 'error',
        reason: payResult?.error ?? payErr?.message ?? 'payment failed',
      };
    }

    // 4. Execute the mint operation (claim tokens).
    // The Coco background watcher may have already done this —
    // executeMintQuote() is idempotent if already executed.
    try {
      await executeMintQuote(operationId);
    } catch (e: any) {
      // Watcher may have beaten us to it — confirm by checking balance
      const manager = getCoco();
      const op = await manager.ops.mint.getOperation(operationId);
      if (!op || (op as any).state === 'issued') {
        // Tokens are in wallet, this is fine
      } else {
        return { status: 'error', reason: e?.message ?? 'mint execution failed' };
      }
    }

    // 5. Report success
    const newBalance = await getEcashBalance();
    return { status: 'settled', amountSats: rewardSats, newBalance };
  } catch (err: any) {
    return { status: 'error', reason: err?.message ?? 'unknown error' };
  }
}

// ─── Realtime trigger ─────────────────────────────────────────────────────────

/**
 * Subscribe to order status changes and automatically claim rewards
 * when an order transitions to PAID.
 *
 * Call once after Coco is initialised. Returns an unsubscribe function.
 * Designed to run inside OrderStatusScreen or a global app-level hook.
 */
export function subscribeToOrderRewards(
  orderId: string,
  onReward: (result: RewardResult) => void,
): () => void {
  const channel = supabase
    .channel(`order-reward:${orderId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'orders',
        filter: `id=eq.${orderId}`,
      },
      async (payload) => {
        const newRow = payload.new as any;
        if (
          newRow.payment_status === 'PAID' &&
          newRow.ecash_reward_status === 'pending_claim'
        ) {
          const result = await claimReward(orderId, REWARD_SATS_PER_ORDER);
          onReward(result);
        }
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// ─── Balance helper (UI convenience) ─────────────────────────────────────────

export { getEcashBalance, REFUELER_MINT_URL };
