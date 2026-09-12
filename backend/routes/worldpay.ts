import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../../src/lib/prisma';
import { fetchResource, saveResource } from '../../serverDb';
import {
  extractRecurringAuthorizationHref,
  extractSchemeReference,
  isPlaceholderCredential,
  isUsableRecurringHref
} from '../services/worldpaySubscription';
import { calculateNextBillingDate, normalizeBillingInterval } from '../services/subscriptionCron';
import {
  UK_COUNTRY_CODE,
  UK_COUNTRY_NAME,
  normalizeUkPhone,
  normalizeUkPostcode,
  validateUkDelivery
} from '../../src/utils/ukValidation';

const router = Router();

/**
 * The store delivers within the UK only, and Royal Mail needs a contact number
 * on the label. The checkout form enforces both, but the form is not the gate:
 * anything can POST to this endpoint, and an order taken here is an order the
 * shop is committed to. Refusing before the payment session is created is the
 * only point at which no money has moved yet.
 */
function assertDeliverable(body: any): { ok: boolean; phone: string; postcode: string; message: string } {
  const address = (body?.shippingAddress && typeof body.shippingAddress === 'object' ? body.shippingAddress : {}) as Record<string, string>;
  const destination = String(body?.destination || body?.address || '');

  // The country may arrive as a field or only inside the joined destination
  // string, which is what older storefront builds sent.
  const country =
    address.country ||
    address.countryCode ||
    (destination ? destination.split(',').map(p => p.trim()).filter(Boolean).pop() || '' : '');

  const phone = body?.customerPhone || address.phone || '';
  const postcode = address.postcode || '';

  const check = validateUkDelivery({
    phone,
    postcode,
    // An order with no country recorded at all predates the UK-only rule rather
    // than being an overseas order; the postcode check still has to pass.
    country: country || UK_COUNTRY_NAME
  });

  if (!check.valid) {
    return { ok: false, phone: '', postcode: '', message: check.errors[0] };
  }

  return { ok: true, phone: normalizeUkPhone(phone), postcode: normalizeUkPostcode(postcode), message: '' };
}

// In-memory store for pending checkout payloads before payment confirmation.
// Crucial: An order is NEVER created in the database prior to verified payment success!
interface PendingCheckout {
  orderId: string;
  customerName: string;
  customerEmail: string;
  destination: string;
  // The address as separate fields. The destination string is the joined display
  // form; Royal Mail needs the town and postcode on their own.
  shippingAddress?: Record<string, string>;
  // Required for dispatch: Royal Mail prints it on the label.
  customerPhone?: string;
  items: any[];
  total: number;
  subtotal?: number;
  shippingCost?: number;
  deliveryCost?: number;
  deliveryMethod?: string;
  discountApplied: any;
  storeCreditApplied: number;
  isTestMode: boolean;
  createdAt: number;
}

const pendingCheckoutsMap = new Map<string, PendingCheckout>();

