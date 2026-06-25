/**
 * supabaseClient.native.ts
 * PKCE Supabase client for the Refueler React Native app (iOS + Android).
 *
 * Web stays on implicit flow (separate client, separate file) — this client
 * is mobile-only, per the locked rule in claude_v4_1.md §4i / CC-45.
 *
 * Storage: device Keychain (iOS Keychain / Android Keystore via
 * react-native-keychain), never AsyncStorage — session tokens should not
 * sit in plaintext on disk.
 *
 * detectSessionInUrl is false because there is no "URL" in the browser
 * sense on native — the PKCE code arrives via the refuelerapp:// custom
 * scheme and is handled explicitly in deepLinkHandler.ts, which calls
 * supabase.auth.exchangeCodeForSession(code).
 */

import 'react-native-url-polyfill/auto';
import * as Keychain from 'react-native-keychain';
import { createClient, type SupportedStorage } from '@supabase/supabase-js';

// --- Project config -------------------------------------------------------

const SUPABASE_URL = 'https://tihgvdokeofnjxjkenmm.supabase.co';

// Real anon key, pulled live via Supabase MCP get_publishable_keys at CC-45.
// Per the CC-43 standing rule: never leave this as a placeholder, and don't
// reuse an old one verbatim — always re-fetch fresh if this file is touched
// again in a future session.
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpaGd2ZG9rZW9mbmp4amtlbm1tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MTY2NDksImV4cCI6MjA5NDE5MjY0OX0.cRb94WeIP8yRfWd9s2XKmq2nqm1ov-sK1df6u8LNUbo';

// --- Keychain-backed storage adapter --------------------------------------
//
// Supabase's storage interface only needs getItem/setItem/removeItem.
// react-native-keychain stores one username/password pair per "service"
// string, so each Supabase storage key gets its own service namespace.

const KEYCHAIN_SERVICE_PREFIX = 'io.refueler.app.supabase-auth';

function serviceNameFor(key: string): string {
  return `${KEYCHAIN_SERVICE_PREFIX}.${key}`;
}

const KeychainStorageAdapter: SupportedStorage = {
  async getItem(key: string) {
    try {
      const credentials = await Keychain.getGenericPassword({
        service: serviceNameFor(key),
      });
      return credentials ? credentials.password : null;
    } catch (err) {
      console.warn(`[supabaseClient.native] Keychain getItem failed for "${key}"`, err);
      return null;
    }
  },

  async setItem(key: string, value: string) {
    try {
      await Keychain.setGenericPassword(key, value, {
        service: serviceNameFor(key),
      });
    } catch (err) {
      console.warn(`[supabaseClient.native] Keychain setItem failed for "${key}"`, err);
    }
  },

  async removeItem(key: string) {
    try {
      await Keychain.resetGenericPassword({ service: serviceNameFor(key) });
    } catch (err) {
      console.warn(`[supabaseClient.native] Keychain removeItem failed for "${key}"`, err);
    }
  },
};

// --- Client ----------------------------------------------------------------

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: KeychainStorageAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
});
