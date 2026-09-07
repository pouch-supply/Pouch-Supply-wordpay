import { Router, Request, Response } from "express";
import { fetchResource, saveResource, deleteSingleItem, getDb } from "../../serverDb";
import {
  sendOrderConfirmationEmail,
  sendOrderProcessingEmail,
  sendOrderShippedEmail,
  sendOutForDeliveryEmail,
  sendDeliveredEmail,
  sendOrderCancelledEmail,
  sendOrderRefundedEmail
} from "../services/emailService";
import { trackPurchaseCompleted, trackOrderRefunded, trackOrderShipped } from "../services/klaviyoService";

const router = Router();

/**
 * Order lifecycle notifications.
 *
 * `saveSingleOrder` is the ONLY place that sends order emails or fires Klaviyo
 * order events. Callers (checkout, the subscription worker, Royal Mail, the
 * admin routes) just persist the order and let the transition decide what to
 * send. Sending from the call sites as well is what previously produced
 * duplicate confirmations and admin notifications.
 *
 * Every dispatch is recorded in `data.notificationsSent` and is only ever sent
 * once per order, so a retried webhook, a callback racing the verify-payment
 * call, or a restarted worker cannot re-notify the customer.
 */
type OrderNotificationKey =
  | 'order_confirmation'
  | 'order_processing'
  | 'order_shipped'
  | 'out_for_delivery'
  | 'order_delivered'
  | 'order_cancelled'
  | 'order_refunded';

const FULFILLMENT_NOTIFICATION: Record<string, OrderNotificationKey> = {
  Processing: 'order_processing',
  Shipped: 'order_shipped',
  'Out for Delivery': 'out_for_delivery',
  Delivered: 'order_delivered',
  Cancelled: 'order_cancelled'
};

function dispatchOrderNotification(key: OrderNotificationKey, order: any, context: any = {}) {
  const label = `[Orders Trigger] ${key} for ${order.id}`;
  const fail = (e: any) => console.warn(`${label} failed:`, e?.message || e);

  switch (key) {
    case 'order_confirmation':
      // sendOrderConfirmationEmail also notifies the admin address internally,
      // so no separate admin call belongs here.
      sendOrderConfirmationEmail(order).catch(fail);
      trackPurchaseCompleted(order).catch(fail);
      break;
    case 'order_processing':
      sendOrderProcessingEmail(order).catch(fail);
      break;
    case 'order_shipped':
      sendOrderShippedEmail(order, order.trackingNumber, order.carrier).catch(fail);
      trackOrderShipped(order, order.trackingNumber, order.carrier).catch(fail);
      break;
    case 'out_for_delivery':
      sendOutForDeliveryEmail(order).catch(fail);
      break;
    case 'order_delivered':
      sendDeliveredEmail(order).catch(fail);
      break;
    case 'order_cancelled':
      sendOrderCancelledEmail(order, context.reason || 'Order cancelled by store administrator').catch(fail);
      break;
    case 'order_refunded':
      sendOrderRefundedEmail(order, context.refundAmount ?? order.total, context.reason).catch(fail);
      trackOrderRefunded(order, context.refundAmount ?? order.total).catch(fail);
      break;
  }
}