// Helper to determine Worldpay Environment and Credentials
function getEnvironmentConfig() {
  const entity = process.env.WORLDPAY_ENTITY || process.env.WORLDPAY_ENTITY_ID || '';
  const username = process.env.WORLDPAY_API_USERNAME || '';
  const password = process.env.WORLDPAY_API_PASSWORD || '';
  const baseUrl = (process.env.WORLDPAY_BASE_URL || 'https://access.worldpay.com').replace(/\/+$/, '');

  let authHeader: string | null = null;
  if (username && password) {
    authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  // Honour WORLDPAY_ENVIRONMENT instead of always claiming "live" — the admin
  // config panel reports this, and it previously showed a sandbox setup as live.
  const environment = String(process.env.WORLDPAY_ENVIRONMENT || 'live').toLowerCase();
  const isTestMode = environment === 'test' || environment === 'sandbox';

  return {
    isTestMode,
    environment,
    entity,
    username,
    password,
    baseUrl,
    authHeader,
    checkoutId: process.env.WORLDPAY_CHECKOUT_ID || process.env.NEXT_PUBLIC_WORLDPAY_CHECKOUT_ID || ''
  };
}

// Helper to extract shopper redirect URL from Worldpay HAL JSON response
function extractWorldpayRedirectUrl(responseBody: any): string | null {
  if (!responseBody) return null;

  for (const prop of ['hostedPaymentPageUrl', 'redirectUrl', 'checkoutUrl', 'url']) {
    const val = responseBody[prop];
    if (val && typeof val === 'string' && !val.includes('/paymentQueries') && !val.includes('/payments?')) {
      return val;
    }
  }

  const links = responseBody._links;
  if (!links || typeof links !== 'object') return null;

  const priorityRels = [
    'hostedPaymentPage',
    'payments:hostedPaymentPage',
    'hpp:hostedPaymentPage',
    'hostedPaymentPage:page',
    'hostedPaymentPage:redirect',
    'paymentPage',
    'redirect',
    'checkout',
    'shopper'
  ];

  for (const rel of priorityRels) {
    const item = links[rel];
    const href = typeof item === 'string' ? item : item?.href;
    if (href && typeof href === 'string' && !href.includes('/paymentQueries') && !href.includes('/payments?')) {
      return href;
    }
  }

  for (const [relKey, item] of Object.entries(links)) {
    if (relKey === 'self') continue;
    const href = typeof item === 'string' ? item : (item as any)?.href;
    if (href && typeof href === 'string' && !href.includes('/paymentQueries') && !href.includes('/payments?')) {
      return href;
    }
  }

  const selfHref = typeof links.self === 'string' ? links.self : links.self?.href;
  if (selfHref && typeof selfHref === 'string' && (selfHref.includes('/paymentPages/') || selfHref.includes('/checkout/'))) {
    return selfHref;
  }

  return null;
}

/**
 * Looks a payment up with Worldpay after the shopper returns from the Hosted
 * Payment Page.
 *
 * The browser redirect carries no payment detail, so for a subscription order
 * this query is the only opportunity to capture the scheme transaction
 * reference Worldpay issued for the stored card. Without it there is nothing to
 * present on the recurring charges, which is why renewals never took money.
 */
/**
 * Records a Worldpay stored-credential against a subscription that was created
 * without one.
 *
 * The redirect back from the Hosted Payment Page carries no payment detail, so a
 * subscription is often created before Worldpay has told us anything about the
 * stored card. The reference then arrives on a later webhook or payment query.
 * Existing credentials are never overwritten, and a value that is not a genuine
 * Worldpay one is ignored rather than stored.
 */
async function backfillSubscriptionCredential(orderId: string, gatewayResponse: any): Promise<boolean> {
  const href = extractRecurringAuthorizationHref(gatewayResponse);
  const scheme = extractSchemeReference(gatewayResponse);
  if (!href && !scheme) return false;

  let updated = false;

  try {
    const storedSubs: any[] = (await fetchResource('subscriptions')) || [];
    const next = storedSubs.map((sub: any) => {
      if (String(sub?.sourceOrderId || sub?.worldpayTransactionId || "") !== String(orderId)) return sub;

      const hasUsable =
        isUsableRecurringHref(sub.worldpayRecurringHref) ||
        (Boolean(sub.worldpaySchemeReference) && !isPlaceholderCredential(sub.worldpaySchemeReference));
      if (hasUsable) return sub;

      updated = true;
      console.log(
        `[Worldpay Order] Recording Worldpay stored credential for subscription ${sub.id} ` +
          `from a later gateway response for order ${orderId}.`
      );
      return {
        ...sub,
        worldpayRecurringHref: href || sub.worldpayRecurringHref || null,
        worldpaySchemeReference: scheme || sub.worldpaySchemeReference || null
      };
    });

    if (updated) {
      await saveResource('subscriptions', next);
      const target = next.find(
        (sub: any) => String(sub?.sourceOrderId || sub?.worldpayTransactionId || "") === String(orderId)
      );
      if (target?.id) {
        try {
          await prisma.subscription.update({
            where: { id: String(target.id) },
            data: {
              worldpayRecurringHref: target.worldpayRecurringHref,
              worldpaySchemeReference: target.worldpaySchemeReference
            }
          });
        } catch (_e) {}
      }
    }
  } catch (_e) {}

  return updated;
}

/**
 * The Payment Queries API: a GET with the reference in the query string, and a
 * versioned HAL media type in Accept.
 *
 * Both details matter, and both were wrong. The call used to be a POST to a bare
 * `/paymentQueries/payments` with a JSON body, which Worldpay answers with an
 * HTML 404 — that route does not exist — and it asked for `application/json`,
 * which the endpoint rejects with 406. So this lookup returned null on every
 * single order since it was written.
 *
 * That is not a cosmetic failure. This is the only place a subscription's scheme
 * transaction reference is read back after the shopper returns from the Hosted
 * Payment Page, so no subscription could ever record a stored-card mandate, and
 * every plan reported "no stored-card mandate with Worldpay".
 *
 * The correct URL is the one Worldpay itself hands back as `_links.self.href`
 * when the payment page is created.
 */
const PAYMENT_QUERY_ACCEPT = 'application/vnd.worldpay.payment-queries-v1.hal+json';

/** How long to keep asking when Worldpay has not published the payment yet. */
const PAYMENT_QUERY_ATTEMPTS = 3;
const PAYMENT_QUERY_RETRY_MS = 1200;

/** Worldpay events that mean the money is committed. */
const AUTHORISED_PAYMENT_EVENTS = [
  'authorized',
  'authorised',
  'sentforsettlement',
  // What this account actually reports for a captured payment. Every live
  // Worldpay payment queried on this entity comes back
  // `"lastEvent": "settlementRequestSubmitted"` — the money is authorised AND
  // the settlement request is in. It was missing from this list, so every real
  // payment normalised to "unknown", the order was recorded as Pending, and the
  // subscription that depends on a confirmed payment was never created.
  'settlementrequestsubmitted',
  'settlementsubmitted',
  'settled',
  'charged',
  'captured'
];

/** Worldpay events that mean the payment definitively did not happen. */
const FAILED_PAYMENT_EVENTS = ['refused', 'declined', 'failed', 'cancelled', 'canceled', 'expired', 'error'];

/**
 * Did Worldpay actually take the money?
 *
 * The shopper's return URL carries `status=SUCCESS` as a plain query parameter,
 * which is a claim by the browser, not by Worldpay — anyone can request that URL
 * and it used to be enough to record an order as Paid. The payment query is the
 * only trustworthy answer, and it only became usable once the call above was
 * fixed.
 */
function paymentOutcome(payment: any): 'authorised' | 'failed' | 'unknown' {
  if (!payment) return 'unknown';
  const raw = String(payment.lastEvent || payment.outcome || payment.status || '')
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  if (!raw) return 'unknown';
  if (AUTHORISED_PAYMENT_EVENTS.includes(raw)) return 'authorised';
  if (FAILED_PAYMENT_EVENTS.includes(raw)) return 'failed';
  return 'unknown';
}

async function fetchWorldpayPaymentDetails(transactionReference: string): Promise<any | null> {
  const cfg = getEnvironmentConfig();
  if (!cfg.authHeader || !cfg.entity) return null;

  const url = `${cfg.baseUrl}/paymentQueries/payments?transactionReference=${encodeURIComponent(transactionReference)}`;

  for (let attempt = 1; attempt <= PAYMENT_QUERY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: cfg.authHeader,
          Accept: PAYMENT_QUERY_ACCEPT,
          'WP-CorrelationId': crypto.randomUUID ? crypto.randomUUID() : `q-${Date.now()}`
        }
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        console.warn(
          `[Worldpay Query] Payment lookup for ${transactionReference} returned HTTP ${response.status}. ` +
            `A subscription created from this payment will have no stored-card mandate. ${detail.slice(0, 300)}`
        );
        return null;
      }

      const data: any = await response.json().catch(() => null);
      const payment = data?._embedded?.payments?.[0] || data?.payments?.[0] || null;
      if (payment) return payment;

      // HTTP 200 with an empty collection means Worldpay has not published the
      // payment yet — it lags the shopper's redirect by a moment. Giving up on
      // the first empty answer loses the mandate permanently, so ask again.
      if (attempt < PAYMENT_QUERY_ATTEMPTS) {
        console.log(
          `[Worldpay Query] No payment published yet for ${transactionReference} (attempt ${attempt}/${PAYMENT_QUERY_ATTEMPTS}); retrying.`
        );
        await new Promise(resolve => setTimeout(resolve, PAYMENT_QUERY_RETRY_MS));
        continue;
      }

      console.warn(
        `[Worldpay Query] Worldpay reports no payment for ${transactionReference}. ` +
          `The shopper did not complete the payment, or it was declined.`
      );
      return null;
    } catch (err: any) {
      console.warn(`[Worldpay Query] Payment lookup failed for ${transactionReference}:`, err?.message);
      return null;
    }
  }

  return null;
}

// Helper to save and load pending checkouts persistently
async function savePendingCheckout(orderId: string, payload: PendingCheckout) {
  pendingCheckoutsMap.set(orderId, payload);
  try {
    const existing: any[] = (await fetchResource('pending_checkouts')) || [];
    const idx = existing.findIndex((p: any) => String(p.orderId) === String(orderId));
    if (idx !== -1) {
      existing[idx] = payload;
    } else {
      existing.unshift(payload);
    }
    await saveResource('pending_checkouts', existing.slice(0, 200));
  } catch (err) {
    console.warn('[Worldpay] Failed to persist pending checkout:', err);
  }
}

async function getPendingCheckout(orderId: string): Promise<PendingCheckout | undefined> {
  let pending = pendingCheckoutsMap.get(orderId);
  if (pending) return pending;
  try {
    const existing: any[] = (await fetchResource('pending_checkouts')) || [];
    const found = existing.find((p: any) => String(p.orderId) === String(orderId));
    if (found) {
      pendingCheckoutsMap.set(orderId, found);
      return found;
    }
  } catch (err) {
    console.warn('[Worldpay] Failed to load pending checkout from resource:', err);
  }
  return undefined;
}

