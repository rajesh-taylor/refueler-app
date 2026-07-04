/**
 * WalletSetupScreen.tsx  — CC-61 rebuild
 *
 * This is the real wallet setup screen: not a stub. It replaces the CC-45
 * shell entirely and implements the CC-51 spec fully:
 *
 *   OPTION A — "Enter your Lightning address"
 *     - TextInput for user@domain.tld
 *     - Tier 1: immediate format validation (regex, no network)
 *     - Tier 2: live LUD-16 LNURL-pay fetch (6s timeout)
 *     - "Save anyway" escape hatch if live check fails but format is valid
 *     - On success: saves to Keychain + syncs to Supabase user_profiles
 *     - On mount: loads any previously saved address from Keychain
 *
 *   OPTION B — "Connect via NWC" (stub, clearly marked)
 *     - Nostr Wallet Connect — deferred (needs NWC relay library)
 *
 * Design tokens: James Bond / Carbon dark. Gold accent only. No orange.
 * Satoshi headings, DM Sans body. Screen breathes — generous spacing.
 *
 * GrapheneOS note: react-native-keychain uses Android Keystore natively on
 * GrapheneOS (no Play Services required). iOS simulator may log a Keychain
 * null warning — this is sim-only, not a real device issue (CC-61 confirmed).
 *
 * Supabase table: public.user_profiles
 *   - lightning_address  text nullable
 *   - payment_preference text default 'fiat' → set to 'sats' on save
 *   - RLS policy: profile_update_own (confirmed CC-51)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  isValidLightningAddressFormat,
  loadLightningAddress,
  saveLightningAddress,
  validateLightningAddressLive,
} from '../lib/walletStorage';

// ---------------------------------------------------------------------------
// Brand tokens (claude_v4_1.md §2)
// ---------------------------------------------------------------------------

const C = {
  carbon: '#1A1A1A',
  carbonSurface: '#242424',
  carbonBorder: 'rgba(200, 169, 110, 0.18)', // faint gold hairline
  carbonBorderActive: 'rgba(200, 169, 110, 0.55)',
  gold: '#C8A96E',
  goldSubtle: 'rgba(200, 169, 110, 0.12)',
  textPrimary: '#F5F0E8',
  textSecondary: '#A8A29A',
  textTertiary: '#6B6560',
  success: '#4CAF7D',
  successSubtle: 'rgba(76, 175, 125, 0.12)',
  danger: '#E05252',
  dangerSubtle: 'rgba(224, 82, 82, 0.10)',
  inputBg: '#1E1E1E',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActivePanel = 'lightning' | 'nwc' | null;

type ValidationState =
  | { status: 'idle' }
  | { status: 'format_error'; message: string }
  | { status: 'validating' } // live check in progress
  | { status: 'live_ok'; description: string }
  | { status: 'live_fail'; message: string } // live check failed, format was ok
  | { status: 'saved' };

interface WalletSetupScreenProps {
  /** Called after a wallet is successfully configured. Use for navigation. */
  onWalletConfigured?: (type: 'lightning' | 'nwc') => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WalletSetupScreen({
  onWalletConfigured,
}: WalletSetupScreenProps) {
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [lightningInput, setLightningInput] = useState('');
  const [validationState, setValidationState] = useState<ValidationState>({
    status: 'idle',
  });
  const [isSaving, setIsSaving] = useState(false);

  // Animate panel expansion
  const panelAnim = useRef(new Animated.Value(0)).current;

  // ---------------------------------------------------------------------------
  // Load saved address on mount (persistence check)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    async function checkPersistedWallet() {
      const result = await loadLightningAddress();
      if (result.found) {
        // Pre-populate the input and expand the lightning panel.
        setLightningInput(result.lightningAddress);
        setActivePanel('lightning');
        setValidationState({ status: 'saved' });
        console.log(
          '[WalletSetupScreen] Pre-loaded saved lightning address:',
          result.lightningAddress,
        );
      }
    }
    checkPersistedWallet();
  }, []);

  // ---------------------------------------------------------------------------
  // Panel toggle
  // ---------------------------------------------------------------------------

  function togglePanel(panel: ActivePanel) {
    if (activePanel === panel) {
      setActivePanel(null);
      setValidationState({ status: 'idle' });
      Animated.timing(panelAnim, {
        toValue: 0,
        duration: 220,
        useNativeDriver: false,
      }).start();
    } else {
      setActivePanel(panel);
      Animated.timing(panelAnim, {
        toValue: 1,
        duration: 260,
        useNativeDriver: false,
      }).start();
    }
  }

  // ---------------------------------------------------------------------------
  // Lightning address input handlers
  // ---------------------------------------------------------------------------

  function handleInputChange(text: string) {
    setLightningInput(text);
    // Reset validation when user edits
    if (validationState.status !== 'idle') {
      setValidationState({ status: 'idle' });
    }
  }

  const handleValidateAndSave = useCallback(async () => {
    Keyboard.dismiss();
    const address = lightningInput.trim().toLowerCase();

    if (!address) {
      setValidationState({
        status: 'format_error',
        message: 'Enter your Lightning address first',
      });
      return;
    }

    // --- Tier 1: Format check -------------------------------------------
    if (!isValidLightningAddressFormat(address)) {
      setValidationState({
        status: 'format_error',
        message: 'Looks wrong — Lightning addresses are user@domain.tld',
      });
      return;
    }

    // --- Tier 2: Live LUD-16 check --------------------------------------
    setValidationState({ status: 'validating' });

    const liveResult = await validateLightningAddressLive(address);

    if (!liveResult.valid) {
      // Live check failed — show "save anyway" escape hatch
      setValidationState({
        status: 'live_fail',
        message: liveResult.reason,
      });
      return;
    }

    // Live check passed — save
    await doSave(address, liveResult.description);
  }, [lightningInput]);

  const handleSaveAnyway = useCallback(async () => {
    const address = lightningInput.trim().toLowerCase();
    await doSave(address, '');
  }, [lightningInput]);

  async function doSave(address: string, description: string) {
    setIsSaving(true);

    const result = await saveLightningAddress(address);

    setIsSaving(false);

    if (!result.success) {
      setValidationState({
        status: 'live_fail',
        message: result.error,
      });
      return;
    }

    setValidationState({
      status: 'saved',
    });

    console.log(
      '[WalletSetupScreen] Wallet saved successfully:',
      address,
      description ? `(${description})` : '',
    );

    // Small delay so the user sees the success state before navigating
    setTimeout(() => {
      onWalletConfigured?.('lightning');
    }, 800);
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const isLightningPanelOpen = activePanel === 'lightning';
  const isNwcPanelOpen = activePanel === 'nwc';

  const showSaveAnyway =
    validationState.status === 'live_fail' &&
    isValidLightningAddressFormat(lightningInput.trim());

  const inputBorderColor =
    validationState.status === 'format_error' ||
    validationState.status === 'live_fail'
      ? C.danger
      : validationState.status === 'live_ok' ||
          validationState.status === 'saved'
        ? C.success
        : isLightningPanelOpen
          ? C.carbonBorderActive
          : C.carbonBorder;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* ── Header ───────────────────────────────────────────────── */}
          <Text style={styles.heading}>Your wallet</Text>
          <Text style={styles.subheading}>
            Where Refueler sends your sats after each order. Stored securely
            on-device — we never see your wallet details.
          </Text>

          {/* ── Option A: Lightning address ───────────────────────────── */}
          <OptionCard
            isOpen={isLightningPanelOpen}
            onPress={() => togglePanel('lightning')}
            title="Lightning address"
            subtitle="Enter a Lightning address — like an email for Bitcoin."
            badge={
              validationState.status === 'saved' ? 'Saved' : undefined
            }
            badgeStyle="success"
          >
            <View style={styles.panelBody}>
              {/* Address input */}
              <View
                style={[
                  styles.inputWrapper,
                  { borderColor: inputBorderColor },
                ]}
              >
                <TextInput
                  style={styles.input}
                  value={lightningInput}
                  onChangeText={handleInputChange}
                  placeholder="you@wallet.domain"
                  placeholderTextColor={C.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  returnKeyType="done"
                  onSubmitEditing={handleValidateAndSave}
                  editable={
                    !isSaving && validationState.status !== 'saved'
                  }
                  accessibilityLabel="Lightning address input"
                />
              </View>

              {/* Validation feedback */}
              <ValidationFeedback
                state={validationState}
                isSaving={isSaving}
              />

              {/* Primary CTA */}
              {validationState.status !== 'saved' && (
                <TouchableOpacity
                  style={[
                    styles.primaryButton,
                    (isSaving ||
                      validationState.status === 'validating') &&
                      styles.primaryButtonDisabled,
                  ]}
                  onPress={handleValidateAndSave}
                  disabled={
                    isSaving || validationState.status === 'validating'
                  }
                  activeOpacity={0.8}
                  accessibilityLabel="Save Lightning address"
                  accessibilityRole="button"
                >
                  {isSaving || validationState.status === 'validating' ? (
                    <ActivityIndicator size="small" color={C.carbon} />
                  ) : (
                    <Text style={styles.primaryButtonText}>
                      {validationState.status === 'live_fail'
                        ? 'Try again'
                        : 'Verify and save'}
                    </Text>
                  )}
                </TouchableOpacity>
              )}

              {/* Save anyway — shown only when live check failed but format was valid */}
              {showSaveAnyway && !isSaving && (
                <TouchableOpacity
                  style={styles.saveAnywayButton}
                  onPress={handleSaveAnyway}
                  activeOpacity={0.7}
                  accessibilityLabel="Save address without live verification"
                >
                  <Text style={styles.saveAnywayText}>
                    Save anyway without verifying
                  </Text>
                </TouchableOpacity>
              )}

              {/* Success state — change link */}
              {validationState.status === 'saved' && (
                <Pressable
                  onPress={() => {
                    setValidationState({ status: 'idle' });
                    setLightningInput('');
                  }}
                  style={({ pressed }) => [
                    styles.changeLink,
                    pressed && { opacity: 0.6 },
                  ]}
                  accessibilityLabel="Change saved Lightning address"
                >
                  <Text style={styles.changeLinkText}>Change address</Text>
                </Pressable>
              )}

              {/* Hint */}
              {validationState.status === 'idle' && (
                <Text style={styles.inputHint}>
                  Works with any LNURL-pay compatible wallet — Minibits,
                  Phoenix, Wallet of Satoshi, and more.
                </Text>
              )}
            </View>
          </OptionCard>

          {/* ── Option B: NWC ─────────────────────────────────────────── */}
          <OptionCard
            isOpen={isNwcPanelOpen}
            onPress={() => togglePanel('nwc')}
            title="Connect via NWC"
            subtitle="Link a wallet using Nostr Wallet Connect."
            badge="Coming soon"
            badgeStyle="neutral"
          >
            <View style={styles.panelBody}>
              <Text style={styles.nwcStubText}>
                Nostr Wallet Connect support is coming in a future update.
                Use a Lightning address for now.
              </Text>
            </View>
          </OptionCard>

          {/* ── Footer ───────────────────────────────────────────────── */}
          <Text style={styles.footnote}>
            Your wallet address is encrypted on-device. Refueler never
            custodies your funds.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// OptionCard
// ---------------------------------------------------------------------------

interface OptionCardProps {
  isOpen: boolean;
  onPress: () => void;
  title: string;
  subtitle: string;
  badge?: string;
  badgeStyle?: 'success' | 'neutral' | 'gold';
  children?: React.ReactNode;
}

function OptionCard({
  isOpen,
  onPress,
  title,
  subtitle,
  badge,
  badgeStyle = 'gold',
  children,
}: OptionCardProps) {
  return (
    <View
      style={[
        styles.card,
        isOpen && styles.cardActive,
      ]}
    >
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.8}
        style={styles.cardHeader}
        accessibilityRole="button"
        accessibilityState={{ expanded: isOpen }}
        accessibilityLabel={title}
      >
        <View style={styles.cardHeaderLeft}>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.cardSubtitle}>{subtitle}</Text>
        </View>
        {badge ? (
          <View
            style={[
              styles.badge,
              badgeStyle === 'success' && styles.badgeSuccess,
              badgeStyle === 'neutral' && styles.badgeNeutral,
            ]}
          >
            <Text
              style={[
                styles.badgeText,
                badgeStyle === 'success' && styles.badgeTextSuccess,
                badgeStyle === 'neutral' && styles.badgeTextNeutral,
              ]}
            >
              {badge}
            </Text>
          </View>
        ) : (
          <ChevronIcon isOpen={isOpen} />
        )}
      </TouchableOpacity>

      {isOpen && children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// ValidationFeedback
// ---------------------------------------------------------------------------

function ValidationFeedback({
  state,
  isSaving,
}: {
  state: ValidationState;
  isSaving: boolean;
}) {
  if (isSaving) {
    return (
      <View style={styles.feedbackRow}>
        <Text style={[styles.feedbackText, { color: C.textSecondary }]}>
          Saving…
        </Text>
      </View>
    );
  }

  switch (state.status) {
    case 'format_error':
      return (
        <View style={[styles.feedbackRow, styles.feedbackError]}>
          <Text style={[styles.feedbackText, { color: C.danger }]}>
            {state.message}
          </Text>
        </View>
      );

    case 'validating':
      return (
        <View style={styles.feedbackRow}>
          <ActivityIndicator
            size="small"
            color={C.gold}
            style={{ marginRight: 8 }}
          />
          <Text style={[styles.feedbackText, { color: C.textSecondary }]}>
            Checking with wallet provider…
          </Text>
        </View>
      );

    case 'live_ok':
      return (
        <View style={[styles.feedbackRow, styles.feedbackSuccess]}>
          <Text style={[styles.feedbackText, { color: C.success }]}>
            ✓ Wallet found
            {state.description ? ` · ${state.description}` : ''}
          </Text>
        </View>
      );

    case 'live_fail':
      return (
        <View style={[styles.feedbackRow, styles.feedbackError]}>
          <Text style={[styles.feedbackText, { color: C.danger }]}>
            {state.message}
          </Text>
        </View>
      );

    case 'saved':
      return (
        <View style={[styles.feedbackRow, styles.feedbackSuccess]}>
          <Text style={[styles.feedbackText, { color: C.success }]}>
            ✓ Saved — your sats will land here after each order
          </Text>
        </View>
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// ChevronIcon (pure RN, no icon lib dependency)
// ---------------------------------------------------------------------------

function ChevronIcon({ isOpen }: { isOpen: boolean }) {
  return (
    <View
      style={[
        styles.chevron,
        isOpen && styles.chevronOpen,
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  flex: { flex: 1 },

  safeArea: {
    flex: 1,
    backgroundColor: C.carbon,
  },

  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 44,
    paddingBottom: 48,
  },

  // ── Header ──────────────────────────────────────────────────────────────
  heading: {
    fontFamily: 'Satoshi',
    fontWeight: '600',
    fontSize: 28,
    color: C.textPrimary,
    marginBottom: 10,
    letterSpacing: -0.3,
  },

  subheading: {
    fontFamily: 'DM Sans',
    fontWeight: '300',
    fontSize: 15,
    lineHeight: 23,
    color: C.textSecondary,
    marginBottom: 36,
  },

  // ── Cards ──────────────────────────────────────────────────────────────
  card: {
    backgroundColor: C.carbonSurface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.carbonBorder,
    marginBottom: 14,
    overflow: 'hidden',
  },

  cardActive: {
    borderColor: C.carbonBorderActive,
  },

  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 20,
    paddingHorizontal: 20,
  },

  cardHeaderLeft: {
    flex: 1,
    marginRight: 12,
  },

  cardTitle: {
    fontFamily: 'DM Sans',
    fontWeight: '600',
    fontSize: 17,
    color: C.textPrimary,
    marginBottom: 4,
  },

  cardSubtitle: {
    fontFamily: 'DM Sans',
    fontWeight: '300',
    fontSize: 13,
    lineHeight: 19,
    color: C.textSecondary,
  },

  // ── Panel body (inside open card) ──────────────────────────────────────
  panelBody: {
    paddingHorizontal: 20,
    paddingBottom: 22,
    paddingTop: 4,
  },

  // ── Input ──────────────────────────────────────────────────────────────
  inputWrapper: {
    borderWidth: 1,
    borderRadius: 10,
    backgroundColor: C.inputBg,
    marginBottom: 10,
  },

  input: {
    fontFamily: 'DM Sans',
    fontWeight: '400',
    fontSize: 16,
    color: C.textPrimary,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 14 : 11,
    letterSpacing: 0.1,
  },

  inputHint: {
    fontFamily: 'DM Sans',
    fontWeight: '300',
    fontSize: 12,
    lineHeight: 18,
    color: C.textTertiary,
    marginTop: 10,
  },

  // ── Validation feedback ─────────────────────────────────────────────────
  feedbackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 12,
  },

  feedbackError: {
    backgroundColor: C.dangerSubtle,
  },

  feedbackSuccess: {
    backgroundColor: C.successSubtle,
  },

  feedbackText: {
    fontFamily: 'DM Sans',
    fontWeight: '400',
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
  },

  // ── Buttons ─────────────────────────────────────────────────────────────
  primaryButton: {
    backgroundColor: C.gold,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },

  primaryButtonDisabled: {
    opacity: 0.6,
  },

  primaryButtonText: {
    fontFamily: 'DM Sans',
    fontWeight: '600',
    fontSize: 15,
    color: C.carbon,
    letterSpacing: 0.1,
  },

  saveAnywayButton: {
    paddingVertical: 12,
    alignItems: 'center',
  },

  saveAnywayText: {
    fontFamily: 'DM Sans',
    fontWeight: '400',
    fontSize: 13,
    color: C.textTertiary,
    textDecorationLine: 'underline',
  },

  changeLink: {
    paddingTop: 14,
    alignItems: 'center',
  },

  changeLinkText: {
    fontFamily: 'DM Sans',
    fontWeight: '400',
    fontSize: 13,
    color: C.gold,
  },

  // ── NWC stub ────────────────────────────────────────────────────────────
  nwcStubText: {
    fontFamily: 'DM Sans',
    fontWeight: '300',
    fontSize: 14,
    lineHeight: 21,
    color: C.textSecondary,
  },

  // ── Badges ─────────────────────────────────────────────────────────────
  badge: {
    borderWidth: 1,
    borderColor: C.gold,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },

  badgeSuccess: {
    borderColor: C.success,
    backgroundColor: C.successSubtle,
  },

  badgeNeutral: {
    borderColor: C.textTertiary,
    backgroundColor: 'transparent',
  },

  badgeText: {
    fontFamily: 'DM Sans',
    fontWeight: '600',
    fontSize: 11,
    color: C.gold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  badgeTextSuccess: {
    color: C.success,
  },

  badgeTextNeutral: {
    color: C.textTertiary,
  },

  // ── Chevron ────────────────────────────────────────────────────────────
  chevron: {
    width: 8,
    height: 8,
    borderRightWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: C.textSecondary,
    transform: [{ rotate: '45deg' }],
    marginRight: 4,
  },

  chevronOpen: {
    transform: [{ rotate: '225deg' }],
    marginTop: 4,
  },

  // ── Footer ─────────────────────────────────────────────────────────────
  footnote: {
    fontFamily: 'DM Sans',
    fontWeight: '300',
    fontSize: 12,
    color: C.textTertiary,
    textAlign: 'center',
    marginTop: 28,
    lineHeight: 18,
    paddingHorizontal: 16,
  },
});
