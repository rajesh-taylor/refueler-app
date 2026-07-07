/**
 * deepLinkHandler.ts
 * Catches refuelerapp:// links and completes the PKCE auth flow.
 *
 * Scope note (CC-45): this listens on the custom URL scheme only.
 * Universal Links (https://refueler.io/* opening the app directly without
 * the refuelerapp:// prefix) require the iOS Associated Domains entitlement,
 * which is blocked on the free Apple Developer account — see claude_v4_1.md
 * §4i. That is explicitly out of scope this session and is NOT handled here.
 *
 * Flow:
 *   1. User taps a magic-link email on their phone.
 *   2. Supabase redirects to refuelerapp://login-callback?code=...
 *   3. iOS/Android hands that URL to this app via the custom scheme.
 *   4. We pull `code` out of the URL and hand it to
 *      supabase.auth.exchangeCodeForSession(code), which completes PKCE
 *      and persists the session via the Keychain storage adapter.
 *
 * Wire-up: call initDeepLinkListener() once near the root of the app
 * (e.g. in App.tsx, inside a useEffect on mount), and call its cleanup
 * function on unmount.
 */

import { Linking } from 'react-native';
import { supabase } from './supabaseClient.native';

const URL_SCHEME_PREFIX = 'refuelerapp://';

/**
 * Pulls the PKCE `code` query param out of a refuelerapp:// URL.
 * Using a manual parse rather than the global URL class, since URL parsing
 * support for custom (non-http) schemes is inconsistent across RN/Hermes
 * versions — string splitting on '?' and '&' is more reliable here.
 */
export function extractAuthCode(url: string): string | null {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return null;

  const queryString = url.slice(queryStart + 1);
  const params = new URLSearchParams(queryString);
  return params.get('code');
}

/**
 * Handles a single incoming URL. Safe to call with null (e.g. when there
 * was no cold-start launch URL) — it's a no-op in that case.
 */
export async function handleDeepLink(url: string | null): Promise<void> {
  if (!url) return;

  if (!url.startsWith(URL_SCHEME_PREFIX)) {
    // Not one of ours — ignore rather than throw, in case some other
    // scheme handler is also listening on this Linking subscription.
    return;
  }

  const code = extractAuthCode(url);

  if (!code) {
    // A refuelerapp:// link with no auth code is something other than a
    // login callback (future use: order handoff links, e.g. dad pays /
    // son picks up via shared link — not built yet, deliberately not
    // assumed here). Log and bail rather than guessing.
    console.warn('[deepLinkHandler] refuelerapp:// link with no `code` param — ignoring', url);
    return;
  }

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('[deepLinkHandler] PKCE code exchange failed:', error.message);
    return;
  }

  if (__DEV__) console.log('[deepLinkHandler] Session established for', data.session?.user?.email ?? '(no email on session)');
}

/**
 * Registers the app to listen for refuelerapp:// links, both:
 *  - cold start (app was closed, link opened it) — via getInitialURL()
 *  - warm/foreground (app was already running) — via the 'url' event
 *
 * Returns a cleanup function — call it on unmount to remove the listener.
 */
export function initDeepLinkListener(): () => void {
  // Cold start: app launched directly from a tapped link.
  Linking.getInitialURL()
    .then(handleDeepLink)
    .catch((err) => console.error('[deepLinkHandler] getInitialURL failed:', err));

  // Warm start: app already running, link tapped while it's open/backgrounded.
  const subscription = Linking.addEventListener('url', ({ url }) => {
    handleDeepLink(url).catch((err) =>
      console.error('[deepLinkHandler] handleDeepLink threw:', err),
    );
  });

  return () => subscription.remove();
}
