/**
 * PreOrderScreen.tsx — CC-62
 *
 * Core commuter pre-order flow. Three sequential views:
 *
 *   VIEW 1 — VENUE PICKER
 *     Fetches active venues from Supabase venue_partners.
 *
 *   VIEW 2 — MENU
 *     Hardcoded menu per venue, keyed by venue UUID.
 *     Full menu_items table deferred to CC-63.
 *
 *   VIEW 3 — INVOICE
 *     Calls create-order Edge Function → gets BOLT11.
 *     Countdown timer, copy + open-in-wallet actions.
 *
 * Design: Carbon dark, gold accent, Satoshi / DM Sans / IBM Plex Mono.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Clipboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabaseClient.native';

// ─── Brand tokens ────────────────────────────────────────────────────────────

const C = {
  carbon:             '#1A1A1A',
  carbonSurface:      '#242424',
  carbonSurface2:     '#2C2C2C',
  carbonBorder:       'rgba(200, 169, 110, 0.18)',
  carbonBorderActive: 'rgba(200, 169, 110, 0.55)',
  gold:               '#C8A96E',
  goldSubtle:         'rgba(200, 169, 110, 0.10)',
  textPrimary:        '#F5F0E8',
  textSecondary:      '#A8A29A',
  textTertiary:       '#6B6560',
  success:            '#4CAF7D',
  successSubtle:      'rgba(76, 175, 125, 0.10)',
  danger:             '#E05252',
  dangerSubtle:       'rgba(224, 82, 82, 0.10)',
};

const SUPABASE_URL = 'https://tihgvdokeofnjxjkenmm.supabase.co';

// ─── Hardcoded menus keyed by venue UUID (CC-62 scope) ───────────────────────
// Full menu_items table is CC-63. UUIDs from venue_partners query 05-Jul-2026.

interface MenuItem {
  id:          string;
  name:        string;
  description: string;
  price_gbp:   number;
  category:    'hot_drinks' | 'cold_drinks' | 'food' | 'other';
}

const VENUE_MENUS: Record<string, MenuItem[]> = {
  // Black Sheep Coffee
  '3128956e-47fb-4c7a-a39d-2332c00a4b2d': [
    { id: 'bsc-1', name: 'Flat White',       description: 'Double ristretto, silky microfoam',     price_gbp: 3.80, category: 'hot_drinks' },
    { id: 'bsc-2', name: 'Oat Latte',        description: 'Single origin espresso, oat milk',      price_gbp: 4.20, category: 'hot_drinks' },
    { id: 'bsc-3', name: 'Cold Brew',         description: '12-hour steep, served over ice',        price_gbp: 4.50, category: 'cold_drinks' },
    { id: 'bsc-4', name: 'Espresso',          description: 'Double shot, short and strong',         price_gbp: 2.80, category: 'hot_drinks' },
   { id: 'bsc-dev', name: 'Dev Test',        description: '[Dev only — 21 sats]',                  price_gbp: 0.01, category: 'other' },
    { id: 'bsc-5', name: 'Banana Bread',      description: 'House baked, served warm',             price_gbp: 3.50, category: 'food' },
    { id: 'bsc-6', name: 'Almond Croissant',  description: 'Frangipane filled, flaky pastry',      price_gbp: 3.80, category: 'food' },
  ],
  // Grays Coffeeshop
  'de4133d6-2ac6-4f4e-8e67-83d047f6ca0d': [
    { id: 'gc-1',  name: 'Americano',         description: 'Espresso and hot water, your ratio',   price_gbp: 2.90, category: 'hot_drinks' },
    { id: 'gc-2',  name: 'Cappuccino',        description: 'Equal parts espresso, foam, milk',     price_gbp: 3.40, category: 'hot_drinks' },
    { id: 'gc-3',  name: 'Iced Mocha',        description: 'Chocolate, espresso, cold milk',       price_gbp: 4.20, category: 'cold_drinks' },
    { id: 'gc-4',  name: 'Toasted Sandwich',  description: 'Cheese and ham on sourdough',          price_gbp: 4.50, category: 'food' },
  ],
  // M&S Café
  '7fe8ae8e-4f04-4fdc-9000-a67d5bdd067c': [
    { id: 'ms-1',  name: 'Latte',             description: 'Smooth, full-bodied M&S blend',        price_gbp: 3.60, category: 'hot_drinks' },
    { id: 'ms-2',  name: 'Earl Grey',          description: 'Loose leaf, bergamot finish',          price_gbp: 2.80, category: 'hot_drinks' },
    { id: 'ms-3',  name: 'Egg Mayo Roll',      description: 'Free-range egg, soft white roll',      price_gbp: 3.90, category: 'food' },
    { id: 'ms-4',  name: 'Percy Pig Muffin',   description: 'Raspberry jam, Percy topping',         price_gbp: 3.20, category: 'food' },
    { id: 'ms-5',  name: 'Orange Juice',       description: 'Freshly squeezed, 330ml',             price_gbp: 2.90, category: 'cold_drinks' },
  ],
  // Costco
  '588bd708-1064-48ec-ac6b-51c08dd60539': [
    { id: 'co-1',  name: 'Hot Dog & Drink',    description: 'Quarter-pound frank, unlimited refill', price_gbp: 1.50, category: 'food' },
    { id: 'co-2',  name: 'Pizza Slice',         description: 'Cheese or pepperoni, by the slice',    price_gbp: 1.99, category: 'food' },
    { id: 'co-3',  name: 'Chicken Bake',        description: 'Diced chicken, cheese, onion pastry',  price_gbp: 2.49, category: 'food' },
  ],
};

const DEFAULT_MENU: MenuItem[] = [
  { id: 'def-1', name: 'Filter Coffee', description: 'House blend', price_gbp: 2.50, category: 'hot_drinks' },
  { id: 'def-2', name: 'Tea',           description: 'English breakfast', price_gbp: 2.00, category: 'hot_drinks' },
  { id: 'def-3', name: 'Pastry',        description: "Ask staff for today's selection", price_gbp: 3.00, category: 'food' },
];

const CATEGORY_LABELS: Record<string, string> = {
  hot_drinks:  'Hot drinks',
  cold_drinks: 'Cold drinks',
  food:        'Food',
  other:       'Other',
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface Venue {
  id:            string;
  name:          string;
  category:      string;
  pickup_note:   string | null;
  brand_primary: string | null;
  active:        boolean;
}

type ViewName = 'venue' | 'menu' | 'invoice';

interface OrderResult {
  order_id:          string;
  merchant_order_id: string;
  payment_request:   string;
  payment_hash:      string;
  expires_at:        string;
  satoshis:          number;
  amount_gbp:        number;
  rate_gbp_per_btc:  number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSats(sats: number): string {
  return `${sats.toLocaleString()} sats`;
}

function formatGbp(n: number): string {
  return `£${n.toFixed(2)}`;
}

function categoryIcon(cat: string): string {
  switch (cat) {
    case 'coffee':
    case 'café':   return '☕';
    case 'food':   return '🥗';
    case 'retail': return '🛒';
    case 'ev':     return '⚡';
    default:       return '🏪';
  }
}

function getMenu(venueId: string): MenuItem[] {
  return VENUE_MENUS[venueId] ?? DEFAULT_MENU;
}

function groupByCategory(items: MenuItem[]): Array<{ category: string; items: MenuItem[] }> {
  const map: Record<string, MenuItem[]> = {};
  for (const item of items) {
    if (!map[item.category]) map[item.category] = [];
    map[item.category].push(item);
  }
  return Object.entries(map).map(([category, items]) => ({ category, items }));
}

function timeRemaining(expiresAt: string): string {
  const diff = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function PreOrderScreen() {
  const router = useRouter();
  const [view, setView]           = useState<ViewName>('venue');
  const [venues, setVenues]       = useState<Venue[]>([]);
  const [loading, setLoading]     = useState(true);
  const [loadErr, setLoadErr]     = useState<string | null>(null);

  const [selectedVenue, setSelectedVenue] = useState<Venue | null>(null);
  const [selectedItem,  setSelectedItem]  = useState<MenuItem | null>(null);

  const [ordering,     setOrdering]    = useState(false);
  const [orderError,   setOrderError]  = useState<string | null>(null);
  const [orderResult,  setOrderResult] = useState<OrderResult | null>(null);

  const [copied,    setCopied]    = useState(false);
  const [countdown, setCountdown] = useState('');

  // ── Load active venues ────────────────────────────────────────────────────

  const loadVenues = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    const { data, error } = await supabase
      .from('venue_partners')
      .select('id, name, category, pickup_note, brand_primary, active')
      .eq('active', true)
      .order('name');

    if (error) {
      console.error('[PreOrderScreen] venues load error:', error.message);
      setLoadErr('Couldn\'t load venues. Tap to retry.');
    } else {
      setVenues(data ?? []);
      console.log(`[PreOrderScreen] ${data?.length ?? 0} active venues loaded`);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadVenues(); }, [loadVenues]);

  // ── Countdown ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (view !== 'invoice' || !orderResult?.expires_at) return;
    setCountdown(timeRemaining(orderResult.expires_at));
    const id = setInterval(() => {
      const r = timeRemaining(orderResult.expires_at);
      setCountdown(r);
      if (r === '0:00') clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [view, orderResult]);

  // ── Settlement Realtime — navigate to order-status when paid ─────────────

  useEffect(() => {
    if (!orderResult?.order_id) return;

    const sub = supabase
      .channel(`preorder-settlement-${orderResult.order_id}`)
      .on(
        'postgres_changes',
        {
          event:  'UPDATE',
          schema: 'public',
          table:  'orders',
          filter: `id=eq.${orderResult.order_id}`,
        },
        (payload) => {
          if (payload.new.payment_status === 'paid') {
            sub.unsubscribe();
            router.replace({
              pathname: '/order-status',
              params:   { orderId: orderResult.order_id },
            } as any);
          }
        }
      )
      .subscribe();

    return () => { sub.unsubscribe(); };
  }, [orderResult?.order_id]);

  // ── Navigation ────────────────────────────────────────────────────────────

  function selectVenue(v: Venue) {
    setSelectedVenue(v);
    setSelectedItem(null);
    setOrderError(null);
    setView('menu');
  }

  function backToVenues() {
    setSelectedVenue(null);
    setSelectedItem(null);
    setOrderError(null);
    setView('venue');
  }

  function backToMenu() {
    setOrderResult(null);
    setOrderError(null);
    setView('menu');
  }

  // ── Place order ───────────────────────────────────────────────────────────

  const placeOrder = useCallback(async () => {
    if (!selectedVenue || !selectedItem) return;
    setOrdering(true);
    setOrderError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setOrderError('Sign in first to place an order.');
        setOrdering(false);
        return;
      }

      const res = await fetch(`${SUPABASE_URL}/functions/v1/create-order`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          venue_id:   selectedVenue.id,
          item_name:  selectedItem.name,
          amount_gbp: selectedItem.price_gbp,
          memo:       `${selectedItem.name} · ${selectedVenue.name}`,
          sandbox:    false,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        console.error('[PreOrderScreen] create-order failed:', data);
        setOrderError(data.error ?? 'Order failed. Please try again.');
        setOrdering(false);
        return;
      }

      console.log(`[PreOrderScreen] ✓ order=${data.order_id} sats=${data.satoshis}`);
      setOrderResult(data as OrderResult);
      setView('invoice');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      console.error('[PreOrderScreen] placeOrder threw:', err);
      setOrderError(`Couldn't reach server: ${msg}`);
    } finally {
      setOrdering(false);
    }
  }, [selectedVenue, selectedItem]);

  // ── Invoice actions ───────────────────────────────────────────────────────

  function openInWallet() {
    if (!orderResult) return;
    const uri = `lightning:${orderResult.payment_request}`;
    Linking.openURL(uri).catch(() => {
      Linking.openURL(`bitcoin:?lightning=${orderResult.payment_request}`).catch(
        (e) => console.warn('[PreOrderScreen] No Lightning wallet found:', e)
      );
    });
  }

  function copyInvoice() {
    if (!orderResult) return;
    Clipboard.setString(orderResult.payment_request);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={s.safeArea} edges={['top', 'bottom']}>
      {view === 'venue'   && <VenueView
          loading={loading}
          error={loadErr}
          venues={venues}
          onSelect={selectVenue}
          onRetry={loadVenues}
        />}
      {view === 'menu'    && <MenuView
          venue={selectedVenue!}
          selectedItem={selectedItem}
          ordering={ordering}
          orderError={orderError}
          onSelectItem={setSelectedItem}
          onBack={backToVenues}
          onConfirm={placeOrder}
        />}
      {view === 'invoice' && <InvoiceView
          venue={selectedVenue!}
          item={selectedItem!}
          result={orderResult!}
          countdown={countdown}
          copied={copied}
          onBack={backToMenu}
          onOpenWallet={openInWallet}
          onCopy={copyInvoice}
        />}
    </SafeAreaView>
  );
}

// ─── View 1: Venue picker ─────────────────────────────────────────────────────

function VenueView({
  loading, error, venues, onSelect, onRetry,
}: {
  loading: boolean;
  error: string | null;
  venues: Venue[];
  onSelect: (v: Venue) => void;
  onRetry: () => void;
}) {
  return (
    <View style={s.flex}>
      <View style={s.header}>
        <Text style={s.heading}>Order ahead</Text>
        <Text style={s.subheading}>
          Ready when you walk in. Pay in sats, collect on arrival.
        </Text>
      </View>

      {loading ? (
        <View style={s.centred}>
          <ActivityIndicator color={C.gold} size="large" />
          <Text style={s.loadingText}>Finding venues…</Text>
        </View>
      ) : error ? (
        <View style={s.centred}>
          <Text style={s.errorText}>{error}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={onRetry} activeOpacity={0.8}>
            <Text style={s.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : venues.length === 0 ? (
        <View style={s.centred}>
          <Text style={s.emptyText}>No venues available right now.</Text>
        </View>
      ) : (
        <ScrollView
          style={s.flex}
          contentContainerStyle={s.listContent}
          showsVerticalScrollIndicator={false}
        >
          {venues.map((v) => (
            <VenueCard key={v.id} venue={v} onPress={() => onSelect(v)} />
          ))}
          <Text style={s.footnote}>Beta: test transactions only. No real orders placed.</Text>
        </ScrollView>
      )}
    </View>
  );
}

// ─── View 2: Menu ─────────────────────────────────────────────────────────────

function MenuView({
  venue, selectedItem, ordering, orderError,
  onSelectItem, onBack, onConfirm,
}: {
  venue: Venue;
  selectedItem: MenuItem | null;
  ordering: boolean;
  orderError: string | null;
  onSelectItem: (item: MenuItem) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const menu   = getMenu(venue.id);
  const groups = groupByCategory(menu);

  return (
    <View style={s.flex}>
      <View style={s.header}>
        <Pressable style={s.backRow} onPress={onBack} accessibilityRole="button" accessibilityLabel="Back to venues">
          <Text style={s.backChevron}>‹</Text>
          <Text style={s.backLabel}>Venues</Text>
        </Pressable>
        <Text style={s.heading}>{venue.name}</Text>
        {venue.pickup_note
          ? <Text style={s.pickupNote}>📍 {venue.pickup_note}</Text>
          : null}
      </View>

      <ScrollView
        style={s.flex}
        contentContainerStyle={s.listContent}
        showsVerticalScrollIndicator={false}
      >
        {groups.map(({ category, items }) => (
          <View key={category} style={s.menuSection}>
            <Text style={s.menuSectionTitle}>
              {CATEGORY_LABELS[category] ?? category}
            </Text>
            {items.map((item) => (
              <MenuItemCard
                key={item.id}
                item={item}
                selected={selectedItem?.id === item.id}
                onPress={() => onSelectItem(item)}
              />
            ))}
          </View>
        ))}

        {orderError ? (
          <View style={s.errorBanner}>
            <Text style={s.errorBannerText}>{orderError}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[s.primaryBtn, (!selectedItem || ordering) && s.primaryBtnDisabled]}
          onPress={onConfirm}
          disabled={!selectedItem || ordering}
          activeOpacity={0.8}
        >
          {ordering
            ? <ActivityIndicator size="small" color={C.carbon} />
            : <Text style={s.primaryBtnText}>
                {selectedItem
                  ? `Pay ${formatGbp(selectedItem.price_gbp)} · get invoice`
                  : 'Select an item'}
              </Text>}
        </TouchableOpacity>

        {selectedItem
          ? <Text style={s.footnoteCentre}>
              A Lightning invoice will be created.{'\n'}Pay from any Lightning wallet.
            </Text>
          : null}
      </ScrollView>
    </View>
  );
}

// ─── View 3: Invoice ──────────────────────────────────────────────────────────

function InvoiceView({
  venue, item, result, countdown, copied,
  onBack, onOpenWallet, onCopy,
}: {
  venue: Venue;
  item: MenuItem;
  result: OrderResult;
  countdown: string;
  copied: boolean;
  onBack: () => void;
  onOpenWallet: () => void;
  onCopy: () => void;
}) {
  const expired = countdown === '0:00';

  return (
    <View style={s.flex}>
      <View style={s.header}>
        <Pressable style={s.backRow} onPress={onBack} accessibilityRole="button" accessibilityLabel="Back to menu">
          <Text style={s.backChevron}>‹</Text>
          <Text style={s.backLabel}>Menu</Text>
        </Pressable>
        <Text style={s.heading}>Your invoice</Text>
      </View>

      <ScrollView
        style={s.flex}
        contentContainerStyle={s.listContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Order summary ───────────────────────────────────── */}
        <View style={s.invoiceCard}>
          <Text style={s.invoiceVenueName}>{venue.name}</Text>
          <Text style={s.invoiceItemName}>{item.name}</Text>

          <View style={s.amountRow}>
            <View>
              <Text style={s.amountLabel}>You pay</Text>
              <Text style={s.amountGbp}>{formatGbp(result.amount_gbp)}</Text>
            </View>
            <View style={s.amountDivider} />
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={s.amountLabel}>In sats</Text>
              <Text style={s.amountSats}>{formatSats(result.satoshis)}</Text>
            </View>
          </View>

          <Text style={s.feeHint}>Network fee varies · zero fees with Blink Wallet</Text>
        </View>

        {/* Countdown ───────────────────────────────────────── */}
        <View style={[s.countdownRow, expired && s.countdownExpired]}>
          <Text style={[s.countdownLabel, expired && { color: C.danger }]}>
            {expired ? 'Invoice expired' : 'Expires in'}
          </Text>
          {!expired && <Text style={s.countdownTimer}>{countdown}</Text>}
        </View>

        {/* BOLT11 string ───────────────────────────────────── */}
        <View style={s.invoiceStringCard}>
          <Text style={s.invoiceStringLabel}>BOLT11 invoice</Text>
          <Text style={s.invoiceString} numberOfLines={3} ellipsizeMode="tail">
            {result.payment_request}
          </Text>
        </View>

        {/* CTAs ────────────────────────────────────────────── */}
        {!expired && (
          <TouchableOpacity style={s.primaryBtn} onPress={onOpenWallet} activeOpacity={0.8}>
            <Text style={s.primaryBtnText}>Open in Lightning wallet ↗</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[s.secondaryBtn, copied && s.secondaryBtnSuccess]}
          onPress={onCopy}
          activeOpacity={0.8}
          disabled={expired}
        >
          <Text style={[s.secondaryBtnText, copied && { color: C.success }]}>
            {copied ? '✓ Copied' : 'Copy invoice string'}
          </Text>
        </TouchableOpacity>

        {expired && (
          <TouchableOpacity style={s.primaryBtn} onPress={onBack} activeOpacity={0.8}>
            <Text style={s.primaryBtnText}>Get a new invoice</Text>
          </TouchableOpacity>
        )}

        <Text style={s.invoiceFootnote}>
          Order ref: {result.order_id.slice(0, 8)}…{'\n'}
          Pay within the countdown. Order confirmed on payment.
        </Text>
      </ScrollView>
    </View>
  );
}

