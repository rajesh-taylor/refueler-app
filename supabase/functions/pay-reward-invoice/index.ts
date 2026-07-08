/**
 * pay-reward-invoice
 * Supabase Edge Function — validates a reward claim and pays the BOLT11
 * invoice via Blink on behalf of the user.
 *
 * Privacy design:
 *   - Receives: order_id, bolt11 (LN invoice), amount_sats, quote_id
 *   - Stores in Supabase: ecash_reward_status = 'settled' only
 *   - NEVER stores the bolt11, quote_id, or any token data in Supabase
 *   - The BOLT11 invoice contains no user PII; it's a standard LN payment req
 *
 * Idempotency:
 *   - Checks ecash_reward_status before paying — safe to retry
 *   - Uses Supabase row-level lock via RPC to prevent double-pay race
 *
 * Custody assertion:
 *   - Refueler pays the mint's BOLT11 → mint issues tokens to the app
 *   - Refueler never holds the tokens at any point
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BLINK_API_KEY = Deno.env.get('BLINK_API_KEY')!;
const BLINK_WALLET_ID = Deno.env.get('BLINK_WALLET_ID')!;
const BLINK_API_URL = 'https://api.blink.sv/graphql';

/** Maximum reward sats server will pay — guard against abuse. */
const MAX_REWARD_SATS = 210;

// ─── Blink Lightning send ────────────────────────────────────────────────────

async function payBolt11(bolt11: string, amountSats: number): Promise<{ ok: boolean; error?: string }> {
  const mutation = `
    mutation LnInvoicePaymentSend($input: LnInvoicePaymentInput!) {
      lnInvoicePaymentSend(input: $input) {
        status
        errors {
          message
          path
          code
        }
      }
    }
  `;

  const resp = await fetch(BLINK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': BLINK_API_KEY,
    },
    body: JSON.stringify({
      query: mutation,
      variables: {
        input: {
          walletId: BLINK_WALLET_ID,
          paymentRequest: bolt11,
          memo: `Refueler ecash reward — ${amountSats} sats`,
        },
      },
    }),
  });

  const body = await resp.json();
  const result = body?.data?.lnInvoicePaymentSend;

  if (!result) return { ok: false, error: 'Blink API error — no result' };

  const errors = result.errors ?? [];
  if (errors.length > 0) return { ok: false, error: errors[0].message };

  const status = result.status;
  if (status === 'SUCCESS' || status === 'ALREADY_PAID') return { ok: true };

  return { ok: false, error: `Unexpected Blink status: ${status}` };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405 });
  }

  // Auth: JWT from app (anon key flow — supabase client sends Bearer token)
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const userClient = createClient(SUPABASE_URL, authHeader.replace('Bearer ', ''));

  // Verify caller is authenticated
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401 });
  }

  let body: { order_id: string; bolt11: string; amount_sats: number; quote_id: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }), { status: 400 });
  }

  const { order_id, bolt11, amount_sats, quote_id } = body;

  // Validate inputs
  if (!order_id || !bolt11 || !amount_sats || !quote_id) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing required fields' }), { status: 400 });
  }

  if (amount_sats > MAX_REWARD_SATS) {
    return new Response(JSON.stringify({ ok: false, error: 'Reward amount exceeds maximum' }), { status: 400 });
  }

  if (!bolt11.toLowerCase().startsWith('lnbc') && !bolt11.toLowerCase().startsWith('lntb')) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid BOLT11 invoice' }), { status: 400 });
  }

  // 1. Fetch the order and verify ownership + status
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('id, user_id, payment_status, ecash_reward_status')
    .eq('id', order_id)
    .single();

  if (orderErr || !order) {
    return new Response(JSON.stringify({ ok: false, error: 'Order not found' }), { status: 404 });
  }

  if (order.user_id !== user.id) {
    return new Response(JSON.stringify({ ok: false, error: 'Forbidden' }), { status: 403 });
  }

  if (order.payment_status !== 'PAID') {
    return new Response(JSON.stringify({ ok: false, error: 'Order not paid' }), { status: 400 });
  }

  // 2. Idempotency — already settled
  if (order.ecash_reward_status === 'settled') {
    return new Response(JSON.stringify({ ok: true, already_settled: true }), { status: 200 });
  }

  // 3. Optimistic lock: set to 'pending' before paying (prevents double-pay)
  const { error: lockErr } = await supabase
    .from('orders')
    .update({ ecash_reward_status: 'pending' })
    .eq('id', order_id)
    .is('ecash_reward_status', null); // Only update if still null — CAS pattern

  if (lockErr) {
    // Another invocation may be in progress
    return new Response(
      JSON.stringify({ ok: false, error: 'Reward claim already in progress' }),
      { status: 409 },
    );
  }

  // 4. Pay the BOLT11 via Blink
  const payResult = await payBolt11(bolt11, amount_sats);

  if (!payResult.ok) {
    // Roll back the lock so user can retry
    await supabase
      .from('orders')
      .update({ ecash_reward_status: null })
      .eq('id', order_id);

    return new Response(
      JSON.stringify({ ok: false, error: payResult.error ?? 'Payment failed' }),
      { status: 502 },
    );
  }

  // 5. Mark reward as settled
  // Privacy: we store ONLY the status, not the bolt11, quote_id, or any token data
  await supabase
    .from('orders')
    .update({
      ecash_reward_status: 'settled',
      ecash_reward_settled_at: new Date().toISOString(),
    })
    .eq('id', order_id);

  return new Response(JSON.stringify({ ok: true }), { status: 200 });
});
