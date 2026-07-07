/**
 * login-test.tsx
 * CC-46 — standalone test route for verifying the PKCE magic-link flow
 * end-to-end on a real device, cold-start and warm-start.
 *
 * Not the final login screen / IA decision — that's a product call for a
 * future session (where login sits relative to the tab structure, whether
 * it gates the app, etc.). This route exists purely so there's *something*
 * in the app that actually calls supabase.auth.signInWithOtp() — until this
 * file existed, nothing in the codebase did, despite the native client and
 * deepLinkHandler.ts both being fully built and wired since CC-45.
 *
 * Test flow:
 *   1. Run the app on a real device or simulator (never Expo Go — custom
 *      scheme links don't resolve there).
 *   2. Navigate to /login-test.
 *   3. Enter your email, tap "Send magic link".
 *   4. Open the email ON THE SAME DEVICE, tap the link.
 *   5. App should foreground/launch and deepLinkHandler.ts should log
 *      "Session established for <email>" in the Metro/device console.
 *
 * redirectTo is explicitly set to refuelerapp://login-callback — this is
 * already a registered Redirect URL in Supabase Auth → URL Configuration
 * (confirmed present, CC-46). Without this explicit option, Supabase falls
 * back to the Site URL (https://refueler.io) and the link opens a browser
 * instead of deep-linking into the app — that fallback produces no error
 * anywhere, it just silently does the wrong thing, so it's worth knowing
 * about even though it isn't the bug we hit this session.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';

import { supabase } from '@/lib/supabaseClient.native';

// --- Locked brand tokens (claude_v4_1.md §2) — matches WalletSetupScreen.tsx

const COLORS = {
  carbon: '#1A1A1A',
  carbonSurface: '#242424',
  gold: '#C8A96E',
  textPrimary: '#F5F0E8',
  textSecondary: '#A8A29A',
  danger: '#E05252',
  success: '#7FBF7F',
};

const redirectTo = 'https://refueler.io?mobileAuth=1';

type ScreenState = 'idle' | 'sending' | 'sent' | 'error';

export default function LoginTestScreen() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<ScreenState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSendMagicLink() {
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes('@')) {
      setErrorMessage('Enter a valid email address.');
      setState('error');
      return;
    }

    setState('sending');
    setErrorMessage(null);

    const { error } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        emailRedirectTo: redirectTo,
      },
    });

    if (error) {
      console.error('[login-test] signInWithOtp failed:', error.message);
      setErrorMessage(error.message);
      setState('error');
      return;
    }

    if (__DEV__) console.log(`[login-test] Magic link requested for ${trimmed} → redirectTo=${redirectTo}`);
    setState('sent');
  }

  function handleReset() {
    setState('idle');
    setErrorMessage(null);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.content}>
          <Text style={styles.heading}>CC-46 login test</Text>
          <Text style={styles.subheading}>
            PKCE / Svix verification — not the final login screen.{'\n'}
            Open the email on this same device.
          </Text>

          {state === 'sent' ? (
            <View style={styles.statusCard}>
              <Text style={styles.statusTextSuccess}>Magic link sent to {email.trim()}.</Text>
              <Text style={styles.statusSubtext}>
                Check your inbox on this device, then tap the link. Watch the
                Metro console for "[deepLinkHandler] Session established for…".
              </Text>
              <TouchableOpacity style={styles.secondaryButton} onPress={handleReset}>
                <Text style={styles.secondaryButtonText}>Send another</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <TextInput
                style={styles.input}
                placeholder="you@example.com"
                placeholderTextColor={COLORS.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                value={email}
                onChangeText={(text) => {
                  setEmail(text);
                  if (state === 'error') setState('idle');
                }}
                editable={state !== 'sending'}
              />

              {state === 'error' && errorMessage ? (
                <Text style={styles.errorText}>{errorMessage}</Text>
              ) : null}

              <TouchableOpacity
                style={[styles.primaryButton, state === 'sending' && styles.primaryButtonDisabled]}
                onPress={handleSendMagicLink}
                disabled={state === 'sending'}
                activeOpacity={0.8}
              >
                {state === 'sending' ? (
                  <ActivityIndicator color={COLORS.carbon} />
                ) : (
                  <Text style={styles.primaryButtonText}>Send magic link</Text>
                )}
              </TouchableOpacity>
            </>
          )}

          {/* redirectTo footnote removed — CC-privacy-sweep C-3 */}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.carbon,
  },
  flex: {
    flex: 1,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  heading: {
    fontFamily: 'Satoshi',
    fontWeight: '600',
    fontSize: 24,
    color: COLORS.textPrimary,
    marginBottom: 8,
  },
  subheading: {
    fontFamily: 'DM Sans',
    fontWeight: '300',
    fontSize: 14,
    lineHeight: 20,
    color: COLORS.textSecondary,
    marginBottom: 32,
  },
  input: {
    backgroundColor: COLORS.carbonSurface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(200, 169, 110, 0.25)',
    paddingVertical: 14,
    paddingHorizontal: 16,
    fontFamily: 'DM Sans',
    fontSize: 16,
    color: COLORS.textPrimary,
    marginBottom: 16,
  },
  errorText: {
    fontFamily: 'DM Sans',
    fontSize: 13,
    color: COLORS.danger,
    marginBottom: 16,
  },
  primaryButton: {
    backgroundColor: COLORS.gold,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonDisabled: {
    opacity: 0.6,
  },
  primaryButtonText: {
    fontFamily: 'DM Sans',
    fontWeight: '600',
    fontSize: 15,
    color: COLORS.carbon,
  },
  statusCard: {
    backgroundColor: COLORS.carbonSurface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(200, 169, 110, 0.25)',
    padding: 20,
  },
  statusTextSuccess: {
    fontFamily: 'DM Sans',
    fontWeight: '600',
    fontSize: 15,
    color: COLORS.success,
    marginBottom: 8,
  },
  statusSubtext: {
    fontFamily: 'DM Sans',
    fontWeight: '300',
    fontSize: 13,
    lineHeight: 19,
    color: COLORS.textSecondary,
    marginBottom: 16,
  },
  secondaryButton: {
    alignSelf: 'flex-start',
  },
  secondaryButtonText: {
    fontFamily: 'DM Sans',
    fontWeight: '600',
    fontSize: 14,
    color: COLORS.gold,
  },
  footnote: {
    fontFamily: 'DM Sans',
    fontWeight: '300',
    fontSize: 11,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginTop: 28,
  },
});