export async function saveSingleOrder(orderData: any) {
  const id = String(orderData.id || orderData.orderId || `PS${Math.floor(Math.random() * 90000 + 10000)}`);
  
  // Check existing order status to detect changes
  let existingOrder: any = null;
  try {
    const currentOrders: any[] = (await fetchResource('orders')) || [];
    existingOrder = currentOrders.find((o: any) => String(o.id) === id);
  } catch (_e) {}

  const items = orderData.items || existingOrder?.items || [];
  const subItem = items.find((i: any) =>
    i.isSubscription ||
    i.vendor === 'Subscription Pack' ||
    (i.productTitle && (i.productTitle.toLowerCase().includes('subscription') || i.productTitle.toLowerCase().includes('pack')))
  );

  const isSubscription = Boolean(orderData.isSubscription ?? existingOrder?.isSubscription ?? subItem);

  let subscriptionDetails = orderData.subscriptionDetails || existingOrder?.subscriptionDetails || null;

  if (isSubscription && !subscriptionDetails) {
    let planName = subItem?.subscriptionPlan || (orderData as any).subPlan || (orderData as any).subscriptionPlan || '';
    const rawPlan = (subItem?.subscriptionPlan || (orderData as any).subPlan || (orderData as any).subscriptionPlan || '').toLowerCase();
    const title = (subItem?.productTitle || '').toLowerCase();
    const prodId = (subItem?.productId || '').toLowerCase();

    if (rawPlan.includes('ultimate') || title.startsWith('ultimate') || title.includes('ultimate plan') || prodId.includes('ultimate')) {
      planName = 'ULTIMATE Plan';
    } else if (rawPlan.includes('pro') || title.startsWith('pro') || title.includes('pro plan') || prodId.includes('pro')) {
      planName = 'PRO Plan';
    } else if (rawPlan.includes('core') || title.startsWith('core') || title.includes('core plan') || prodId.includes('core')) {
      planName = 'CORE Plan';
    } else if (rawPlan.includes('lite') || title.startsWith('lite') || title.includes('lite plan') || prodId.includes('lite')) {
      planName = 'LITE Plan';
    } else if (subItem?.subscriptionPlan) {
      planName = subItem.subscriptionPlan;
    } else {
      planName = 'PRO Plan';
    }

    let frequency = subItem?.subscriptionFrequency || (orderData as any).subscriptionFrequency || '';
    let frequencyDiscount = subItem?.frequencyDiscount || (orderData as any).frequencyDiscount || '';

    if (!frequency) {
      if (title.includes('next day') || title.includes('1 day')) {
        frequency = 'Next Day (Test)';
      } else if (title.includes('weekly') && !title.includes('bi')) {
        frequency = 'Weekly';
      } else if (title.includes('bi-weekly') || title.includes('by weekly') || title.includes('2 week')) {
        frequency = 'Bi-Weekly';
      } else if (title.includes('month') || title.includes('one month')) {
        frequency = 'One Month';
      } else {
        frequency = 'Bi-Weekly';
      }
    }

    if (!frequencyDiscount) {
      if (frequency.includes('Next Day')) frequencyDiscount = '10%';
      else if (frequency === 'Weekly') frequencyDiscount = '5%';
      else if (frequency === 'One Month') frequencyDiscount = '12%';
      else frequencyDiscount = '10%';
    }

    const baseDate = new Date();
    const nextDate = new Date(baseDate);
    if (frequency.includes('Next Day')) {
      nextDate.setDate(baseDate.getDate() + 1);
    } else if (frequency === 'Weekly') {
      nextDate.setDate(baseDate.getDate() + 7);
    } else if (frequency === 'Bi-Weekly') {
      nextDate.setDate(baseDate.getDate() + 14);
    } else {
      nextDate.setDate(baseDate.getDate() + 30);
    }

    const rawSubItems = subItem?.subscriptionItems || subItem?.items || (orderData as any).subscriptionItems || [];
    let subItems = rawSubItems;

    const KNOWN_BRANDS = [
      '77', 'SNU', 'CUBA', 'KILLA', 'PABLO', 'VELO', 'WHITE FOX', 'ZYN', 
      'XQS', 'NORDIC SPIRIT', 'CLEW', 'FUMI', 'FEDRS', 'GRANT', 'ICE', 
      'LOOP', 'KURWA', 'DZRT', 'SIBERIA', 'SKRUF', 'DOPE', 'CHAPO', 
      'HIT', 'VOLT', 'FIX', 'STRNG', 'ACE', 'THUNDER'
    ];

    // If subItems array is empty, parse from title description
    if ((!subItems || subItems.length === 0) && subItem?.productTitle) {
      const rawTitle: string = subItem.productTitle.trim();
      let itemsSummary = '';
      if (rawTitle.includes(' - (')) {
        const start = rawTitle.indexOf(' - (') + 4;
        const end = rawTitle.lastIndexOf(')');
        itemsSummary = end > start ? rawTitle.substring(start, end) : rawTitle.substring(start);
      } else if (rawTitle.includes(' - ')) {
        const dashParts = rawTitle.split(' - ');
        itemsSummary = dashParts.slice(1).join(' - ').trim();
        if (itemsSummary.startsWith('(') && itemsSummary.endsWith(')')) {
          itemsSummary = itemsSummary.slice(1, -1);
        }
      }

      if (itemsSummary) {
        const parts: string[] = [];
        let cur = '';
        let depth = 0;
        for (let i = 0; i < itemsSummary.length; i++) {
          const c = itemsSummary[i];
          if (c === '(') depth++;
          else if (c === ')') depth--;
          if (c === ',' && depth === 0) {
            if (cur.trim()) parts.push(cur.trim());
            cur = '';
          } else {
            cur += c;
          }
        }
        if (cur.trim()) parts.push(cur.trim());

        const parsedProducts: any[] = [];
        parts.forEach(part => {
          const trimmed = part.trim();
          if (!trimmed) return;
          let qty = 1;
          let cleanPart = trimmed;
          const qtyMatch = cleanPart.match(/\(Qty\s*:\s*(\d+)\)/i) || cleanPart.match(/\bx\s*(\d+)\b/i);
          if (qtyMatch) {
            qty = parseInt(qtyMatch[1], 10) || 1;
            cleanPart = cleanPart.replace(/\(Qty\s*:\s*(\d+)\)/i, '').replace(/\bx\s*(\d+)\b/i, '').trim();
          }

          let brand = '';
          let name = cleanPart;
          let variant = 'Standard';

          if (cleanPart.includes(' — ') || cleanPart.includes(' – ') || (cleanPart.includes(' - ') && !cleanPart.includes(')-('))) {
            const segments = cleanPart.split(/\s*(?:—|–|-)\s*/);
            if (segments.length >= 3) {
              brand = segments[0].trim();
              name = segments[1].trim();
              variant = segments.slice(2).join(' — ').trim();
            } else if (segments.length === 2) {
              const firstSeg = segments[0].trim();
              const isBrand = KNOWN_BRANDS.some(kb => kb.toLowerCase() === firstSeg.toLowerCase());
              if (isBrand) {
                brand = firstSeg;
                name = segments[1].trim();
                const nestedMatch = name.match(/^(.*?)\s*\(([^)]+)\)$/);
                if (nestedMatch && nestedMatch[1] && nestedMatch[2]) {
                  name = nestedMatch[1].trim();
                  variant = nestedMatch[2].trim();
                }
              } else {
                name = segments[0].trim();
                variant = segments[1].trim();
              }
            }
          } else {
            const varMatch = cleanPart.match(/^(.*?)\s*\(([^)]+)\)$/);
            if (varMatch && varMatch[1] && varMatch[2]) {
              name = varMatch[1].trim();
              variant = varMatch[2].trim();
            }

            for (const kb of KNOWN_BRANDS) {
              if (name.toLowerCase().startsWith(kb.toLowerCase())) {
                brand = kb;
                name = name.substring(kb.length).replace(/^[\s—–-]+/, '').trim();
                break;
              }
            }
          }

          const formattedLabel = `${brand ? `${brand} — ` : ''}${name} — ${variant} (Qty:${qty})`;

          parsedProducts.push({ 
            brand: brand || undefined,
            vendor: brand || undefined,
            name, 
            productTitle: name,
            variant, 
            variantName: variant,
            quantity: qty,
            formattedLabel
          });
        });
        if (parsedProducts.length > 0) {
          subItems = parsedProducts;
        }
      }
    } else if (Array.isArray(subItems) && subItems.length > 0) {
      subItems = subItems.map((it: any) => {
        const rawBrand = (it.brand || it.vendor || it.product?.vendor || '').trim();
        let rawName = (it.name || it.productTitle || it.product?.title || it.title || 'Product').trim();
        let brand = rawBrand;
        if (!brand) {
          for (const kb of KNOWN_BRANDS) {
            if (rawName.toLowerCase().startsWith(kb.toLowerCase())) {
              brand = kb;
              break;
            }
          }
        }
        if (brand && rawName.toLowerCase().startsWith(brand.toLowerCase())) {
          rawName = rawName.substring(brand.length).replace(/^[\s—–-]+/, '').trim();
        }
        const variant = (it.variant || it.variantName || it.product?.concreteVariantName || (it.product as any)?.variant || 'Standard').trim();
        const qty = Number(it.quantity || 1);
        const formattedLabel = `${brand ? `${brand} — ` : ''}${rawName} — ${variant} (Qty:${qty})`;
        return {
          brand: brand || undefined,
          vendor: brand || undefined,
          name: rawName,
          productTitle: rawName,
          variant,
          variantName: variant,
          quantity: qty,
          image: it.image || it.product?.image || '',
          price: it.price || it.product?.price || 0,
          formattedLabel
        };
      });
    }

    subscriptionDetails = {
      planName,
      frequency,
      frequencyDiscount,
      paymentStatus: 'Paid',
      items: subItems,
      selectedProducts: subItems,
      lastPaymentDate: baseDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      nextPaymentDate: nextDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    };
  }

  let tags = Array.isArray(orderData.tags) ? orderData.tags : (existingOrder?.tags || ['Storefront', 'Online Order']);
  if (isSubscription && !tags.some((t: string) => t.toLowerCase().includes('subscription'))) {
    tags = [...tags, 'Subscription Order'];
  }

  const formattedOrder = {
    id,
    customerName: orderData.customerName || existingOrder?.customerName || 'Valued Customer',
    customerEmail: orderData.customerEmail || existingOrder?.customerEmail || 'customer@pouch-supply.com',
    tags,
    isSubscription,
    subscriptionDetails,
    fulfillmentStatus: orderData.fulfillmentStatus || existingOrder?.fulfillmentStatus || 'Unfulfilled',
    paymentStatus: orderData.paymentStatus || existingOrder?.paymentStatus || (orderData.total === 0 ? 'Paid' : 'Pending'),
    worldpayTxId: orderData.worldpayTxId || orderData.gatewayTxId || existingOrder?.worldpayTxId || null,
    worldpayAuthCode: orderData.worldpayAuthCode || orderData.gatewayAuthCode || existingOrder?.worldpayAuthCode || null,
    gatewayTxId: orderData.gatewayTxId || orderData.worldpayTxId || existingOrder?.gatewayTxId || null,
    gatewayAuthCode: orderData.gatewayAuthCode || orderData.worldpayAuthCode || existingOrder?.gatewayAuthCode || null,
    cardBrand: orderData.cardBrand || existingOrder?.cardBrand || 'Card',
    total: typeof orderData.total === 'number' ? orderData.total : parseFloat(orderData.total) || existingOrder?.total || 0,
    subtotal: typeof orderData.subtotal === 'number' ? orderData.subtotal : (typeof existingOrder?.subtotal === 'number' ? existingOrder.subtotal : undefined),
    shippingCost: typeof orderData.shippingCost === 'number' ? orderData.shippingCost : (typeof orderData.deliveryCost === 'number' ? orderData.deliveryCost : (typeof existingOrder?.shippingCost === 'number' ? existingOrder.shippingCost : undefined)),
    deliveryCost: typeof orderData.deliveryCost === 'number' ? orderData.deliveryCost : (typeof orderData.shippingCost === 'number' ? orderData.shippingCost : (typeof existingOrder?.deliveryCost === 'number' ? existingOrder.deliveryCost : undefined)),
    storeCreditApplied: typeof orderData.storeCreditApplied === 'number' ? orderData.storeCreditApplied : parseFloat(orderData.storeCreditApplied) || existingOrder?.storeCreditApplied || 0,
    destination: orderData.destination || orderData.address || existingOrder?.destination || 'United Kingdom',
    date: orderData.date || existingOrder?.date || (new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
    deliveryMethod: orderData.deliveryMethod || existingOrder?.deliveryMethod || 'Royal Mail Tracked 24/48',
    subscriptionId: orderData.subscriptionId || existingOrder?.subscriptionId || null,
    items,
    discountApplied: orderData.discountApplied || existingOrder?.discountApplied || null,
    trackingNumber: orderData.trackingNumber || existingOrder?.trackingNumber || null,
    carrier: orderData.carrier || existingOrder?.carrier || null,
    data: {
      ...(existingOrder?.data || {}),
      ...(orderData?.data || {}),
      shippingCost: orderData.shippingCost ?? existingOrder?.data?.shippingCost,
      deliveryCost: orderData.deliveryCost ?? existingOrder?.data?.deliveryCost,
      subtotal: orderData.subtotal ?? existingOrder?.data?.subtotal,
      address: orderData.address || existingOrder?.data?.address,
      paymentMethod: orderData.paymentMethod || existingOrder?.data?.paymentMethod,
      // Merge rather than overwrite: a caller passing its own `data` block must
      // not be able to wipe the record of what has already been emailed.
      notificationsSent: {
        ...(existingOrder?.data?.notificationsSent || {}),
        ...(orderData?.data?.notificationsSent || {})
      }
    }
  };

  // ------------------------------------------------------------------
  // Decide which notifications this save should produce.
  //
  // This runs BEFORE persisting so the "already sent" marks are written in the
  // same save. A concurrent save for the same order then reads those marks and
  // sends nothing, which is what makes the flow safe against the Worldpay
  // callback and verify-payment call racing each other.
  // ------------------------------------------------------------------
  const alreadySent: Record<string, string> = formattedOrder.data.notificationsSent || {};
  const pending: Array<{ key: OrderNotificationKey; context: any }> = [];

  const queue = (key: OrderNotificationKey, context: any = {}) => {
    if (alreadySent[key]) {
      console.log(`[Orders Trigger] Skipping ${key} for ${id} — already sent at ${alreadySent[key]}.`);
      return;
    }
    if (pending.some(p => p.key === key)) return;
    pending.push({ key, context });
  };

  try {
    const isNewOrder = !existingOrder;
    const paymentJustPaid = existingOrder?.paymentStatus !== 'Paid' && formattedOrder.paymentStatus === 'Paid';

    // 1. Payment succeeded (on creation or on a later transition to Paid)
    if (formattedOrder.paymentStatus === 'Paid' && (isNewOrder || paymentJustPaid)) {
      queue('order_confirmation');
    }

    // 2. Fulfillment status transition
    const previousFulfillment = existingOrder?.fulfillmentStatus;
    if (existingOrder && previousFulfillment !== formattedOrder.fulfillmentStatus) {
      console.log(
        `[Orders Trigger] Fulfillment status changed for ${id}: ${previousFulfillment} -> ${formattedOrder.fulfillmentStatus}`
      );
      const key = FULFILLMENT_NOTIFICATION[formattedOrder.fulfillmentStatus];
      if (key) {
        queue(key, { reason: orderData.reason || orderData.cancellationReason });
      }
    }

    // 3. Refund transition
    if (existingOrder && existingOrder.paymentStatus !== 'Refunded' && formattedOrder.paymentStatus === 'Refunded') {
      queue('order_refunded', {
        refundAmount: orderData.refundAmount ?? formattedOrder.total,
        reason: orderData.refundReason || orderData.reason
      });
    }
  } catch (triggerErr) {
    console.warn('[Orders Trigger] Error deciding automated notifications:', triggerErr);
  }

  const dispatchedAt = new Date().toISOString();
  for (const item of pending) {
    formattedOrder.data.notificationsSent[item.key] = dispatchedAt;
  }

  // Try Prisma first
  try {
    const { prisma } = await import('../../src/lib/prisma');
    await prisma.order.upsert({
      where: { id },
      update: formattedOrder,
      create: formattedOrder
    });
  } catch (prismaErr: any) {
    console.warn('[Orders Router] Prisma save warning:', prismaErr?.message);
  }

  // Sync to StoreResource
  try {
    const currentOrders: any[] = (await fetchResource('orders')) || [];
    const existingIdx = currentOrders.findIndex((o: any) => String(o.id) === id);
    if (existingIdx !== -1) {
      currentOrders[existingIdx] = { ...currentOrders[existingIdx], ...formattedOrder };
    } else {
      currentOrders.unshift(formattedOrder);
    }
    await saveResource('orders', currentOrders);
  } catch (resourceErr) {
    console.error('[Orders Router] StoreResource save error:', resourceErr);
  }

  // Now that the marks are persisted, actually send.
  for (const item of pending) {
    console.log(`[Orders Trigger] Dispatching ${item.key} for ${id}`);
    dispatchOrderNotification(item.key, formattedOrder, item.context);
  }

  return formattedOrder;
}