// ─── VenueCard ────────────────────────────────────────────────────────────────

function VenueCard({ venue, onPress }: { venue: Venue; onPress: () => void }) {
  const accent = venue.brand_primary ?? C.gold;
  return (
    <TouchableOpacity
      style={s.venueCard}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`Order from ${venue.name}`}
    >
      <View style={[s.venueAccent, { backgroundColor: accent + '55' }]} />
      <View style={s.venueBody}>
        <Text style={s.venueIcon}>{categoryIcon(venue.category)}</Text>
        <View style={s.venueInfo}>
          <Text style={s.venueName}>{venue.name}</Text>
          <Text style={s.venueCat}>{venue.category}</Text>
          {venue.pickup_note
            ? <Text style={s.venuePickup} numberOfLines={1}>📍 {venue.pickup_note}</Text>
            : null}
        </View>
        <Text style={s.venueChevron}>›</Text>
      </View>
    </TouchableOpacity>
  );
}

// ─── MenuItemCard ─────────────────────────────────────────────────────────────

function MenuItemCard({
  item, selected, onPress,
}: {
  item: MenuItem;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[s.menuItem, selected && s.menuItemSelected]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`${item.name}, ${formatGbp(item.price_gbp)}`}
      accessibilityState={{ selected }}
    >
      <View style={s.menuItemInner}>
        <View style={s.menuItemLeft}>
          <Text style={s.menuItemName}>{item.name}</Text>
          <Text style={s.menuItemDesc}>{item.description}</Text>
        </View>
        <View style={s.menuItemRight}>
          <Text style={[s.menuItemPrice, selected && { color: C.gold }]}>
            {formatGbp(item.price_gbp)}
          </Text>
          {selected && <View style={s.selectedDot} />}
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  flex:    { flex: 1 },
  safeArea: { flex: 1, backgroundColor: C.carbon },

  // Header
  header: { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 12 },
  heading: {
    fontFamily: 'Satoshi', fontWeight: '600', fontSize: 26,
    color: C.textPrimary, letterSpacing: -0.3, marginBottom: 6,
  },
  subheading: {
    fontFamily: 'DM Sans', fontWeight: '300', fontSize: 14,
    lineHeight: 21, color: C.textSecondary,
  },

  // Back nav
  backRow:    { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  backChevron: { fontFamily: 'DM Sans', fontSize: 22, color: C.gold, marginRight: 4, lineHeight: 26 },
  backLabel:  { fontFamily: 'DM Sans', fontWeight: '500', fontSize: 15, color: C.gold },
  pickupNote: { fontFamily: 'DM Sans', fontWeight: '300', fontSize: 12, color: C.textTertiary, marginTop: 2 },

  // Scroll
  listContent: { paddingHorizontal: 24, paddingBottom: 56 },

  // States
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  loadingText: { fontFamily: 'DM Sans', fontWeight: '300', fontSize: 13, color: C.textTertiary, marginTop: 14 },
  errorText:   { fontFamily: 'DM Sans', fontSize: 14, color: C.danger, textAlign: 'center', marginBottom: 14 },
  emptyText:   { fontFamily: 'DM Sans', fontWeight: '300', fontSize: 14, color: C.textTertiary, textAlign: 'center' },
  retryBtn:    { borderWidth: 1, borderColor: C.carbonBorderActive, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  retryBtnText: { fontFamily: 'DM Sans', fontWeight: '500', fontSize: 14, color: C.gold },
  errorBanner: { backgroundColor: C.dangerSubtle, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 16 },
  errorBannerText: { fontFamily: 'DM Sans', fontSize: 13, color: C.danger },

  // Venue cards
  venueCard: {
    backgroundColor: C.carbonSurface, borderRadius: 14,
    borderWidth: 1, borderColor: C.carbonBorder,
    marginBottom: 12, overflow: 'hidden',
  },
  venueAccent: { height: 3 },
  venueBody:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  venueIcon:   { fontSize: 26, marginRight: 14 },
  venueInfo:   { flex: 1 },
  venueName:   { fontFamily: 'DM Sans', fontWeight: '600', fontSize: 16, color: C.textPrimary, marginBottom: 3 },
  venueCat:    { fontFamily: 'DM Sans', fontWeight: '300', fontSize: 12, color: C.textTertiary, textTransform: 'capitalize', marginBottom: 2 },
  venuePickup: { fontFamily: 'DM Sans', fontWeight: '300', fontSize: 12, color: C.textSecondary },
  venueChevron: { fontFamily: 'DM Sans', fontSize: 20, color: C.textTertiary, marginLeft: 8 },

  // Menu
  menuSection:      { marginBottom: 22 },
  menuSectionTitle: {
    fontFamily: 'DM Sans', fontWeight: '600', fontSize: 11,
    color: C.textTertiary, textTransform: 'uppercase', letterSpacing: 0.9, marginBottom: 8,
  },
  menuItem: {
    backgroundColor: C.carbonSurface, borderRadius: 12,
    borderWidth: 1, borderColor: C.carbonBorder, marginBottom: 8, overflow: 'hidden',
  },
  menuItemSelected: { borderColor: C.carbonBorderActive, backgroundColor: C.goldSubtle },
  menuItemInner:    { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13 },
  menuItemLeft:     { flex: 1, marginRight: 12 },
  menuItemName:     { fontFamily: 'DM Sans', fontWeight: '600', fontSize: 15, color: C.textPrimary, marginBottom: 3 },
  menuItemDesc:     { fontFamily: 'DM Sans', fontWeight: '300', fontSize: 12, color: C.textSecondary, lineHeight: 17 },
  menuItemRight:    { alignItems: 'flex-end' },
  menuItemPrice:    { fontFamily: 'IBM Plex Mono', fontWeight: '500', fontSize: 15, color: C.textPrimary },
  selectedDot:      { width: 8, height: 8, borderRadius: 4, backgroundColor: C.gold, marginTop: 5 },

  // Buttons
  primaryBtn: {
    backgroundColor: C.gold, borderRadius: 12, paddingVertical: 15,
    alignItems: 'center', justifyContent: 'center', minHeight: 50, marginBottom: 12,
  },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: { fontFamily: 'DM Sans', fontWeight: '600', fontSize: 15, color: C.carbon },
  secondaryBtn: {
    borderWidth: 1, borderColor: C.carbonBorder, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center', minHeight: 50, marginBottom: 12,
  },
  secondaryBtnSuccess: { borderColor: C.success, backgroundColor: C.successSubtle },
  secondaryBtnText: { fontFamily: 'DM Sans', fontWeight: '500', fontSize: 15, color: C.textSecondary },

  // Invoice
  invoiceCard: {
    backgroundColor: C.carbonSurface, borderRadius: 16,
    borderWidth: 1, borderColor: C.carbonBorderActive, padding: 20, marginBottom: 14,
  },
  invoiceVenueName: { fontFamily: 'DM Sans', fontWeight: '300', fontSize: 12, color: C.textTertiary, marginBottom: 4 },
  invoiceItemName:  { fontFamily: 'Satoshi', fontWeight: '600', fontSize: 22, color: C.textPrimary, marginBottom: 20, letterSpacing: -0.2 },
  amountRow:        { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  amountDivider:    { flex: 1, height: 1, backgroundColor: C.carbonBorder, marginHorizontal: 16 },
  amountLabel:      { fontFamily: 'DM Sans', fontWeight: '300', fontSize: 10, color: C.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  amountGbp:        { fontFamily: 'IBM Plex Mono', fontWeight: '600', fontSize: 24, color: C.textPrimary },
  amountSats:       { fontFamily: 'IBM Plex Mono', fontWeight: '600', fontSize: 20, color: C.gold, textAlign: 'right' },
  rateText:         { fontFamily: 'DM Sans', fontWeight: '300', fontSize: 11, color: C.textTertiary },
  feeHint:          { fontFamily: 'DM Sans', fontWeight: '400', fontSize: 13, color: C.textSecondary, marginBottom: 12, marginTop: 4 },

  countdownRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.carbonSurface, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 11, marginBottom: 14 },
  countdownExpired: { backgroundColor: C.dangerSubtle },
  countdownLabel:  { fontFamily: 'DM Sans', fontWeight: '400', fontSize: 13, color: C.textSecondary },
  countdownTimer:  { fontFamily: 'IBM Plex Mono', fontWeight: '600', fontSize: 18, color: C.gold },

  invoiceStringCard:  { backgroundColor: C.carbonSurface2, borderRadius: 10, padding: 14, marginBottom: 20 },
  invoiceStringLabel: { fontFamily: 'DM Sans', fontWeight: '300', fontSize: 10, color: C.textTertiary, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
  invoiceString:      { fontFamily: 'IBM Plex Mono', fontWeight: '400', fontSize: 10, color: C.textTertiary, lineHeight: 16 },
  invoiceFootnote:    { fontFamily: 'DM Sans', fontWeight: '300', fontSize: 11, color: C.textTertiary, textAlign: 'center', lineHeight: 17, marginTop: 8 },

  // Footnotes
  footnote:      { fontFamily: 'DM Sans', fontWeight: '300', fontSize: 12, color: C.textTertiary, marginTop: 16, lineHeight: 18 },
  footnoteCentre: { fontFamily: 'DM Sans', fontWeight: '300', fontSize: 12, color: C.textTertiary, textAlign: 'center', marginTop: 2, marginBottom: 10, lineHeight: 18 },
});
