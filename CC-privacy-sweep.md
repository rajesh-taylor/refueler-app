# CC-privacy-sweep — Privacy Audit Report
**Repo:** rajesh-taylor/refueler-app @ main  
**Date:** 7 July 2026  
**Files audited:** supabaseClient.native.ts, walletStorage.ts, deepLinkHandler.ts, WalletSetupScreen.tsx, PreOrderScreen.tsx, order-status.tsx, login-test.tsx, login-callback.tsx, app-tabs.tsx, _layout.tsx, app.json, package.json, .gitignore

---

## CRITICAL

### C-1 — `console.log` leaks user Lightning address in production
**Files:** `src/lib/walletStorage.ts` lines ~92, ~123, ~148 | `src/screens/WalletSetupScreen.tsx` line ~247

In `walletStorage.ts`, the actual Lightning address (e.g. `rajesh@minibits.cash`) is written to the console at `console.log` level on both save and load — in plaintext:

```ts
// walletStorage.ts ~L92
console.log('[walletStorage] Synced lightning_address to user_profiles:', trimmed);

// walletStorage.ts ~L123
console.log('[walletStorage] Loaded lightning address from Keychain:', credentials.password);

// walletStorage.ts ~L148  
console.log('[walletStorage] Loaded lightning address from Supabase (re-caching to Keychain):', data.lightning_address);
```

```ts
// WalletSetupScreen.tsx ~L247
console.log('[WalletSetupScreen] Pre-loaded saved lightning address:', result.lightningAddress);
// ~L268
console.log('[WalletSetupScreen] Wallet saved successfully:', address, description ? `(${description})` : '');
```

On Android, `console.log` output is readable via `adb logcat` without root on debug builds, and on some devices is accessible to other apps with `READ_LOGS` permission. On GrapheneOS this risk is reduced but the logs remain in the Metro/device buffer during development and could persist in crash reporters if one is added later.

**Lightning addresses are de facto pseudonymous identifiers** — they uniquely link a user to a payment endpoint and may correlate with their Nostr identity (e.g. via NIP-57). This is PII under GDPR/UK GDPR.

**Fix:** Gate all Lightning address logging behind a `__DEV__` check:
```ts
if (__DEV__) console.log('[walletStorage] Loaded lightning address from Keychain:', credentials.password);
```

---

### C-2 — `console.log` leaks authenticated user email
**Files:** `src/lib/deepLinkHandler.ts` line ~65

```ts
console.log(
  '[deepLinkHandler] Session established for',
  data.session?.user?.email ?? '(no email on session)',
);
```

This logs the authenticated user's email address every time a PKCE session is established — i.e. every sign-in. Same logcat exposure risk as C-1. Email is unambiguously PII.

**Fix:**
```ts
if (__DEV__) {
  console.log('[deepLinkHandler] Session established for', data.session?.user?.email ?? '(no email)');
}
```

---

### C-3 — User email logged in `login-test.tsx` with `emailRedirectTo` visible
**File:** `src/app/login-test.tsx` line ~103

```ts
console.log(`[login-test] Magic link requested for ${trimmed} → redirectTo=${redirectTo}`);
```

Logs the user's email in plaintext on every magic-link request. This file is currently the production `index` route (`src/app/index.tsx` exports `login-test`), so this log fires in production for every real user sign-in attempt.

**Fix:** Remove or `__DEV__`-gate. The `login-test` screen itself is also an open issue — see R-1 below.

---

## HIGH

### H-1 — `SUPABASE_URL` hardcoded in `PreOrderScreen.tsx` (duplicate constant, drift risk)
**File:** `src/screens/PreOrderScreen.tsx` line ~30

```ts
const SUPABASE_URL = 'https://tihgvdokeofnjxjkenmm.supabase.co';
```

This is a second hardcoded copy of the Supabase project URL, separate from `supabaseClient.native.ts`. It's used to construct the `create-order` Edge Function endpoint directly. It is not secret (the anon key is what gates access), but it exposes the project reference ID as a string literal in a second location that could fall out of sync. More importantly, it means the create-order call **bypasses the shared Supabase client** and constructs its own `fetch` — which means no client-level request interceptors, no unified error handling, and harder to audit.

**Fix:** Extract the URL into a single shared constant (e.g. `src/constants/supabase.ts`) and import it in both `supabaseClient.native.ts` and `PreOrderScreen.tsx`. Or use a Supabase Edge Function invocation via the client:
```ts
const { data, error } = await supabase.functions.invoke('create-order', { body: {...} });
```

---

### H-2 — `order-status.tsx` imports `supabaseClient` without `.native` suffix — missing file
**File:** `src/app/order-status.tsx` line ~19