// GET all orders - return all valid persisted orders
router.get("/", async (_req: Request, res: Response) => {
  try {
    const data: any[] = (await fetchResource("orders")) || [];
    const validOrders = data.filter((o: any) => o && o.id);
    res.json(validOrders);
  } catch (err: any) {
    console.error("[Orders Router] GET Error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch orders" });
  }
});

// GET single order by ID
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const orders: any[] = (await fetchResource("orders")) || [];
    const found = orders.find((o: any) => String(o.id) === String(id));
    if (found) {
      return res.json(found);
    }
    
    // Fallback to Prisma
    try {
      const { prisma } = await import('../../src/lib/prisma');
      const prismaOrder = await prisma.order.findUnique({ where: { id } });
      if (prismaOrder) {
        return res.json(prismaOrder);
      }
    } catch (_e) {}

    res.status(404).json({ error: "Order not found" });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch order" });
  }
});

// POST /create - Create a single order
router.post("/create", async (req: Request, res: Response) => {
  try {
    const orderData = req.body;
    if (!orderData || typeof orderData !== 'object') {
      return res.status(400).json({ error: "Order data object is required" });
    }

    const savedOrder = await saveSingleOrder(orderData);
    res.json({ success: true, order: savedOrder });
  } catch (err: any) {
    console.error("[Orders Router] POST /create Error:", err);
    res.status(500).json({ error: err.message || "Failed to create order" });
  }
});

