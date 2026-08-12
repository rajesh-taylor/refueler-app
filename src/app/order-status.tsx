/**
 * CC-66 — Order Status & ETA Screen (fixed)
 *
 * Route: src/app/order-status.tsx
 * Receives orderId param from PreOrderScreen after invoice created.
 * Navigated to automatically when orders.payment_status = 'paid' fires
 * via Realtime (blink-webhook v9 writes payment_status + status).
 *
 * Data sources:
 *  - orders table — item_name, status, payment_status, settled_sats,
 *                   routing_fee_sats, venue_id, created_at
 *  - venue_partners (join) — name, address_line1, city
 *  - rail_signal_current — next_departure_minutes, platform, destination
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../lib/supabaseClient.native';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Order {
  id: string;
  status: string;
  payment_status: string;
  venue_id: string;
  venue_name: string;
  venue_city: string;
  item_name: string;
  settled_sats: number | null;
  routing_fee_sats: number | null;
  created_at: string;
}

interface RailSignal {
  station_crs: string;
  next_departure_minutes: number | null;
  platform: string | null;
  destination: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CARBON          = '#1A1A1A';
const CARBON_SURFACE  = '#242424';
const CARBON_BORDER   = '#2E2E2E';
const TEXT_PRIMARY    = '#F5F5F0';
const TEXT_SECONDARY  = '#8A8A8A';
const CONFIRMED_GREEN = '#4CAF50';
const VENUE_ACCENT    = '#6B9BAE';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortRef(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 8).toUpperCase();
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PulseDot() {
  const scale   = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.9)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(scale,   { toValue: 1.4, duration: 900, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0,   duration: 900, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(scale,   { toValue: 1, duration: 0, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.9, duration: 0, useNativeDriver: true }),
        ]),
      ])
    ).start();
  }, []);

  return (
    <View style={styles.pulseDotContainer}>
      <Animated.View style={[styles.pulseDotRing, { transform: [{ scale }], opacity }]} />
      <View style={styles.pulseDotCore} />
    </View>
  );
}

function FeeBar({ settledSats, routingFeeSats }: { settledSats: number | null; routingFeeSats: number | null }) {
  if (settledSats === null) {
    return <Text style={styles.feeBarText}>Payment confirmed · fee: pending</Text>;
  }
  if (routingFeeSats === null) {
    return (
      <Text style={styles.feeBarText}>
        {settledSats.toLocaleString()} sats · fee: pending
      </Text>
    );
  }
  const net = settledSats - routingFeeSats;
  return (
    <Text style={styles.feeBarText}>
      {settledSats.toLocaleString()} sats · {routingFeeSats.toLocaleString()} sat routing fee · {net.toLocaleString()} sats net
    </Text>
  );
}

function EtaStrip({ railSignal, itemName, orderStatus }: { railSignal: RailSignal | null; itemName: string; orderStatus: string }) {
  const etaMinutes = railSignal?.next_departure_minutes ?? null;
  const etaLabel =
    etaMinutes === null ? 'ETA loading…' :
    etaMinutes === 0   ? 'Train arriving now' :
    `Train in ${etaMinutes} min`;

  const itemCopy =
    orderStatus === 'ready'    ? `Your ${itemName.toLowerCase()} is ready for collection` :
    orderStatus === 'preparing' ? `Your ${itemName.toLowerCase()} is being prepared` :
    `Your ${itemName.toLowerCase()} will be ready when you arrive`;

  return (
    <View style={styles.etaStrip}>
      <View style={styles.etaGlass}>
        <View style={styles.etaHeader}>
          <Text style={styles.etaMinutes}>{etaLabel}</Text>
          {railSignal?.platform && (
            <Text style={styles.etaPlatform}>Platform {railSignal.platform}</Text>
          )}
        </View>
        <View style={styles.etaItemRow}>
          <View style={[styles.etaItemDot, { backgroundColor: VENUE_ACCENT }]} />
          <Text style={styles.etaItemText}>{itemCopy}</Text>
        </View>
      </View>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function OrderStatusScreen() {
  const router  = useRouter();
  const params  = useLocalSearchParams<{ orderId: string }>();
  const orderId = params.orderId;

  const [order,           setOrder]           = useState<Order | null>(null);
  const [railSignal,      setRailSignal]      = useState<RailSignal | null>(null);
  const [cancelAvailable, setCancelAvailable] = useState(true);
  const [loading,         setLoading]         = useState(true);

  // 60-second cancel window
  useEffect(() => {
    const t = setTimeout(() => setCancelAvailable(false), 60_000);
    return () => clearTimeout(t);
  }, []);

  // Initial fetch — columns match actual orders schema
  useEffect(() => {
    if (!orderId) return;

    async function fetchOrder() {
      const { data, error } = await supabase
        .from('orders')
        .select(`
          id,
          status,
          payment_status,
          venue_id,
          item_name,
          settled_sats,
          routing_fee_sats,
          created_at,
          venue_partners (
            name,
            city
          )
        `)
        .eq('id', orderId)
        .single();

      if (error || !data) {
        console.error('[order-status] fetch error:', error);
        setLoading(false);
        return;
      }

      const venue = data.venue_partners as any;
      const built: Order = {
        id:               data.id,
        status:           data.status ?? 'pending',
        payment_status:   data.payment_status,
        venue_id:         data.venue_id,
        venue_name:       venue?.name ?? 'Venue',
        venue_city:       venue?.city ?? '',
        item_name:        data.item_name ?? '',
        settled_sats:     data.settled_sats ?? null,
        routing_fee_sats: data.routing_fee_sats ?? null,
        created_at:       data.created_at,
      };
      setOrder(built);

      // Fetch rail signal — venue_partners has no station_crs in current schema,
      // use city as fallback label until station_crs join is wired in Block 7.
      const { data: rail } = await supabase
        .from('rail_signal_current')
        .select('station_crs, next_departure_minutes, platform, destination')
        .limit(1)  // nearest / most relevant — refine in Block 7
        .maybeSingle();

      if (rail) setRailSignal(rail as RailSignal);

      setLoading(false);
    }

    fetchOrder();
  }, [orderId]);

  // Realtime — orders UPDATE fires when blink-webhook v9 writes payment_status='paid'
  useEffect(() => {
    if (!orderId) return;

    const orderSub = supabase
      .channel(`order-status-${orderId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${orderId}` },
        (payload) => {
          setOrder((prev) =>
            prev ? {
              ...prev,
              status:           payload.new.status           ?? prev.status,
              payment_status:   payload.new.payment_status   ?? prev.payment_status,
              settled_sats:     payload.new.settled_sats     ?? prev.settled_sats,
              routing_fee_sats: payload.new.routing_fee_sats ?? prev.routing_fee_sats,
            } : prev
          );
        }
      )
      .subscribe();

    const railSub = supabase
      .channel('rail-signal-current')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rail_signal_current' },
        (payload) => { setRailSignal(payload.new as RailSignal); }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(orderSub);
      supabase.removeChannel(railSub);
    };
  }, [orderId]);

  // ─── Render ────────────────────────────────────────────────────────────────

  if (loading || !order) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading your order…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      {/* 1. Payment Confirmed Banner */}
      <View style={styles.confirmedBanner}>
        <PulseDot />
        <View style={styles.confirmedTextBlock}>
          <Text style={styles.confirmedLabel}>Payment received</Text>
          <FeeBar settledSats={order.settled_sats} routingFeeSats={order.routing_fee_sats} />
          <Text style={styles.confirmedTimestamp}>{formatTimestamp(order.created_at)}</Text>
        </View>
      </View>

      {/* 2. Order Summary Card */}
      <View style={styles.summaryCard}>
        <Text style={styles.venueName}>{order.venue_name}</Text>
        {order.venue_city ? (
          <Text style={styles.venueLabel}>{order.venue_city}</Text>
        ) : null}

        <View style={styles.divider} />

        <View style={styles.itemRow}>
          <Text style={styles.itemName}>{order.item_name}</Text>
        </View>

        <View style={styles.divider} />

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalSats}>
            {order.settled_sats !== null
              ? `${order.settled_sats.toLocaleString()} sats`
              : 'Confirming…'}
          </Text>
        </View>
      </View>

      {/* 3. ETA Strip */}
      <EtaStrip railSignal={railSignal} itemName={order.item_name} orderStatus={order.status} />

      {/* 4. Order Reference */}
      <View style={styles.referenceBlock}>
        <Text style={styles.referenceCode}>{shortRef(order.id)}</Text>
        <Text style={styles.referenceHint}>Show this to collect your order</Text>
      </View>

      {/* 5. Support / Cancel */}
      <View style={styles.supportBlock}>
        <TouchableOpacity onPress={() => { /* TODO: in-app message stub */ }}>
          <Text style={styles.supportLink}>Something wrong?</Text>
        </TouchableOpacity>

        {cancelAvailable && (
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={() => { /* TODO: cancel order stub */ }}
          >
            <Text style={styles.cancelText}>Cancel order</Text>
          </TouchableOpacity>
        )}
      </View>
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen:            { flex: 1, backgroundColor: CARBON },
  scrollContent:     { paddingHorizontal: 20, paddingTop: 56, paddingBottom: 48, gap: 20 },
  loadingContainer:  { flex: 1, backgroundColor: CARBON, alignItems: 'center', justifyContent: 'center' },
  loadingText:       { color: TEXT_SECONDARY, fontSize: 15, fontFamily: 'System' },

  confirmedBanner: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: CARBON_SURFACE, borderRadius: 14,
    borderWidth: 1, borderColor: '#1F3A1F', padding: 18, gap: 14,
  },
  confirmedTextBlock: { flex: 1, gap: 4 },
  confirmedLabel:     { color: CONFIRMED_GREEN, fontSize: 16, fontWeight: '600', letterSpacing: 0.2 },
  feeBarText:         { color: TEXT_SECONDARY, fontSize: 13 },
  confirmedTimestamp: { color: TEXT_SECONDARY, fontSize: 12, marginTop: 2 },

  pulseDotContainer: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  pulseDotRing:      { position: 'absolute', width: 20, height: 20, borderRadius: 10, backgroundColor: CONFIRMED_GREEN },
  pulseDotCore:      { width: 10, height: 10, borderRadius: 5, backgroundColor: CONFIRMED_GREEN },

  summaryCard: {
    backgroundColor: CARBON_SURFACE, borderRadius: 14,
    borderWidth: 1, borderColor: CARBON_BORDER, padding: 18, gap: 10,
  },
  venueName:  { color: TEXT_PRIMARY, fontSize: 17, fontWeight: '600', letterSpacing: 0.1 },
  venueLabel: { color: TEXT_SECONDARY, fontSize: 13, marginTop: -6 },
  divider:    { height: 1, backgroundColor: CARBON_BORDER },
  itemRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  itemName:   { color: TEXT_PRIMARY, fontSize: 15 },
  totalRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalLabel: { color: TEXT_SECONDARY, fontSize: 14 },
  totalSats:  { color: TEXT_PRIMARY, fontSize: 15, fontWeight: '600' },

  etaStrip: { borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(107, 155, 174, 0.25)' },
  etaGlass: { backgroundColor: 'rgba(36, 36, 36, 0.85)', padding: 18, gap: 12 },
  etaHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  etaMinutes:  { color: VENUE_ACCENT, fontSize: 18, fontWeight: '700', letterSpacing: 0.2 },
  etaPlatform: { color: TEXT_SECONDARY, fontSize: 12 },
  etaItemRow:  { flexDirection: 'row', alignItems: 'center', gap: 10 },
  etaItemDot:  { width: 6, height: 6, borderRadius: 3 },
  etaItemText: { color: TEXT_PRIMARY, fontSize: 14, flex: 1 },

  referenceBlock: { alignItems: 'center', paddingVertical: 8, gap: 6 },
  referenceCode:  { color: TEXT_PRIMARY, fontSize: 28, fontWeight: '700', letterSpacing: 6, fontFamily: 'Courier' },
  referenceHint:  { color: TEXT_SECONDARY, fontSize: 12, letterSpacing: 0.3 },

  supportBlock:  { alignItems: 'center', gap: 12, paddingTop: 8 },
  supportLink:   { color: TEXT_SECONDARY, fontSize: 13, textDecorationLine: 'underline' },
  cancelButton:  { paddingVertical: 8, paddingHorizontal: 20, borderRadius: 8, borderWidth: 1, borderColor: '#5A2020' },
  cancelText:    { color: '#C0504D', fontSize: 13 },
});
