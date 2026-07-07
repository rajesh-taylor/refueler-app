/**
 * CC-63 — Order Status & ETA Screen
 *
 * Route: src/app/order-status.tsx
 * Accessible from order.tsx after invoice payment confirmation.
 *
 * Data sources:
 *  - orders table (Supabase) — order record, status, items, venue_id
 *  - rail_signal_current (Supabase) — live train ETA data
 *  - Blink webhook settlement signal (reflected via orders.status realtime)
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
import { supabase } from '../lib/supabaseClient';

// ─── Types ───────────────────────────────────────────────────────────────────

interface OrderItem {
  name: string;
  quantity: number;
  unit_price_sats: number;
}

interface Order {
  id: string;
  status: string;
  venue_id: string;
  venue_name: string;
  location_label: string;
  items: OrderItem[];
  total_sats: number;
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

const CARBON = '#1A1A1A';
const CARBON_SURFACE = '#242424';
const CARBON_BORDER = '#2E2E2E';
const TEXT_PRIMARY = '#F5F5F0';
const TEXT_SECONDARY = '#8A8A8A';
const CONFIRMED_GREEN = '#4CAF50'; // muted, not neon
const VENUE_ACCENT = '#6B9BAE';    // muted teal — placeholder venue secondary colour

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortRef(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 8).toUpperCase();
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function itemStatusCopy(item: OrderItem, orderStatus: string): string {
  if (orderStatus === 'ready') return `Your ${item.name.toLowerCase()} is ready for collection`;
  if (orderStatus === 'preparing') return `Your ${item.name.toLowerCase()} is being prepared`;
  return `Your ${item.name.toLowerCase()} will be ready when you arrive`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Muted pulsing dot for payment confirmed state */
function PulseDot() {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.9)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(scale, {
            toValue: 1.4,
            duration: 900,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 0,
            duration: 900,
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(scale, { toValue: 1, duration: 0, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.9, duration: 0, useNativeDriver: true }),
        ]),
      ])
    ).start();
  }, []);

  return (
    <View style={styles.pulseDotContainer}>
      <Animated.View
        style={[
          styles.pulseDotRing,
          { transform: [{ scale }], opacity },
        ]}
      />
      <View style={styles.pulseDotCore} />
    </View>
  );
}

/** Fee bar — gross | fee | net — placeholder until CC-fee-monitor wires real data */
function FeeBar({
  totalSats,
  routingFeeSats,
}: {
  totalSats: number;
  routingFeeSats: number | null;
}) {
  const feeLabel =
    routingFeeSats !== null ? `${routingFeeSats} sat routing fee` : 'fee: pending';
  const netLabel =
    routingFeeSats !== null
      ? `${totalSats - routingFeeSats} sats net`
      : `${totalSats} sats gross`;

  return (
    <Text style={styles.feeBarText}>
      {totalSats} sats received · {feeLabel}
    </Text>
  );
}