// POST / - Create or sync orders (accepts single order or array)
router.post("/", async (req: Request, res: Response) => {
  try {
    const payload = req.body;

    if (Array.isArray(payload)) {
      const formattedOrders = payload.map((orderData: any) => {
        const id = String(orderData.id || orderData.orderId || `PS${Math.floor(Math.random() * 90000 + 10000)}`);
        return {
          id,
          customerName: orderData.customerName || 'Valued Customer',
          customerEmail: orderData.customerEmail || 'customer@pouch-supply.com',
          tags: Array.isArray(orderData.tags) ? orderData.tags : ['Storefront', 'Online Order'],
          fulfillmentStatus: orderData.fulfillmentStatus || 'Unfulfilled',
          paymentStatus: orderData.paymentStatus || (orderData.total === 0 ? 'Paid' : 'Pending'),
          worldpayTxId: orderData.worldpayTxId || orderData.gatewayTxId || null,
          worldpayAuthCode: orderData.worldpayAuthCode || orderData.gatewayAuthCode || null,
          gatewayTxId: orderData.gatewayTxId || orderData.worldpayTxId || null,
          gatewayAuthCode: orderData.gatewayAuthCode || orderData.worldpayAuthCode || null,
          cardBrand: orderData.cardBrand || 'Card',
          total: typeof orderData.total === 'number' ? orderData.total : parseFloat(orderData.total) || 0,
          storeCreditApplied: typeof orderData.storeCreditApplied === 'number' ? orderData.storeCreditApplied : parseFloat(orderData.storeCreditApplied) || 0,
          destination: orderData.destination || orderData.address || 'United Kingdom',
          date: orderData.date || (new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
          deliveryMethod: orderData.deliveryMethod || 'Royal Mail Tracked 24/48',
          items: orderData.items || [],
          discountApplied: orderData.discountApplied || null,
          trackingNumber: orderData.trackingNumber || null,
          carrier: orderData.carrier || null,
          data: orderData.data || {}
        };
      });

      const savedOrders = await saveResource('orders', formattedOrders);
      return res.json(savedOrders);
    } else if (payload && typeof payload === 'object') {
      const savedOrder = await saveSingleOrder(payload);
      return res.json({ success: true, order: savedOrder });
    } else {
      return res.status(400).json({ error: "Invalid order payload" });
    }
  } catch (err: any) {
    console.error("[Orders Router] POST Error:", err);
    res.status(500).json({ error: err.message || "Failed to persist orders" });
  }
});

// POST /:id/cancel - Customer Cancel Order Workflow
router.post("/:id/cancel", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason, refundMethod = "original", customerEmail } = req.body;

    const currentOrders: any[] = (await fetchResource("orders")) || [];
    const foundIdx = currentOrders.findIndex((o: any) => String(o.id) === String(id));

    if (foundIdx === -1) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = currentOrders[foundIdx];

    if (order.fulfillmentStatus === "Shipped" || order.fulfillmentStatus === "Delivered") {
      return res.status(400).json({ error: "Order has already shipped and cannot be directly cancelled. Please request a return." });
    }

    if (order.fulfillmentStatus === "Cancelled" || order.paymentStatus === "Refunded") {
      return res.status(400).json({ error: "Order is already cancelled or refunded." });
    }

    // Build a patch instead of mutating `order`. fetchResource hands back the
    // cached object itself, so mutating it in place would make saveSingleOrder
    // see the NEW status as the previous one and skip the transition emails.
    const cancellationReason = reason || "Customer requested cancellation";
    const patch: any = {
      ...order,
      fulfillmentStatus: "Cancelled",
      paymentStatus: "Refunded",
      cancellationReason,
      cancelledAt: new Date().toISOString(),
      reason: cancellationReason,
      refundAmount: order.total,
      refundReason: `Cancellation refund (${refundMethod === "store_credit" ? "Store Credit" : "Original Payment"})`
    };

    if (refundMethod === "store_credit") {
      // Add store credit to customer account
      try {
        const customersList: any[] = (await fetchResource("customers")) || [];
        const cIdx = customersList.findIndex((c: any) => c.email.toLowerCase() === (order.customerEmail || "").toLowerCase());
        if (cIdx !== -1) {
          customersList[cIdx].storeCredit = (customersList[cIdx].storeCredit || 0) + (order.total || 0);
          await saveResource("customers", customersList);
          console.log(`[Cancel Order] Added £${order.total} store credit to ${order.customerEmail}`);
        }
      } catch (custErr) {
        console.warn("[Cancel Order] Failed to update customer store credit:", custErr);
      }
    } else {
      // Process refund via Worldpay Payment Gateway if transaction ID is attached
      if (order.worldpayTxId || order.gatewayTxId) {
        try {
          const { refundWorldpayPayment } = await import("../services/worldpayRefund");
          await refundWorldpayPayment({
            order,
            amount: order.total,
            reason: `Customer cancellation: ${reason || "Changed mind"}`,
            transactionId: order.worldpayTxId || order.gatewayTxId
          });
        } catch (wpErr) {
          console.warn("[Cancel Order] Worldpay refund trigger notice:", wpErr);
        }
      }
    }

    patch.returnRequest = {
      type: "Cancellation",
      reason: cancellationReason,
      refundMethod,
      status: "Completed",
      requestedAt: new Date().toISOString()
    };

    // saveSingleOrder emits the cancellation and refund notifications from the
    // status transition — sending them here as well is what produced the
    // duplicate cancellation emails.
    const updatedOrder = await saveSingleOrder(patch);

    res.json({ success: true, message: "Order successfully cancelled and refund initiated.", order: updatedOrder });
  } catch (err: any) {
    console.error("[Orders Router] POST /:id/cancel Error:", err);
    res.status(500).json({ error: err.message || "Failed to cancel order" });
  }
});