```ts
import { supabase } from '../lib/supabaseClient';
```

This import path (`supabaseClient.ts`, not `supabaseClient.native.ts`) resolves to a file that **does not exist** in the committed repo. On Android/iOS with Metro bundler, this will either throw a bundle error or silently resolve to `undefined`, meaning the realtime subscriptions and order fetch in this screen are non-functional. This is both a privacy gap (if a fallback to a less-secure client is ever introduced) and a correctness bug.

**Fix:** Change the import to:
```ts
import { supabase } from '../lib/supabaseClient.native';
```

---

### H-3 — Realtime subscription on `rail_signal_current` uses no user-scoped filter
**File:** `src/app/order-status.tsx` lines ~163–176

```ts
const railSub = supabase
  .channel('rail-signal')
  .on(
    'postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'rail_signal_current' },
    (payload) => { ... }
  )
  .subscribe();
```

The `rail_signal_current` subscription has **no filter** — it listens for any UPDATE on the entire table. Every realtime event for every station fires in every connected user's client. The client-side check `if (payload.new.station_crs === order?.venue_id)` is a UI filter only, not a data access filter. All payload data (station codes, departure minutes, platform numbers) is received and processed client-side for every update regardless of the user's actual station.

This is acceptable if `rail_signal_current` contains no PII and is considered public operational data (which it is — Darwin data). But it is worth noting because any future addition of PII to this table (e.g. passenger counts, named services) would leak to all connected clients without a code change.

**Fix for now:** Document this as intentionally public data. When the `venue_partners.station_crs` is known at subscribe time, consider adding a server-side filter: `filter: \`station_crs=eq.${stationCrs}\`` — this also reduces unnecessary payload traffic per client.

---

### H-4 — `orders` table queried directly from consumer client in `order-status.tsx`
**File:** `src/app/order-status.tsx` lines ~99–118

```ts
const { data, error } = await supabase
  .from('orders')
  .select(`id, status, venue_id, items, total_sats, routing_fee_sats, created_at,
           venue_partners (name, location_label, station_crs)`)
  .eq('id', orderId)
  .single();
```

The standing architectural rule (locked CC-29+) is that **merchants read from `merchant_orders` only, never `orders` directly**. The consumer app is allowed to read its own orders from `orders`, but this query:

1. Requires an RLS policy on `orders` that allows the consumer to select their own rows. This policy must be strictly `auth.uid() = user_id`. If it is missing or too permissive, users could enumerate other users' orders.
2. Pulls `venue_partners` via a join — this requires either a separate RLS policy on `venue_partners` or a `SECURITY DEFINER` function. If `venue_partners` has an open SELECT policy (not uncommon for reference data), this is fine; if not, this join silently returns null and the venue name is missing.