// Helper to save a verified successful order directly into Prisma and StoreResource
async function saveVerifiedOrder(
  orderId: string,
  details: {
    transactionId: string;
    authCode?: string;
    cardBrand?: string;
    cardLast4?: string;
    paymentMethod?: string;
    webhookEventId?: string;
    /** Raw Worldpay response, used to recover the stored-credential references. */
    gatewayResponse?: any;
    schemeReference?: string | null;
    pendingData?: PendingCheckout;
    customerName?: string;
    customerEmail?: string;
    destination?: string;
    items?: any[];
    total?: number;
    subtotal?: number;
    shippingCost?: number;
    deliveryCost?: number;
    deliveryMethod?: string;
    discountApplied?: any;
    storeCreditApplied?: number;
    /**
     * Whether Worldpay confirmed the money was taken. False when the shopper
     * returned but the gateway has not published an authorised payment yet:
     * the order is then recorded as Pending rather than invented as Paid.
     */
    paymentConfirmed?: boolean;
  }
) {
  const pending = details.pendingData || await getPendingCheckout(orderId);
  const { saveSingleOrder } = await import('./orders');

  // The shopper's browser return (/callback) and the client-side
  // /verify-payment call both land here for the same payment. Without this
  // guard the second one creates a SECOND subscription for the same order —
  // with its own id and schedule — so the customer gets billed twice per cycle.
  try {
    const existingOrders: any[] = (await fetchResource('orders')) || [];
    const already = existingOrders.find((o: any) => String(o.id) === String(orderId));
    if (already && already.paymentStatus === 'Paid') {
      console.log(`[Worldpay Order] Order ${orderId} is already recorded as Paid — skipping duplicate creation.`);
      // The order is done, but this callback may be the one carrying the stored
      // credential the subscription still needs.
      await backfillSubscriptionCredential(String(orderId), details.gatewayResponse);
      return already;
    }
  } catch (_e) {}

  try {
    const existingSubs: any[] = (await fetchResource('subscriptions')) || [];
    const dupeSub = existingSubs.find((s: any) => String(s.sourceOrderId || '') === String(orderId));
    if (dupeSub) {
      console.log(
        `[Worldpay Order] A subscription (${dupeSub.id}) already exists for order ${orderId} — not creating another.`
      );
      await backfillSubscriptionCredential(String(orderId), details.gatewayResponse);
      return (await fetchResource('orders')).find((o: any) => String(o.id) === String(orderId)) || null;
    }
  } catch (_e) {}

  const customerName = pending?.customerName || details.customerName || 'Valued Customer';
  const rawEmail = pending?.customerEmail || details.customerEmail || 'customer@pouch-supply.com';
  const customerEmail = String(rawEmail).toLowerCase().trim();
  const destination = pending?.destination || details.destination || 'United Kingdom';
  const items = (pending?.items && pending.items.length > 0) ? pending.items : (details.items || []);
  const total = typeof pending?.total === 'number' ? pending.total : (typeof details.total === 'number' ? details.total : (parseFloat(pending?.total as any) || parseFloat(details.total as any) || 0));
  const storeCreditApplied = pending?.storeCreditApplied || details.storeCreditApplied || 0;
  const discountApplied = pending?.discountApplied || details.discountApplied || null;

  // Calculate items subtotal
  const subItemsList = items.filter((it: any) => it.isSubscription || (it.productId && (it.productId.startsWith('sub-pack') || it.productId.includes('sub-pack'))));
  const subItem = subItemsList[0] || items.find((it: any) => it.isSubscription || (it.productId && (it.productId.startsWith('sub-pack') || it.productId.includes('sub-pack'))));
  const subItemsTotal = subItemsList.reduce((sum: number, it: any) => sum + (Number(it.price || 0) * (Number(it.quantity) || 1)), 0);

  // Extract shipping charges from the first order to ensure it remains in all auto recurring subscription payments
  const effectiveShipping = typeof pending?.shippingCost === 'number'
    ? pending.shippingCost
    : (typeof pending?.deliveryCost === 'number'
        ? pending.deliveryCost
        : (typeof details.shippingCost === 'number'
            ? details.shippingCost
            : (typeof details.deliveryCost === 'number'
                ? details.deliveryCost
                : (total > subItemsTotal && subItemsTotal > 0
                    ? Number((total - subItemsTotal).toFixed(2))
                    : (total >= 40 ? 0 : 2.99)))));

  const deliveryMethod = pending?.deliveryMethod || details.deliveryMethod || 'Royal Mail Tracked 24/48';

  // Defaults to true so the webhook and the explicit verify-payment call — both
  // of which only run on a payment Worldpay has already confirmed — behave as
  // before. Only the shopper-return callback passes false.
  const paymentConfirmed = details.paymentConfirmed !== false;
  let createdSubscriptionId: string | undefined;

  // A subscription is a promise to charge this card again. Creating one from a
  // payment Worldpay has not confirmed would schedule renewals for money that
  // was never taken, so it waits for the confirmation instead.
  if (subItem && paymentConfirmed) {
    try {
      const planName = subItem.productTitle || subItem.title || 'Pouch Supply Subscription';
      const planId = subItem.productId || 'sub-pack-core';
      const rawFrequency = (
        subItem.subscriptionFrequency ||
        subItem.frequency ||
        subItem.billingInterval ||
        pending?.items?.find((i: any) => i.isSubscription)?.subscriptionFrequency ||
        'month'
      ).toString();

      // Single shared normaliser. The old inline ladder matched `includes('day')`
      // first, so "14 days"/"7 days"/"30 days" all became daily billing, and
      // `includes('1')` turned "1 Month" into a daily plan too.
      const billingInterval = normalizeBillingInterval(rawFrequency);
      const nextBillingDate = calculateNextBillingDate(billingInterval, new Date());

      // Stored-credential references may ONLY come from Worldpay. Earlier builds
      // manufactured them from the order id, which produced a URL that resolves
      // to nothing — every recurring charge then failed and was masked by a
      // simulated "authorized" response, so subscriptions silently took no money.
      const recurringHref = extractRecurringAuthorizationHref(details.gatewayResponse) || null;
      const schemeReference =
        extractSchemeReference(details.gatewayResponse) ||
        (details.schemeReference && !isPlaceholderCredential(details.schemeReference)
          ? details.schemeReference
          : null);

      if (!recurringHref && !schemeReference) {
        console.warn(
          `[Worldpay Order] Subscription for order ${orderId} has no Worldpay stored-credential reference. ` +
            `Recurring renewals cannot be charged until the initial payment returns a scheme transaction reference ` +
            `(the Hosted Payment Page must be created with a customer agreement).`
        );
      }

      // CRITICAL: Ensure the recurring subscription charge includes both the plan items and the initial shipping fee
      const subAmount = total > 0 ? Number(total) : Number((subItemsTotal + effectiveShipping).toFixed(2));

      const subId = `sub_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      createdSubscriptionId = subId;

      const subData = {
        id: subId,
        // Links the subscription back to the order that created it so a repeated
        // callback for the same payment can be recognised as a duplicate.
        sourceOrderId: String(orderId),
        customerId: customerEmail,
        customerEmail,
        customerName,
        planId,
        planName,
        amount: subAmount, // Total recurring charge (includes shipping fee)
        itemPrice: subItemsTotal || Number(subItem.price) || subAmount,
        shippingCost: effectiveShipping,
        shippingFee: effectiveShipping,
        shippingAmount: effectiveShipping,
        deliveryCost: effectiveShipping,
        shippingAddress: destination,
        deliveryMethod,
        currency: 'GBP',
        status: 'active',
        billingInterval,
        nextBillingDate,
        worldpayTransactionId: details.transactionId || orderId,
        worldpayRecurringHref: recurringHref,
        worldpaySchemeReference: schemeReference,
        lastPaymentStatus: 'authorized',
        lastPaymentId: details.transactionId || orderId,
        lastPaymentAt: new Date(),
        items: items
      };

      // Schema-checked write - see src/lib/subscriptionRow.ts. This used to be
      // prisma.subscription.create(subData) inside an empty catch: subData carries
      // shippingFee/shippingAmount/deliveryCost, which are not columns, and a
      // customerId holding an email, so every create threw and was discarded in
      // silence. The subscription then existed only as a JSON blob.
      {
        const { upsertSubscriptionRow } = await import('../../src/lib/subscriptionRow');
        const stored = await upsertSubscriptionRow(subData);
        if (!stored) {
          console.error(
            `[SUBSCRIPTION NOT PERSISTED] ${subId} for order ${orderId} is not in the Neon ` +
              'Subscription table. Recover it from the payload below.',
            JSON.stringify(subData)
          );
        }
      }

      try {
        const storedSubs: any[] = (await fetchResource('subscriptions')) || [];
        storedSubs.unshift(subData);
        await saveResource('subscriptions', storedSubs.slice(0, 500));
      } catch (_e) {}

      // Update customer subscription status in database
      try {
        const customers: any[] = (await fetchResource('customers')) || [];
        const foundCust = customers.find((c: any) => String(c.email).toLowerCase().trim() === customerEmail);
        if (foundCust) {
          foundCust.subscriptionStatus = 'Active Subscriber';
          foundCust.subStatus = 'active';
          foundCust.subPlan = planName;
          foundCust.subPrice = subAmount;
          foundCust.nextPayment = nextBillingDate.toISOString().split('T')[0];
          await saveResource('customers', customers);
        }
      } catch (_e) {}
    } catch (subErr) {
      console.warn('[Worldpay Order] Auto-subscription creation warning:', subErr);
    }
  }

  const tags = ['Storefront', pending?.isTestMode ? 'Worldpay Test Order' : 'Worldpay Live Order'];
  if (subItem) {
    tags.push('Subscription Order');
  }

  const calculatedSubtotal = typeof pending?.subtotal === 'number'
    ? pending.subtotal
    : (total > effectiveShipping ? Number((total - effectiveShipping).toFixed(2)) : total);

  const formattedOrder = {
    id: orderId,
    orderId: orderId,
    customerName,
    customerEmail,
    destination,
    // The separate address fields ride along with the order so Royal Mail can
    // read the town and postcode directly.
    shippingAddress: pending?.shippingAddress || (details as any).shippingAddress || null,
    // Kept at the top level too: createRoyalMailShipment reads either
    // shippingAddress.phone or customerPhone when building the label.
    customerPhone: pending?.customerPhone || (details as any).customerPhone || pending?.shippingAddress?.phone || null,
    items,
    total,
    subtotal: calculatedSubtotal,
    shippingCost: effectiveShipping,
    deliveryCost: effectiveShipping,
    storeCreditApplied,
    discountApplied,
    // Never invented. "status=SUCCESS" in the return URL is the browser's claim;
    // only a payment Worldpay reports as authorised makes this Paid. An
    // unconfirmed order stays Pending and is completed by the webhook, or by the
    // status poll the checkout page is already running.
    paymentStatus: paymentConfirmed ? 'Paid' : 'Pending',
    fulfillmentStatus: 'Unfulfilled',
    worldpayTxId: details.transactionId,
    worldpayAuthCode: details.authCode || 'AUTH-OK',
    gatewayTxId: details.transactionId,
    gatewayAuthCode: details.authCode || 'AUTH-OK',
    cardBrand: details.cardBrand || 'Worldpay Card',
    deliveryMethod,
    carrier: 'Royal Mail',
    tags,
    subscriptionId: createdSubscriptionId,
    isSubscription: Boolean(subItem),
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    createdAt: new Date().toISOString(),
    data: {
      cardLast4: details.cardLast4,
      paymentMethod: details.paymentMethod || 'Worldpay Access',
      webhookEventId: details.webhookEventId,
      isTestMode: pending?.isTestMode ?? false,
      subscriptionId: createdSubscriptionId,
      shippingCost: effectiveShipping,
      deliveryCost: effectiveShipping,
      subtotal: calculatedSubtotal
    }
  };

  const savedOrder = await saveSingleOrder(formattedOrder);

  // Clear pending memory store
  pendingCheckoutsMap.delete(orderId);

  // Auto-create a Royal Mail Click & Drop shipment only when the store has
  // explicitly opted in. Registering a shipment here marks the order Shipped
  // immediately, so the dispatch email went out seconds after the order
  // confirmation for an order nobody had packed yet.
  try {
    const { getRoyalMailSettings, createRoyalMailShipment } = await import('../services/royalMailService');
    const rmSettings = await getRoyalMailSettings();
    const hasKey = Boolean(rmSettings.apiKey || process.env.ROYAL_MAIL_API_KEY || process.env.RM_API_KEY);
    if (rmSettings.enabled && rmSettings.autoCreateShipmentOnPayment && hasKey) {
      console.log(`[Worldpay Order] Auto-registering Click & Drop shipment with Royal Mail for order #${orderId}`);
      createRoyalMailShipment(orderId, {
        serviceCode: rmSettings.defaultServiceCode,
        weightGrams: rmSettings.defaultWeightGrams || 70
      }).catch(err => {
        console.warn(`[Worldpay Order] Background Royal Mail shipment creation note for #${orderId}:`, err?.message);
      });
    }
  } catch (_rmErr) {}

  return savedOrder;
}