// POST /:id/return-request - Customer Return / Refund / Exchange Request Workflow
router.post("/:id/return-request", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { type, reason, itemsToReturn, exchangeNotes, refundMethod } = req.body;

    if (!type || !reason) {
      return res.status(400).json({ error: "Request type and reason are required." });
    }

    const currentOrders: any[] = (await fetchResource("orders")) || [];
    const foundIdx = currentOrders.findIndex((o: any) => String(o.id) === String(id));

    if (foundIdx === -1) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = currentOrders[foundIdx];

    const returnRequest = {
      type: type || "Return", // 'Return' | 'Refund' | 'Exchange'
      reason,
      itemsToReturn: itemsToReturn || order.items || [],
      exchangeNotes: exchangeNotes || "",
      refundMethod: refundMethod || "original",
      status: "Pending", // 'Pending' | 'Approved' | 'Declined' | 'Completed'
      requestedAt: new Date().toISOString()
    };

    const existingTags = Array.isArray(order.tags) ? [...order.tags] : [];
    if (!existingTags.includes(`${type} Requested`)) {
      existingTags.push(`${type} Requested`);
    }

    const updatedOrder = await saveSingleOrder({
      ...order,
      returnRequest,
      tags: existingTags
    });

    // A return/exchange request is an acknowledgement rather than a lifecycle
    // status change, so it has no transition to hang off and is sent directly.
    try {
      if (type === "Exchange") {
        const { sendOrderExchangedEmail } = await import("../services/emailService");
        await sendOrderExchangedEmail(updatedOrder, exchangeNotes || "Product exchange requested", reason);
      } else {
        const { sendOrderCancelledEmail } = await import("../services/emailService");
        await sendOrderCancelledEmail(updatedOrder, `Return/Refund request initiated: ${reason}`);
      }
    } catch (e) {
      console.warn("Return request email notification error:", e);
    }

    res.json({ success: true, message: `${type} request submitted successfully. Our team will review your request.`, order: updatedOrder });
  } catch (err: any) {
    console.error("[Orders Router] Return Request Error:", err);
    res.status(500).json({ error: err.message || "Failed to submit return request" });
  }
});