/** ETA strip — Apple Liquid Glass aesthetic over carbon, muted venue accent */
function EtaStrip({
  railSignal,
  order,
}: {
  railSignal: RailSignal | null;
  order: Order;
}) {
  const etaMinutes = railSignal?.next_departure_minutes ?? null;
  const etaLabel =
    etaMinutes === null
      ? 'ETA loading…'
      : etaMinutes === 0
      ? 'Train arriving now'
      : `Train in ${etaMinutes} min`;

  return (
    <View style={styles.etaStrip}>
      {/* Frosted glass layer */}
      <View style={styles.etaGlass}>
        <View style={styles.etaHeader}>
          <Text style={styles.etaMinutes}>{etaLabel}</Text>
          {railSignal?.platform && (
            <Text style={styles.etaPlatform}>Platform {railSignal.platform}</Text>
          )}
        </View>

        {/* Per-item status copy */}
        {order.items.map((item, i) => (
          <View key={i} style={styles.etaItemRow}>
            <View style={[styles.etaItemDot, { backgroundColor: VENUE_ACCENT }]} />
            <Text style={styles.etaItemText}>
              {itemStatusCopy(item, order.status)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function OrderStatusScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ orderId: string }>();
  const orderId = params.orderId;

  const [order, setOrder] = useState<Order | null>(null);
  const [railSignal, setRailSignal] = useState<RailSignal | null>(null);
  const [cancelAvailable, setCancelAvailable] = useState(true);
  const [loading, setLoading] = useState(true);

  // 60-second cancel window
  useEffect(() => {
    const timer = setTimeout(() => setCancelAvailable(false), 60_000);
    return () => clearTimeout(timer);
  }, []);

  // Initial data fetch
  useEffect(() => {
    if (!orderId) return;

    async function fetchOrder() {
      const { data, error } = await supabase
        .from('orders')
        .select(`
          id,
          status,
          venue_id,
          items,
          total_sats,
          routing_fee_sats,
          created_at,
          venue_partners (
            name,
            location_label,
            station_crs
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
      setOrder({
        id: data.id,
        status: data.status,
        venue_id: data.venue_id,
        venue_name: venue?.name ?? 'Venue',
        location_label: venue?.location_label ?? '',
        items: data.items ?? [],
        total_sats: data.total_sats,
        routing_fee_sats: data.routing_fee_sats ?? null,
        created_at: data.created_at,
      });

      // Fetch rail signal for venue station
      if (venue?.station_crs) {
        const { data: rail } = await supabase
          .from('rail_signal_current')
          .select('station_crs, next_departure_minutes, platform, destination')
          .eq('station_crs', venue.station_crs)
          .maybeSingle();

        if (rail) setRailSignal(rail as RailSignal);
      }

      setLoading(false);
    }

    fetchOrder();
  }, [orderId]);

  // Realtime subscriptions
  useEffect(() => {
    if (!orderId) return;

    // Orders status updates (Blink webhook → order.status)
    const orderSub = supabase
      .channel('order-status')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'orders',
          filter: `id=eq.${orderId}`,
        },
        (payload) => {
          setOrder((prev) =>
            prev
              ? {
                  ...prev,
                  status: payload.new.status,
                  routing_fee_sats: payload.new.routing_fee_sats ?? prev.routing_fee_sats,
                }
              : prev
          );
        }
      )
      .subscribe();

    // Rail signal updates
    const railSub = supabase
      .channel('rail-signal')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rail_signal_current' },
        (payload) => {
          if (payload.new.station_crs === order?.venue_id) {
            setRailSignal(payload.new as RailSignal);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(orderSub);
      supabase.removeChannel(railSub);
    };
  }, [orderId, order?.venue_id]);

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
          <FeeBar
            totalSats={order.total_sats}
            routingFeeSats={order.routing_fee_sats}
          />
          <Text style={styles.confirmedTimestamp}>
            {formatTimestamp(order.created_at)}
          </Text>
        </View>
      </View>

      {/* 2. Order Summary Card */}
      <View style={styles.summaryCard}>
        <Text style={styles.venueName}>{order.venue_name}</Text>
        {order.location_label ? (
          <Text style={styles.venueLabel}>{order.location_label}</Text>
        ) : null}

        <View style={styles.divider} />

        {order.items.map((item, i) => (
          <View key={i} style={styles.itemRow}>
            <Text style={styles.itemName}>{item.name}</Text>
            <Text style={styles.itemQty}>×{item.quantity}</Text>
          </View>
        ))}

        <View style={styles.divider} />

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalSats}>{order.total_sats} sats</Text>
        </View>
      </View>

      {/* 3. ETA Strip */}
      <EtaStrip railSignal={railSignal} order={order} />

      {/* 4. Order Reference */}
      <View style={styles.referenceBlock}>
        <Text style={styles.referenceCode}>{shortRef(order.id)}</Text>
        <Text style={styles.referenceHint}>Show this to collect your order</Text>
      </View>

      {/* 5. Support / Cancel */}
      <View style={styles.supportBlock}>
        <TouchableOpacity
          onPress={() => {
            /* TODO: in-app message stub */
          }}
        >
          <Text style={styles.supportLink}>Something wrong?</Text>
        </TouchableOpacity>

        {cancelAvailable && (
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={() => {
              /* TODO: cancel order stub */
            }}
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
  screen: {
    flex: 1,
    backgroundColor: CARBON,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 48,
    gap: 20,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: CARBON,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: TEXT_SECONDARY,
    fontSize: 15,
    fontFamily: 'System',
  },

  // ── Banner ──
  confirmedBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: CARBON_SURFACE,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1F3A1F', // dark green tint on border, not dominant
    padding: 18,
    gap: 14,
  },
  confirmedTextBlock: {
    flex: 1,
    gap: 4,
  },
  confirmedLabel: {
    color: CONFIRMED_GREEN,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  feeBarText: {
    color: TEXT_SECONDARY,
    fontSize: 13,
  },
  confirmedTimestamp: {
    color: TEXT_SECONDARY,
    fontSize: 12,
    marginTop: 2,
  },

  // ── Pulse dot ──
  pulseDotContainer: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  pulseDotRing: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: CONFIRMED_GREEN,
  },
  pulseDotCore: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: CONFIRMED_GREEN,
  },

  // ── Summary Card ──
  summaryCard: {
    backgroundColor: CARBON_SURFACE,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: CARBON_BORDER,
    padding: 18,
    gap: 10,
  },
  venueName: {
    color: TEXT_PRIMARY,
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  venueLabel: {
    color: TEXT_SECONDARY,
    fontSize: 13,
    marginTop: -6,
  },
  divider: {
    height: 1,
    backgroundColor: CARBON_BORDER,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  itemName: {
    color: TEXT_PRIMARY,
    fontSize: 15,
  },
  itemQty: {
    color: TEXT_SECONDARY,
    fontSize: 14,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  totalLabel: {
    color: TEXT_SECONDARY,
    fontSize: 14,
  },
  totalSats: {
    color: TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: '600',
  },

  // ── ETA Strip ──
  etaStrip: {
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(107, 155, 174, 0.25)', // venue accent, very subtle
  },
  etaGlass: {
    backgroundColor: 'rgba(36, 36, 36, 0.85)', // carbon base + slight transparency
    padding: 18,
    gap: 12,
  },
  etaHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  etaMinutes: {
    color: VENUE_ACCENT,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  etaPlatform: {
    color: TEXT_SECONDARY,
    fontSize: 12,
  },
  etaItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  etaItemDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  etaItemText: {
    color: TEXT_PRIMARY,
    fontSize: 14,
    flex: 1,
  },

  // ── Reference ──
  referenceBlock: {
    alignItems: 'center',
    paddingVertical: 8,
    gap: 6,
  },
  referenceCode: {
    color: TEXT_PRIMARY,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 6,
    fontFamily: 'Courier',
  },
  referenceHint: {
    color: TEXT_SECONDARY,
    fontSize: 12,
    letterSpacing: 0.3,
  },

  // ── Support ──
  supportBlock: {
    alignItems: 'center',
    gap: 12,
    paddingTop: 8,
  },
  supportLink: {
    color: TEXT_SECONDARY,
    fontSize: 13,
    textDecorationLine: 'underline',
  },
  cancelButton: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#5A2020',
  },
  cancelText: {
    color: '#C0504D',
    fontSize: 13,
  },
});