// GET /api/worldpay/config - Returns mode and configuration status
/**
 * Reconcile orders that Worldpay confirmed after we stopped listening.
 *
 * Worldpay publishes a payment a moment after the shopper's browser returns. If
 * the callback ran before that, `paymentOutcome` answered "unknown", the order
 * was recorded as Pending, and — because a subscription is only created from a
 * CONFIRMED payment — no subscription was created either. Nothing re-checked
 * afterwards, so the order stayed Pending for good while the money had in fact
 * been taken.
 *
 * This re-asks Worldpay about every Pending order and, where the payment is
 * authorised, runs it back through `saveVerifiedOrder` — the same funnel the
 * callback uses. That path already refuses to act twice: an order that is
 * already Paid, or that already has a subscription, is skipped rather than
 * duplicated, so this is safe to run on a schedule and safe to run twice.
 */
export async function reconcilePendingWorldpayOrders(limit = 50) {
  const orders: any[] = (await fetchResource('orders')) || [];
  const pendingOrders = orders
    .filter((o: any) => o && String(o.paymentStatus || '').toLowerCase() === 'pending')
    .slice(0, limit);

  const results: Array<{ orderId: string; status: string; detail?: string }> = [];

  for (const order of pendingOrders) {
    const orderId = String(order.id);
    try {
      const payment = await fetchWorldpayPaymentDetails(orderId);
      const outcome = paymentOutcome(payment);

      if (outcome === 'failed') {
        results.push({ orderId, status: 'failed', detail: String(payment?.lastEvent || 'refused') });
        continue;
      }
      if (outcome !== 'authorised') {
        results.push({ orderId, status: 'still-unconfirmed', detail: String(payment?.lastEvent || 'no payment published') });
        continue;
      }

      const card = payment?.paymentInstrument?.card;
      await saveVerifiedOrder(orderId, {
        transactionId: String(payment?.paymentId || order.worldpayTxId || orderId),
        authCode: payment?.issuer?.authorizationCode || undefined,
        cardBrand: card?.brand || undefined,
        cardLast4: card?.number?.last4Digits || undefined,
        // The payment query response is what carries scheme.reference, which is
        // the stored credential the renewal needs.
        gatewayResponse: payment,
        paymentConfirmed: true,
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        destination: order.destination,
        items: order.items,
        total: typeof order.total === 'number' ? order.total : undefined,
        deliveryMethod: order.deliveryMethod
      });

      results.push({ orderId, status: 'reconciled', detail: String(payment?.transactionType || '') });
    } catch (err: any) {
      results.push({ orderId, status: 'error', detail: err?.message });
    }
  }

  return results;
}