// POST /:id/admin-action - Admin Approve / Decline / Process Return, Refund, or Exchange
router.post("/:id/admin-action", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { action, refundAmount, reason } = req.body;

    const currentOrders: any[] = (await fetchResource("orders")) || [];
    const foundIdx = currentOrders.findIndex((o: any) => String(o.id) === String(id));

    if (foundIdx === -1) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = currentOrders[foundIdx];
    const amountToRefund = typeof refundAmount === "number" ? refundAmount : (order.total || 0);

    // Patch rather than mutate — see the note in the cancel route.
    const patch: any = { ...order };
    let runExchangeEmail = false;

    if (action === "approve_return" || action === "process_refund") {
      patch.paymentStatus = "Refunded";
      patch.refundAmount = amountToRefund;
      patch.refundReason = reason || "Refund processed by store administrator";
      if (order.returnRequest) {
        patch.returnRequest = {
          ...order.returnRequest,
          status: "Completed",
          processedAt: new Date().toISOString()
        };
      }

      // Execute the actual payment provider refund.
      if (order.worldpayTxId || order.gatewayTxId) {
        try {
          const { refundWorldpayPayment } = await import("../services/worldpayRefund");
          const refundResult = await refundWorldpayPayment({
            order,
            amount: amountToRefund,
            reason: reason || "Admin processed refund",
            transactionId: order.worldpayTxId || order.gatewayTxId
          });
          patch.refundDetails = {
            refundRef: refundResult.refundRef,
            amount: refundResult.amount,
            reason: reason || "Admin processed refund",
            gatewayContacted: refundResult.gatewayContacted,
            gatewayMessage: refundResult.message,
            refundedAt: new Date().toISOString()
          };
        } catch (wpErr) {
          console.warn("[Admin Action] Worldpay refund trigger notice:", wpErr);
        }
      }
      // The refund email is emitted by the Paid -> Refunded transition in
      // saveSingleOrder; sending it here too duplicated it.

    } else if (action === "complete_exchange") {
      patch.fulfillmentStatus = "Exchanged";
      if (order.returnRequest) {
        patch.returnRequest = {
          ...order.returnRequest,
          status: "Completed",
          completedAt: new Date().toISOString()
        };
      }
      runExchangeEmail = true;

    } else if (action === "decline_return") {
      if (order.returnRequest) {
        patch.returnRequest = {
          ...order.returnRequest,
          status: "Declined",
          declinedReason: reason || "Request declined by administrator"
        };
      }
    }

    const updatedOrder = await saveSingleOrder(patch);

    // 'Exchanged' is not one of the tracked lifecycle statuses, so this one
    // still has to be sent explicitly.
    if (runExchangeEmail) {
      const { sendOrderExchangedEmail } = await import("../services/emailService");
      sendOrderExchangedEmail(updatedOrder, "Exchange replacement item dispatched", reason || "Exchange approved")
        .catch(e => console.warn("Exchange email fail:", e));
    }
    res.json({ success: true, message: `Admin action '${action}' processed successfully.`, order: updatedOrder });
  } catch (err: any) {
    console.error("[Orders Router] Admin Action Error:", err);
    res.status(500).json({ error: err.message || "Failed to execute admin action" });
  }
});

// DELETE /:id - Permanently delete a single order
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const deleted = await deleteSingleItem("orders", id);
    if (deleted) {
      return res.json({ success: true, deletedId: id });
    } else {
      return res.status(404).json({ error: "Order not found or could not be deleted" });
    }
  } catch (err: any) {
    console.error("[Orders Router] DELETE Error:", err);
    res.status(500).json({ error: err.message || "Failed to delete order" });
  }
});

export default router;
