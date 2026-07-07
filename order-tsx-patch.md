# order.tsx — CC-63 Navigation Patch

Apply this change to `src/app/order.tsx`.

## 1. Add router import (if not already present)

```typescript
import { useRouter } from 'expo-router';
```

## 2. Initialise router inside the component

```typescript
const router = useRouter();
```

## 3. After invoice payment is confirmed, navigate to order-status

Locate where your component handles the successful invoice creation / payment
confirmation response. This will be in the callback or state update after
`create-order` returns the BOLT11 invoice and the user pays it.

Replace or extend the existing success handler:

```typescript
// After payment confirmed (invoice settled or optimistic confirmation):
router.replace({
  pathname: '/order-status',
  params: { orderId: createdOrderId },
});
```

Use `router.replace` (not `router.push`) so the user can't navigate back to
the invoice screen with the back gesture.

## 4. Ensure `createdOrderId` is in scope

The `create-order` Edge Function response must include the Supabase order UUID.
Verify the response shape — if the order ID is returned as `order.id` or
similar, capture it before navigating:

```typescript
const createdOrderId = response.data?.order_id ?? response.data?.id;
if (!createdOrderId) {
  console.error('[order] no order ID in response — cannot navigate to status');
  return;
}
router.replace({ pathname: '/order-status', params: { orderId: createdOrderId } });
```