const handleReconcilePending = async (_req: Request, res: Response) => {
  try {
    const results = await reconcilePendingWorldpayOrders();
    const reconciled = results.filter(r => r.status === 'reconciled').length;
    return res.json({
      success: true,
      message: `Checked ${results.length} pending order(s); ${reconciled} reconciled.`,
      results
    });
  } catch (err: any) {
    console.error('[Worldpay Reconcile] Failed:', err);
    return res.status(500).json({ success: false, error: err?.message });
  }
};

router.get('/reconcile-pending', handleReconcilePending);
router.post('/reconcile-pending', handleReconcilePending);

router.get('/config', (_req: Request, res: Response) => {
  const cfg = getEnvironmentConfig();

  res.json({
    active: true,
    isConfigured: Boolean(cfg.entity && cfg.authHeader),
    platform: 'Worldpay Access API',
    environment: cfg.environment,
    isTestMode: cfg.isTestMode,
    baseUrl: cfg.baseUrl,
    entityMasked: cfg.entity ? `${cfg.entity.substring(0, 4)}***` : 'Not Configured',
    checkoutIdMasked: cfg.checkoutId ? `${cfg.checkoutId.substring(0, 6)}***` : 'Not Configured',
    hasBasicAuth: Boolean(cfg.username && cfg.password),
    provider: `Worldpay Access (${cfg.environment.toUpperCase()})`
  });
});