**Action:** Verify via Supabase MCP next session that:
- `orders` has RLS policy `order_read_own` with `auth.uid() = user_id`  
- `venue_partners` SELECT is permitted for authenticated users (or anonymous, since it's non-sensitive reference data)

---

## MEDIUM

### M-1 — `login-test.tsx` is the production index route
**File:** `src/app/index.tsx`

```ts
export { default } from "./login-test";
```

The CC-46 test login screen — complete with debug annotations, Metro console instructions, and a footnote rendering `redirectTo` in the UI — is the production landing screen. It contains `console.log` calls that leak email addresses (covered in C-3) and presents internal implementation notes to any user who looks at the screen text.

**Fix:** Replace with a real onboarding/login screen before beta, or at minimum remove the `console.log` calls and the debug footnote rendering `redirectTo` on-screen.

---

### M-2 — `redirectTo` in `login-test.tsx` uses HTTPS redirect (not deep link scheme)
**File:** `src/app/login-test.tsx` line ~52

```ts
const redirectTo = 'https://refueler.io?mobileAuth=1';
```

This is intentionally set to the HTTPS URL (not `refuelerapp://login-callback`) based on the CC-46 auth-proxy setup. However, this means the magic-link email contains an HTTPS link. If a user opens this link on a **different device** (e.g. desktop), they will hit the web at `refueler.io?mobileAuth=1` — which has no handler for this flow, and the `mobileAuth=1` param silently does nothing. The PKCE code in that case is consumed by a browser session, not the app. No data is leaked, but the auth flow silently fails on cross-device opens.

Not a data leak, but worth noting as a UX/security degradation path.

---

### M-3 — Venue UUID identifiers hardcoded in client bundle
**File:** `src/screens/PreOrderScreen.tsx` lines ~53–85

Real Supabase venue UUIDs are embedded in the client-side `VENUE_MENUS` lookup map (e.g. `'3128956e-47fb-4c7a-a39d-2332c00a4b2d'` for Black Sheep Coffee). These UUIDs are visible in the JavaScript bundle to anyone who decompiles the APK.

These UUIDs gate the hardcoded menu content only — they do not grant database access (that's RLS + auth). However, knowing a venue UUID allows a malicious actor to craft orders for that venue ID without using the app UI, as long as they have a valid auth token. The `create-order` Edge Function is the real gatekeeper here.

This will be resolved naturally when the `menu_items` table migration happens (planned post-CC-62). Until then, accept the risk but note it.

---

### M-4 — No geofence or location code in committed codebase — privacy promise not yet enforced
**Files:** No `useGeofence.ts`, `useLocation.ts`, `src/lib/geofence.ts`, or any `expo-location` dependency found.

The locked privacy wording is: *"Refueler knows your train is moving. Your phone works it out locally. We never see where you are."* The `package.json` does **not** include `expo-location` as a dependency. No location permission is declared in `app.json`. No geofence logic exists in the committed code.

This is actually good from a current-state privacy perspective — no location data is being collected at all. But it means the Horizon Strip / geofence trigger feature described in earlier sessions is not yet implemented. When it is, the following must hold:
- `expo-location` permission must be `WHEN_IN_USE` only, never background
- Location coordinates must never be transmitted off-device (only the derived boolean "within geofence" used locally)
- On-device processing verified with a network inspector before beta

No action needed now — flag for CC-geofence implementation session.

---

## LOW / INFORMATIONAL

### L-1 — Supabase anon key hardcoded in source (expected, but documented)
**Files:** `src/lib/supabaseClient.native.ts` | `src/screens/PreOrderScreen.tsx`

The anon key is a public credential (designed to be shipped in client code) and is correctly used alongside RLS. It is not a secret. However, it is hardcoded in two files. The standing CC-43 rule ("always re-fetch via MCP if file is touched") is the right mitigation. Consider extracting to a shared constant to enforce single-source-of-truth.

---

### L-2 — `app.json` splash background `#208AEF` conflicts with Carbon dark brand
**File:** `app.json`

The splash screen background is `#208AEF` (bright blue) and the `android.adaptiveIcon.backgroundColor` is `#E6F4FE` (light blue). Neither matches the locked Carbon dark (`#1A1A1A`) brand. Not a privacy issue, but the splash leaks the Expo default template origin before brand hardening is complete. Low priority but worth fixing before public beta.

---

### L-3 — `.gitignore` excludes `.env*.local` but no `.env.example` exists
**File:** `.gitignore`

`.env*.local` is correctly gitignored. However there is no `.env.example` in the repo, which means contributors (and future sessions) have no documented list of required environment variables. If secrets ever move to `.env` files, this creates a documentation and onboarding gap.

---

## FINDING SUMMARY

| ID | Severity | Issue | File(s) |
|---|---|---|---|
| C-1 | **CRITICAL** | Lightning address logged to console in production | `walletStorage.ts`, `WalletSetupScreen.tsx` |
| C-2 | **CRITICAL** | User email logged on every sign-in | `deepLinkHandler.ts` |
| C-3 | **CRITICAL** | User email logged in production index route | `login-test.tsx` |
| H-1 | HIGH | `SUPABASE_URL` duplicated in PreOrderScreen | `PreOrderScreen.tsx` |
| H-2 | HIGH | Missing `supabaseClient.ts` — broken import in order-status | `order-status.tsx` |
| H-3 | HIGH | Unfiltered realtime subscription on rail_signal_current | `order-status.tsx` |
| H-4 | HIGH | `orders` RLS policy coverage unverified for consumer client | `order-status.tsx` |
| M-1 | MEDIUM | Debug login screen is production index route | `index.tsx`, `login-test.tsx` |
| M-2 | MEDIUM | `redirectTo` falls back to HTTPS on cross-device opens | `login-test.tsx` |
| M-3 | MEDIUM | Venue UUIDs hardcoded in client bundle | `PreOrderScreen.tsx` |
| M-4 | MEDIUM | Geofence not yet implemented — location privacy promise deferred | *(none)* |
| L-1 | LOW | Anon key in two files | `supabaseClient.native.ts`, `PreOrderScreen.tsx` |
| L-2 | LOW | Splash colour mismatch | `app.json` |
| L-3 | LOW | No `.env.example` | *(absent)* |

---

## RECOMMENDED FIX ORDER FOR NEXT SESSION

**Before beta:** C-1, C-2, C-3 (three one-line `__DEV__` wraps), then H-2 (import fix).  
**Before public marketing:** M-1 (replace login-test with real screen), H-4 (RLS verification via MCP).  
**Post-menu-items migration:** M-3 resolves itself.  
**Geofence session:** M-4 must be revisited with a full location-handling checklist.
