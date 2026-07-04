import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

/**
 * login-callback.tsx
 *
 * This screen exists purely so Expo Router has somewhere to land when the
 * OS hands it a refuelerapp://login-callback?code=... URL — without this
 * file, Router shows its own "Unmatched Route" 404 on top of the real flow.
 *
 * The actual PKCE code exchange is NOT done here. It's already handled
 * globally by initDeepLinkListener() in deepLinkHandler.ts (wired up in
 * _layout.tsx), which listens on the same URL via React Native's Linking
 * API and calls exchangeCodeForSession() directly. That listener fires
 * independently of whatever screen Router decides to show.
 *
 * So this screen's only job is to be a friendly "Signing you in..." holding
 * screen for the brief moment before the session is established, then
 * send the user home. It does not read the `code` param itself.
 */
export default function LoginCallbackScreen() {
  useEffect(() => {
    // Give deepLinkHandler a moment to finish exchangeCodeForSession(),
    // then move off this screen. If the user already has an established
    // session by the time they land here, this just feels instant.
    const timeout = setTimeout(() => {
      router.replace('/');
    }, 600);

    return () => clearTimeout(timeout);
  }, []);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ActivityIndicator size="large" />
        <ThemedText type="default" style={styles.label}>
          Signing you in…
        </ThemedText>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  label: {
    opacity: 0.7,
  },
});