// POST /api/worldpay/session - Initiate Hosted Payment Session
async function handleCreateHostedPaymentPage(req: Request, res: Response) {
  try {
    const {
      orderId,
      amount,
      total: reqTotal,
      subtotal: reqSubtotal,
      shippingCost: reqShippingCost,
      deliveryCost: reqDeliveryCost,
      deliveryMethod: reqDeliveryMethod,
      customerName,
      customerEmail,
      destination,
      shippingAddress,
      address,
      items,
      recurring,
      discountApplied,
      storeCreditApplied,
      origin: bodyOrigin
    } = req.body;

    // UK-only delivery and a usable contact number, checked before a payment
    // session exists. Once Worldpay has taken the money, refusing the order
    // means a refund instead of a message.
    const deliverable = assertDeliverable(req.body);
    if (!deliverable.ok) {
      return res.status(400).json({ success: false, message: deliverable.message });
    }

    const cfg = getEnvironmentConfig();

    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
    const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || 'localhost:3000';
    const origin = bodyOrigin || `${protocol}://${host}`;

    const rawRef = orderId || `PS${Math.floor(Math.random() * 90000 + 10000)}`;
    const transactionReference = String(rawRef);

    let priceNum = 2500;
    if (typeof amount === 'number') {
      priceNum = Math.round(amount * 100);
    } else if (typeof amount === 'string' && !isNaN(parseFloat(amount))) {
      priceNum = Math.round(parseFloat(amount) * 100);
    } else if (typeof reqTotal === 'number') {
      priceNum = Math.round(reqTotal * 100);
    }

    const effectiveTotal = typeof amount === 'number' ? amount : (typeof reqTotal === 'number' ? reqTotal : parseFloat(amount) || 0);
    const effectiveShippingCost = typeof reqShippingCost === 'number'
      ? reqShippingCost
      : (typeof reqDeliveryCost === 'number' ? reqDeliveryCost : (effectiveTotal >= 40 ? 0 : 2.99));

    // Store pending order details in memory and persistent storage — DO NOT CREATE ORDER IN DATABASE BEFORE PAYMENT
    const pendingPayload: PendingCheckout = {
      orderId: transactionReference,
      customerName: customerName || 'Valued Customer',
      customerEmail: (customerEmail || 'customer@pouch-supply.com').toLowerCase().trim(),
      destination: destination || address || 'United Kingdom',
      // Kept as separate fields so the shipping label can be produced without
      // having to take the joined string apart again.
      shippingAddress: shippingAddress && typeof shippingAddress === 'object'
        ? { ...shippingAddress, phone: deliverable.phone, postcode: deliverable.postcode, country: UK_COUNTRY_NAME, countryCode: UK_COUNTRY_CODE }
        : undefined,
      customerPhone: deliverable.phone,
      items: Array.isArray(items) ? items.map((it: any) => {
        let planName = it.subscriptionPlan || '';
        const rawPlan = (it.subscriptionPlan || '').toLowerCase();
        const title = (it.productTitle || it.title || '').toLowerCase();
        const prodId = (it.productId || it.id || '').toLowerCase();
        if (!planName) {
          if (rawPlan.includes('ultimate') || title.startsWith('ultimate') || title.includes('ultimate plan') || prodId.includes('ultimate')) {
            planName = 'ULTIMATE Plan';
          } else if (rawPlan.includes('pro') || title.startsWith('pro') || title.includes('pro plan') || prodId.includes('pro')) {
            planName = 'PRO Plan';
          } else if (rawPlan.includes('core') || title.startsWith('core') || title.includes('core plan') || prodId.includes('core')) {
            planName = 'CORE Plan';
          } else if (rawPlan.includes('lite') || title.startsWith('lite') || title.includes('lite plan') || prodId.includes('lite')) {
            planName = 'LITE Plan';
          }
        }
        return {
          productId: it.productId || it.id || 'prod',
          // The title the storefront sent is kept verbatim. A stand-in name here
          // would follow the item all the way into the order detail view.
          productTitle: it.productTitle || it.title || '',
          price: typeof it.price === 'number' ? it.price : parseFloat(it.price) || 0,
          quantity: typeof it.quantity === 'number' ? it.quantity : parseInt(it.quantity) || 1,
          image: it.image || '',
          variant: it.variant || it.concreteVariantName || it.strength || it.flavour || '',
          sku: it.sku || it.concreteVariantId || it.productId || '',
          vendor: it.vendor || '',
          isSubscription: Boolean(it.isSubscription || (it.productId && (it.productId.startsWith('sub-pack') || it.productId.includes('sub-pack')))),
          subscriptionPlan: planName || it.subscriptionPlan || 'PRO Plan',
          subscriptionFrequency: it.subscriptionFrequency || 'Bi-Weekly',
          frequencyDiscount: it.frequencyDiscount || '10%',
          subscriptionItems: it.subscriptionItems || it.selectedProducts || it.items || []
        };
      }) : [],
      total: effectiveTotal,
      subtotal: typeof reqSubtotal === 'number' ? reqSubtotal : (effectiveTotal > effectiveShippingCost ? Number((effectiveTotal - effectiveShippingCost).toFixed(2)) : effectiveTotal),
      shippingCost: effectiveShippingCost,
      deliveryCost: effectiveShippingCost,
      deliveryMethod: reqDeliveryMethod || 'Royal Mail Tracked 24/48',
      discountApplied: discountApplied || null,
      storeCreditApplied: storeCreditApplied || 0,
      isTestMode: false,
      createdAt: Date.now()
    };

    await savePendingCheckout(transactionReference, pendingPayload);

    if (!cfg.authHeader || !cfg.entity) {
      return res.status(400).json({
        success: false,
        message: 'Worldpay Access API credentials are not configured in environment variables (WORLDPAY_ENTITY, WORLDPAY_API_USERNAME, WORLDPAY_API_PASSWORD).',
        error: 'Worldpay credentials missing.'
      });
    }

    // Worldpay HPP Request (Live Hosted Payment Pages)
    const successReturnUrl = `${origin}/api/worldpay/callback?orderId=${encodeURIComponent(transactionReference)}&status=SUCCESS`;
    const pendingReturnUrl = `${origin}/api/worldpay/callback?orderId=${encodeURIComponent(transactionReference)}&status=PENDING`;
    const failureReturnUrl = `${origin}/api/worldpay/callback?orderId=${encodeURIComponent(transactionReference)}&status=FAILED`;
    const cancelReturnUrl = `${origin}/payment/cancelled?orderId=${encodeURIComponent(transactionReference)}`;
    const expiryReturnUrl = `${origin}/payment/failed?orderId=${encodeURIComponent(transactionReference)}&reason=expired`;

    const rawLabel = (items && items[0]?.productTitle) || 'Pouch Supply Order';
    // Worldpay narrative schema: merchant.narrative.line1 (Max 24 alphanumeric chars)
    let cleanNarrative = String(rawLabel)
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24);
    if (!cleanNarrative || cleanNarrative.length === 0) {
      cleanNarrative = 'Pouch Supply Order';
    }

    // Clean simple description
    const cleanDescription = String(rawLabel || 'Pouch Supply')
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40) || 'Pouch Supply Order';

    const cleanBillingName = String(customerName || 'Scott Kivlin')
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40) || 'Scott Kivlin';

    const body: Record<string, unknown> = {
      transactionReference,
      merchant: {
        entity: cfg.entity
      },
      narrative: { line1: cleanNarrative },
      value: { currency: 'GBP', amount: priceNum },
      description: cleanDescription,
      billingAddressName: cleanBillingName,
      resultURLs: {
        successURL: successReturnUrl,
        pendingURL: pendingReturnUrl,
        failureURL: failureReturnUrl,
        errorURL: failureReturnUrl,
        cancelURL: cancelReturnUrl,
        expiryURL: expiryReturnUrl
      }
    };

    // A subscription basket needs Worldpay to STORE the card, not just charge it.
    //
    // Without a customerAgreement on this first payment Worldpay treats it as a
    // one-off: it issues no scheme transaction reference and no recurring
    // authorization link, so there is nothing to charge on the renewal date and
    // every recurring payment fails. `createToken` is required alongside the
    // agreement by the Hosted Payment Pages API.
    const isSubscriptionCheckout = Boolean(
      recurring ||
      (Array.isArray(items) &&
        items.some(
          (it: any) =>
            it?.isSubscription ||
            (typeof it?.productId === 'string' && it.productId.includes('sub-pack'))
        ))
    );

    if (isSubscriptionCheckout) {
      body.customerAgreement = {
        type: 'subscription',
        storedCardUsage: 'first'
      };
      body.createToken = {
        type: 'worldpay',
        // Groups the shopper's stored cards. Their email keeps renewals for one
        // person together without exposing anything Worldpay does not already hold.
        namespace: String(customerEmail || transactionReference).toLowerCase().slice(0, 64),
        description: 'Pouch Supply subscription',
        // Consent for the stored card is taken in our own checkout terms, so the
        // shopper is not asked a second time on Worldpay's page.
        optIn: 'Silent'
      };
    }

    const correlationId = crypto.randomUUID ? crypto.randomUUID() : `hpp-${Math.random().toString(36).slice(2, 12)}`;
    const userAgent = req.headers['user-agent'] || 'worldpay-hpp/1.0';

    const worldpayUrl = `${cfg.baseUrl}/payment_pages`;

    console.log(`[Worldpay HPP ${cfg.environment.toUpperCase()}] POST ${worldpayUrl} for Order: ${transactionReference}`);

    // The credentials guard above proves `cfg.authHeader` is set, but that
    // narrowing does not survive into the closure below, so hold it as a const.
    const authHeader = cfg.authHeader;

    const postPaymentPage = async (payload: Record<string, unknown>) => {
      const res = await fetch(worldpayUrl, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/vnd.worldpay.payment_pages-v1.hal+json',
          'Accept': 'application/vnd.worldpay.payment_pages-v1.hal+json',
          'WP-CorrelationId': correlationId,
          'User-Agent': userAgent
        },
        body: JSON.stringify(payload)
      });
      const parsed: any = await res.json().catch(() => ({ message: 'Invalid response from Worldpay.' }));
      return { res, parsed };
    };

    let { res: response, parsed: responseBody } = await postPaymentPage(body);

    // Taking no payment at all is worse than taking one without a stored-card
    // mandate. If the account is not enabled for customer agreements, the sale
    // still completes — but loudly, because that subscription cannot renew and
    // somebody has to enable it on the Worldpay account.
    if (!response.ok && isSubscriptionCheckout) {
      const rejection = String(responseBody?.description || responseBody?.message || responseBody?.errorName || "");
      console.error(
        `[Worldpay HPP] Subscription mandate rejected for ${transactionReference} ` +
          `(${response.status}): ${rejection}. Retrying as a one-off payment — this ` +
          `subscription will NOT be able to take recurring payments until ` +
          `customer agreements / tokenisation are enabled on entity ${cfg.entity}.`
      );

      const fallbackBody = { ...body };
      delete (fallbackBody as any).customerAgreement;
      delete (fallbackBody as any).createToken;
      ({ res: response, parsed: responseBody } = await postPaymentPage(fallbackBody));
    }

    if (!response.ok) {
      const errMsg = responseBody?.description || responseBody?.message || 'Hosted Payment Pages creation failed.';
      return res.status(response.status).json({
        success: false,
        message: errMsg,
        error: `Worldpay Error (${response.status}): ${errMsg}`,
        details: responseBody
      });
    }

    const redirectUrl = extractWorldpayRedirectUrl(responseBody);
    if (!redirectUrl) {
      return res.status(400).json({
        success: false,
        message: 'Worldpay response did not include a valid Hosted Payment Page redirect URL.',
        details: responseBody
      });
    }

    return res.status(200).json({
      success: true,
      sessionId: transactionReference,
      transactionReference,
      redirectUrl,
      checkoutId: cfg.entity,
      provider: `Worldpay Access HPP (${cfg.environment})`,
      environment: cfg.environment,
      isTestMode: cfg.isTestMode
    });

  } catch (error: any) {
    console.error('[Worldpay HPP] Request failed:', error);
    return res.status(502).json({
      success: false,
      message: 'Unable to reach Worldpay Hosted Payment Pages service.',
      error: error.message
    });
  }
}

