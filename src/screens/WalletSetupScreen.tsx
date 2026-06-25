/**
 * WalletSetupScreen.tsx
 * The locked 3-option wallet selection screen (claude_v4_1.md / 10B onboarding
 * decisions). Exactly three options, no more:
 *
 *   1. Minibits ecash — recommended, set up in-app, no exit from Refueler.
 *   2. Connect an existing Lightning wallet via NWC (Nostr Wallet Connect).
 *   3. Enter a wallet manually — for non-NWC users, e.g. Kraken holders.
 *
 * Brand ethos: James Bond, not fintech neon — suave, discreet, refined.
 * "Screen must breathe": generous vertical spacing, no clutter, no badges
 * screaming for attention. Carbon background, gold accent only, no orange.
 *
 * SCOPE NOTE (CC-45): this is the screen shell + selection UX only. The
 * actual wallet logic behind each option is NOT wired up yet:
 *   - Minibits in-app setup → needs the Cashu/Minibits SDK integration
 *     (tracked separately, "Minibits/Cashu NUT-18" standing item, ⚪).
 *   - NWC connect → needs an NWC connection library + relay handling.
 *   - Manual entry → needs validation (lightning address / LNURL / NWC
 *     connection string format checking) before it's wired to
 *     mintInterface.ts.
 * Each handler below is a clearly-marked stub. Wiring real wallet logic
 * behind these is queued, deliberately, for a future session — this
 * session's job was the screen and the selection UX, not the integrations.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ScrollView,
} from 'react-native';

// --- Locked brand tokens (claude_v4_1.md §2) -------------------------------

const COLORS = {
  carbon: '#1A1A1A',
  carbonSurface: '#242424', // slightly lifted surface for cards on Carbon
  gold: '#C8A96E',
  textPrimary: '#F5F0E8', // Paper, used as light text-on-dark here
  textSecondary: '#A8A29A',
  danger: '#E05252',
};

type WalletOption = 'minibits' | 'nwc' | 'manual';

interface WalletSetupScreenProps {
  /** Called once a wallet option has been chosen and (eventually) wired up. */
  onWalletConfigured?: (option: WalletOption) => void;
}

export default function WalletSetupScreen({ onWalletConfigured }: WalletSetupScreenProps) {
  const [pending, setPending] = useState<WalletOption | null>(null);

  // --- Stub handlers — see SCOPE NOTE above ---------------------------------

  async function handleSelectMinibits() {
    setPending('minibits');
    // TODO (future session): Minibits/Cashu SDK in-app onboarding flow.
    console.log('[WalletSetupScreen] Minibits selected — in-app setup not yet wired.');
    setPending(null);
  }

  async function handleConnectNWC() {
    setPending('nwc');
    // TODO (future session): NWC connection string / relay handshake.
    console.log('[WalletSetupScreen] NWC connect selected — not yet wired.');
    setPending(null);
  }

  async function handleManualEntry() {
    setPending('manual');
    // TODO (future session): manual lightning address / LNURL entry + validation.
    console.log('[WalletSetupScreen] Manual entry selected — not yet wired.');
    setPending(null);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.heading}>Choose your wallet</Text>
        <Text style={styles.subheading}>
          Your sats, your custody. Pick how you'd like to receive and spend them.
        </Text>

        <View style={styles.optionList}>
          <WalletOptionCard
            title="Minibits ecash"
            description="Set up in-app, in seconds. Recommended for most commuters."
            badge="Recommended"
            loading={pending === 'minibits'}
            onPress={handleSelectMinibits}
          />

          <WalletOptionCard
            title="Connect existing wallet"
            description="Link a Lightning wallet you already use via Nostr Wallet Connect (NWC)."
            loading={pending === 'nwc'}
            onPress={handleConnectNWC}
          />

          <WalletOptionCard
            title="Enter wallet manually"
            description="For wallets without NWC support — e.g. exchange-held accounts like Kraken."
            loading={pending === 'manual'}
            onPress={handleManualEntry}
          />
        </View>

        <Text style={styles.footnote}>
          You can change this later in Settings.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// --- Reusable option card --------------------------------------------------

interface WalletOptionCardProps {
  title: string;
  description: string;
  badge?: string;
  loading?: boolean;
  onPress: () => void;
}

function WalletOptionCard({ title, description, badge, loading, onPress }: WalletOptionCardProps) {
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      disabled={loading}
      activeOpacity={0.75}
    >
      <View style={styles.cardHeaderRow}>
        <Text style={styles.cardTitle}>{title}</Text>
        {badge ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.cardDescription}>{description}</Text>
      {loading ? <Text style={styles.cardLoading}>Setting up…</Text> : null}
    </TouchableOpacity>
  );
}

// --- Styles ------------------------------------------------------------------
//
// Headings should use Satoshi (600), body DM Sans (300/400) per claude_v4_1.md
// §2 typography tokens. Font family names below assume the fonts have been
// loaded/linked into the native project already (expo-font or
// react-native.config.js font linking) — if not yet linked, these will
// silently fall back to system fonts rather than crash, but flag to Rajesh
// if Satoshi/DM Sans aren't showing up.

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.carbon,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 28,
    paddingTop: 48,
    paddingBottom: 40,
  },
  heading: {
    fontFamily: 'Satoshi',
    fontWeight: '600',
    fontSize: 26,
    color: COLORS.textPrimary,
    marginBottom: 10,
  },
  subheading: {
    fontFamily: 'DM Sans',
    fontWeight: '300',
    fontSize: 15,
    lineHeight: 22,
    color: COLORS.textSecondary,
    marginBottom: 40,
  },
  optionList: {
    gap: 16,
  },
  card: {
    backgroundColor: COLORS.carbonSurface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(200, 169, 110, 0.25)', // faint gold hairline, not a loud border
    paddingVertical: 22,
    paddingHorizontal: 20,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  cardTitle: {
    fontFamily: 'DM Sans',
    fontWeight: '600',
    fontSize: 17,
    color: COLORS.textPrimary,
  },
  badge: {
    borderWidth: 1,
    borderColor: COLORS.gold,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  badgeText: {
    fontFamily: 'DM Sans',
    fontWeight: '600',
    fontSize: 11,
    color: COLORS.gold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardDescription: {
    fontFamily: 'DM Sans',
    fontWeight: '300',
    fontSize: 14,
    lineHeight: 20,
    color: COLORS.textSecondary,
  },
  cardLoading: {
    fontFamily: 'DM Sans',
    fontWeight: '400',
    fontSize: 13,
    color: COLORS.gold,
    marginTop: 10,
  },
  footnote: {
    fontFamily: 'DM Sans',
    fontWeight: '300',
    fontSize: 12,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginTop: 36,
  },
});