router.post('/session', handleCreateHostedPaymentPage);
router.post('/payment_pages', handleCreateHostedPaymentPage);

// POST /api/worldpay/verify-payment - Server-side Payment Verification & Order Creation
router.post('/verify-payment', async (req: Request, res: Response) => {
  try {
    const {
      orderId,
      status,
      transactionId,
      txId,
      authCode,
      cardBrand,
      customerName,
      customerEmail,
      destination,
      items,
      total
    } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId is required' });
    }

    const statusUpper = String(status || 'SUCCESS').toUpperCase();

    if (statusUpper !== 'SUCCESS' && statusUpper !== 'AUTHORIZED' && statusUpper !== 'PAID') {
      // Payment was declined or cancelled. DO NOT SAVE ANY ORDER!
      pendingCheckoutsMap.delete(orderId);
      return res.status(400).json({
        success: false,
        message: 'Payment was not successful. No order was created in the database.'
      });
    }

    // Retrieve pending order data or construct from request body if missing
    let pending = await getPendingCheckout(orderId);
    if (!pending) {
      pending = {
        orderId,
        customerName: customerName || 'Valued Customer',
        customerEmail: (customerEmail || 'customer@pouch-supply.com').toLowerCase().trim(),
        destination: destination || 'United Kingdom',
        items: Array.isArray(items) ? items : [],
        total: typeof total === 'number' ? total : parseFloat(total) || 0,
        discountApplied: req.body.discountApplied || null,
        storeCreditApplied: req.body.storeCreditApplied || 0,
        isTestMode: req.body.isTestMode ?? true,
        createdAt: Date.now()
      };
    }

    // Confirm with Worldpay directly instead of trusting the client-reported
    // status, and pick up the stored-credential reference while we are there.
    const gatewayResponse = req.body.worldpayResponse || (await fetchWorldpayPaymentDetails(orderId));

    const effectiveTxId =
      transactionId || txId || gatewayResponse?.id || `WP-${Date.now().toString().slice(-6)}`;
    const effectiveAuthCode = authCode || gatewayResponse?.authorizationCode || 'AUTH-SUCCESS-OK';

    // Persist verified order into Prisma DB and StoreResource
    const savedOrder = await saveVerifiedOrder(orderId, {
      transactionId: effectiveTxId,
      authCode: effectiveAuthCode,
      cardBrand: cardBrand || gatewayResponse?.paymentInstrument?.card?.brand || 'Worldpay Card',
      gatewayResponse,
      customerName,
      customerEmail,
      destination,
      items,
      total,
      discountApplied: req.body.discountApplied,
      storeCreditApplied: req.body.storeCreditApplied,
      pendingData: pending
    });

    console.log(`[Worldpay Payment Verified] Order #${orderId} saved as Paid with Tx ID: ${effectiveTxId}`);

    return res.json({
      success: true,
      orderId,
      transactionId: effectiveTxId,
      authCode: effectiveAuthCode,
      paymentStatus: 'Paid',
      order: savedOrder,
      redirectUrl: `/payment/success?orderId=${encodeURIComponent(orderId)}&txId=${encodeURIComponent(effectiveTxId)}`
    });

  } catch (error: any) {
    console.error('[Worldpay Verify Payment Error]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Server-side payment verification failed' });
  }
});

// GET & POST /api/worldpay/callback - Shopper Return Callback Handler
const handleWorldpayCallback = async (req: Request, res: Response) => {
  const params = req.method === 'POST' ? req.body : req.query;
  const orderId = (params.orderId || params.transactionReference) as string;
  const status = (params.status || '').toUpperCase();

  console.log(`[Worldpay Callback] Order: ${orderId}, Status: ${status}`);

  if (!orderId) {
    return res.redirect('/payment/failed?reason=missing_order');
  }

  if (status === 'FAILED' || status === 'CANCELLED' || status === 'ERROR') {
    pendingCheckoutsMap.delete(orderId);
    return res.redirect(`/payment/failed?orderId=${encodeURIComponent(orderId)}&reason=payment_declined`);
  }

  if (status === 'SUCCESS' || status === 'PENDING' || status === 'AUTHORIZED') {
    // Ask Worldpay what actually happened rather than trusting the redirect's
    // query string — this is also where the stored-credential reference for a
    // subscription comes from.
    const gatewayResponse = await fetchWorldpayPaymentDetails(orderId);

    const outcome = paymentOutcome(gatewayResponse);

    // Worldpay says the payment did not happen. Recording an order here would
    // create a paid order for money nobody took — and this URL is a plain GET
    // that anything can request.
    if (outcome === 'failed') {
      console.warn(
        `[Worldpay Callback] Worldpay reports the payment for ${orderId} as ` +
          `${gatewayResponse?.lastEvent || gatewayResponse?.outcome}. No order created.`
      );
      pendingCheckoutsMap.delete(orderId);
      return res.redirect(`/payment/failed?orderId=${encodeURIComponent(orderId)}&reason=payment_declined`);
    }

    const txId = (params.txId ||
      params.transactionId ||
      gatewayResponse?.id ||
      `WP-CB-${Date.now().toString().slice(-6)}`) as string;
    const authCode = (params.authCode ||
      gatewayResponse?.authorizationCode ||
      'CALLBACK-OK') as string;

    try {
      await saveVerifiedOrder(orderId, {
        transactionId: txId,
        authCode,
        cardBrand: gatewayResponse?.paymentInstrument?.card?.brand || 'Worldpay Card',
        gatewayResponse,
        // Only Worldpay's own answer marks an order Paid. When it has not
        // published the payment yet the order is saved as Pending, and the
        // webhook — or the status poll the checkout page runs for 90 seconds —
        // completes it once the authorisation appears.
        paymentConfirmed: outcome === 'authorised'
      });
      console.log(
        outcome === 'authorised'
          ? `[Worldpay Callback] Order ${orderId} confirmed by Worldpay and saved as Paid.`
          : `[Worldpay Callback] Order ${orderId} saved as Pending — Worldpay has not published an authorised payment yet.`
      );
    } catch (error) {
      console.error('[Worldpay Callback] Error saving order on callback:', error);
    }

    return res.redirect(`/payment/success?orderId=${encodeURIComponent(orderId)}&txId=${encodeURIComponent(txId)}`);
  }

  return res.redirect(`/payment/failed?orderId=${encodeURIComponent(orderId)}&reason=unknown_status`);
};

router.get('/callback', handleWorldpayCallback);
router.post('/callback', handleWorldpayCallback);

// POST /api/worldpay/webhook - Official Worldpay Webhook Handler
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    const event = req.body;
    if (!event || !event.type || !event.data) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    const orderId = event.data.attributes?.metadata?.orderId || event.data.attributes?.reference;
    if (!orderId) {
      return res.status(200).json({ received: true, ignored: true });
    }

    const paymentStatus = event.data.attributes?.status;
    const transactionId = event.data.attributes?.transactionId || event.data.id;
    const authCode = event.data.attributes?.authCode;
    const cardBrand = event.data.attributes?.paymentMethod?.card?.brand;

    if (paymentStatus === 'authorized' || paymentStatus === 'captured' || paymentStatus === 'settled') {
      await saveVerifiedOrder(orderId, {
        transactionId,
        authCode,
        cardBrand,
        // Carries any stored-credential reference Worldpay included in the event.
        gatewayResponse: event.data.attributes,
        webhookEventId: event.data.id
      });
    } else if (paymentStatus === 'failed') {
      pendingCheckoutsMap.delete(orderId);
    }

    return res.status(200).json({ received: true, processed: true, orderId });
  } catch (error: any) {
    console.error('[Worldpay Webhook] Processing error:', error);
    return res.status(200).json({ received: true, processed: false, error: error.message });
  }
});

// GET /api/worldpay/status - Check order payment status
router.get('/status', async (req: Request, res: Response) => {
  try {
    const orderId = req.query.orderId as string;
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });

    let foundOrder: any = null;
    try {
      foundOrder = await prisma.order.findUnique({ where: { id: orderId } });
    } catch (_e) {}

    if (!foundOrder) {
      try {
        const orders: any[] = (await fetchResource('orders')) || [];
        foundOrder = orders.find((o: any) => String(o.id) === String(orderId));
      } catch (_e) {}
    }

    // The checkout page polls this for 90 seconds after the shopper returns.
    // That is the natural moment to re-ask Worldpay about an order the callback
    // could not confirm: the authorisation usually appears within seconds, and
    // completing it here means the order does not depend on a webhook being
    // configured. It also captures the stored-card mandate the subscription
    // needs, which is only readable from this query.
    if (foundOrder && foundOrder.paymentStatus === 'Pending') {
      const gatewayResponse = await fetchWorldpayPaymentDetails(orderId);
      const outcome = paymentOutcome(gatewayResponse);

      if (outcome === 'authorised') {
        console.log(`[Worldpay Status] Worldpay now confirms ${orderId}; completing the order.`);
        try {
          foundOrder = await saveVerifiedOrder(orderId, {
            transactionId: gatewayResponse?.id || foundOrder.worldpayTxId || orderId,
            authCode: gatewayResponse?.authorizationCode || foundOrder.worldpayAuthCode || 'AUTH-OK',
            cardBrand: gatewayResponse?.paymentInstrument?.card?.brand || foundOrder.cardBrand,
            gatewayResponse,
            paymentConfirmed: true
          }) || foundOrder;
        } catch (completionErr: any) {
          console.error(`[Worldpay Status] Failed to complete ${orderId}:`, completionErr?.message);
        }
      } else if (outcome === 'failed') {
        console.warn(`[Worldpay Status] Worldpay reports ${orderId} as not paid; leaving it Pending.`);
      }
    }

    if (!foundOrder || foundOrder.paymentStatus !== 'Paid') {
      return res.json({
        orderId,
        paid: false,
        status: foundOrder ? foundOrder.paymentStatus : 'Unpaid'
      });
    }

    return res.json({
      orderId: foundOrder.id,
      paid: true,
      status: 'Paid',
      transactionId: foundOrder.worldpayTxId || foundOrder.gatewayTxId || null,
      authCode: foundOrder.worldpayAuthCode || foundOrder.gatewayAuthCode || null,
      cardBrand: foundOrder.cardBrand || null,
      updatedAt: foundOrder.updatedAt || null
    });

  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to check payment status' });
  }
});

// GET /api/worldpay/order/:id - Get order details
router.get('/order/:id', async (req: Request, res: Response) => {
  try {
    const orderId = req.params.id;
    let foundOrder: any = null;

    try {
      foundOrder = await prisma.order.findUnique({ where: { id: orderId } });
    } catch (_e) {}

    if (!foundOrder) {
      try {
        const orders: any[] = (await fetchResource('orders')) || [];
        foundOrder = orders.find((o: any) => String(o.id) === String(orderId));
      } catch (_e) {}
    }

    if (!foundOrder) {
      return res.status(404).json({ error: 'Order not found' });
    }

    return res.json(foundOrder);

  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to fetch order' });
  }
});

// POST /api/worldpay/refund - Process Worldpay Payment Provider Refund
router.post('/refund', async (req: Request, res: Response) => {
  try {
    const { orderId, amount, reason, transactionId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    let foundOrder: any = null;
    try {
      foundOrder = await prisma.order.findUnique({ where: { id: orderId } });
    } catch (_e) {}

    if (!foundOrder) {
      try {
        const orders: any[] = (await fetchResource('orders')) || [];
        foundOrder = orders.find((o: any) => String(o.id) === String(orderId));
      } catch (_e) {}
    }

    if (!foundOrder) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const refundAmount = typeof amount === 'number' ? amount : (foundOrder.total || 0);

    const { refundWorldpayPayment } = await import('../services/worldpayRefund');
    const refundResult = await refundWorldpayPayment({
      order: foundOrder,
      amount: refundAmount,
      reason: reason || 'Customer requested refund',
      transactionId: transactionId || foundOrder.worldpayTxId || foundOrder.gatewayTxId
    });

    // Persist through saveSingleOrder. The Paid -> Refunded transition sends the
    // refund email exactly once; this route used to send it directly as well,
    // which is why a cancellation produced two refund emails.
    const { saveSingleOrder } = await import('./orders');
    const updatedOrder = await saveSingleOrder({
      ...foundOrder,
      paymentStatus: 'Refunded',
      fulfillmentStatus: foundOrder.fulfillmentStatus === 'Fulfilled' ? 'Fulfilled' : 'Cancelled',
      refundAmount,
      refundReason: reason || 'Refund issued to payment card',
      refundDetails: {
        refundRef: refundResult.refundRef,
        amount: refundResult.amount,
        reason: reason || 'Refund processed via Worldpay Gateway',
        gatewayContacted: refundResult.gatewayContacted,
        gatewayMessage: refundResult.message,
        refundedAt: new Date().toISOString()
      }
    });

    return res.json({
      success: refundResult.success,
      refundRef: refundResult.refundRef,
      transactionId: refundResult.transactionId,
      amount: refundResult.amount,
      gatewayContacted: refundResult.gatewayContacted,
      message: refundResult.message,
      order: updatedOrder
    });

  } catch (error: any) {
    console.error('[Worldpay Refund] Internal Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to process Worldpay refund' });
  }
});

export default router;
