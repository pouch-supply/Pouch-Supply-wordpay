import { prisma } from '../../src/lib/prisma';
import { fetchResource, saveResource, getDb } from '../../serverDb';
import {
  chargeRecurringSubscription,
  isUsableRecurringHref,
  isPlaceholderCredential,
  simulationAllowed
} from './worldpaySubscription';
import { buildRenewalOrderItems, extractBoxItems, planTitleFromSubscription } from './subscriptionBox';

export interface RenewalResult {
  processed: number;
  succeeded: number;
  failed: number;
  skipped?: boolean;
  details: any[];
}

/**
 * The canonical set of billing intervals used across the whole app.
 * Every module must normalise free-text frequencies to one of these before
 * doing date maths — see `normalizeBillingInterval`.
 */
export type BillingInterval = '1day' | 'weekly' | 'bi-weekly' | 'month' | 'year';

/**
 * Normalises any free-text billing frequency to a canonical interval.
 *
 * Storefront values ("Next Day (Test)", "Bi-Weekly", "One Month"), admin values
 * ("14 days", "1 Month"), and stored values ("1day", "month") all funnel through
 * here so that the checkout, the admin plan editor and the renewal worker can
 * never disagree about what a subscription's schedule actually is.
 */
export function normalizeBillingInterval(raw: any): BillingInterval {
  const s = String(raw ?? '').toLowerCase().trim();
  if (!s) return 'month';

  // An explicit day count is the most specific signal, so it wins over loose
  // keyword matching. Without this, "14 days" matches /day/ and is billed daily.
  const dayCount = s.match(/(\d+)\s*(?:d|day|days)\b/);
  if (dayCount) {
    const n = parseInt(dayCount[1], 10);
    if (n <= 1) return '1day';
    if (n <= 7) return 'weekly';
    if (n <= 14) return 'bi-weekly';
    if (n <= 31) return 'month';
    return 'year';
  }

  if (/year|annual|12\s*month/.test(s)) return 'year';
  if (/bi[\s_-]*week|biweek|fortnight/.test(s)) return 'bi-weekly';
  if (/month/.test(s)) return 'month';
  if (/week/.test(s)) return 'weekly';
  if (/next[\s_-]*day|daily|per\s*day|every\s*day|^day$|^1day$/.test(s)) return '1day';

  return 'month';
}

/**
 * Advances a date by one billing period.
 */
export function addBillingInterval(interval: BillingInterval, fromDate: Date): Date {
  const next = new Date(fromDate);
  switch (interval) {
    case '1day':
      next.setDate(next.getDate() + 1);
      break;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'bi-weekly':
      next.setDate(next.getDate() + 14);
      break;
    case 'year':
      next.setFullYear(next.getFullYear() + 1);
      break;
    case 'month':
    default:
      next.setMonth(next.getMonth() + 1);
      break;
  }
  return next;
}

/**
 * Calculates the next billing date based on the plan's billing interval.
 */
export function calculateNextBillingDate(interval: string, fromDate: Date = new Date()): Date {
  return addBillingInterval(normalizeBillingInterval(interval), fromDate);
}

/**
 * Computes the next billing date after a successful charge.
 *
 * Anchored to the date that was actually due (not to "now") so that a worker
 * that runs a few minutes late does not permanently drift the schedule. If the
 * subscription is far behind (e.g. the server was down for days) we catch the
 * anchor up to the future rather than replaying every missed period.
 */
export function nextBillingDateAfterCharge(
  interval: string,
  scheduledFor: Date | null | undefined,
  now: Date = new Date()
): Date {
  const norm = normalizeBillingInterval(interval);
  const anchor = scheduledFor && !isNaN(new Date(scheduledFor).getTime()) ? new Date(scheduledFor) : new Date(now);

  let next = addBillingInterval(norm, anchor);
  let guard = 0;
  while (next <= now && guard < 400) {
    next = addBillingInterval(norm, next);
    guard++;
  }
  return next;
}

/**
 * Reads every subscription from Prisma AND the JSON store and merges them by id.
 *
 * The two stores are kept in sync on write, but a record can exist in only one
 * of them. Reading both and de-duplicating avoids the previous behaviour where
 * an empty Prisma result silently re-scanned the file store and could process
 * the same subscription from two different sources.
 */
async function loadAllSubscriptions(): Promise<any[]> {
  const byId = new Map<string, any>();

  const isConnected = await getDb().catch(() => false);
  if (isConnected) {
    try {
      const rows = await prisma.subscription.findMany({ where: { status: 'active' } });
      for (const row of rows || []) {
        byId.set(String(row.id), row);
      }
    } catch (_e) {
      // Prisma unavailable — the JSON store below is the source of truth.
    }
  }

  try {
    const stored: any[] = (await fetchResource('subscriptions')) || [];
    for (const row of stored) {
      if (!row || !row.id) continue;
      const key = String(row.id);
      byId.set(key, { ...(row || {}), ...(byId.get(key) || {}) });
    }
  } catch (_e) {}

  return Array.from(byId.values());
}

// Columns that exist on the Prisma Subscription model. Passing an unknown key
// makes Prisma reject the whole update, which would silently drop the fields
// that DO exist (notably nextBillingDate) — so the Prisma write is filtered
// while the JSON store keeps the full record.
//
// The second group was declared on the model but missing from the table until
// the 20260908_subscription_missing_columns migration, so those writes were
// being discarded by Postgres. They are persisted now.
const PRISMA_SUBSCRIPTION_FIELDS = new Set([
  'customerId', 'customerEmail', 'customerName', 'planId', 'planName', 'amount', 'currency',
  'status', 'billingInterval', 'nextBillingDate', 'worldpayTransactionId',
  'worldpayRecurringHref', 'worldpaySchemeReference', 'lastPaymentStatus', 'lastPaymentId',
  'lastPaymentAt', 'failedPaymentCount',
  'lastPaymentError', 'items', 'cansCount', 'itemPrice', 'shippingCost', 'shippingAddress',
  'deliveryMethod', 'sourceOrderId', 'cancelledAt', 'cancellationReason'
]);

/**
 * Persists a partial update to a subscription in both stores.
 */
async function persistSubscriptionUpdate(subId: string, updateData: Record<string, any>) {
  const prismaData: Record<string, any> = {};
  for (const [key, value] of Object.entries(updateData)) {
    if (PRISMA_SUBSCRIPTION_FIELDS.has(key)) prismaData[key] = value;
  }

  if (Object.keys(prismaData).length > 0) {
    try {
      await prisma.subscription.update({ where: { id: subId }, data: prismaData });
    } catch (_e) {}
  }

  try {
    const storedSubs: any[] = (await fetchResource('subscriptions')) || [];
    const updatedList = storedSubs.map((s: any) =>
      String(s.id) === String(subId) ? { ...s, ...updateData } : s
    );
    await saveResource('subscriptions', updatedList);
  } catch (_e) {}
}

/**
 * Determines whether a subscription is due, backfilling a missing schedule.
 *
 * A subscription with no `nextBillingDate` used to be treated as "due right
 * now", which meant it was re-charged on every single worker tick. Instead we
 * derive the schedule it should have had from its last payment and store it.
 */
async function resolveDueDate(sub: any, now: Date): Promise<{ due: boolean; scheduledFor: Date | null }> {
  const interval = normalizeBillingInterval(sub.billingInterval);

  if (sub.nextBillingDate) {
    const parsed = new Date(sub.nextBillingDate);
    if (!isNaN(parsed.getTime())) {
      return { due: parsed <= now, scheduledFor: parsed };
    }
  }

  const anchorRaw = sub.lastPaymentAt || sub.createdAt || now;
  const anchor = new Date(anchorRaw);
  const backfilled = addBillingInterval(interval, isNaN(anchor.getTime()) ? now : anchor);

  console.warn(
    `[Subscription Worker] Sub ${sub.id} had no nextBillingDate; backfilling to ${backfilled.toISOString()}.`
  );
  await persistSubscriptionUpdate(String(sub.id), { nextBillingDate: backfilled });

  return { due: backfilled <= now, scheduledFor: backfilled };
}

// Guards against overlapping runs. The worker's startup run, its interval tick
// and the /api/subscriptions/cron HTTP endpoint all call into this function, and
// a renewal takes long enough (gateway + emails) to overlap on short intervals.
let isProcessing = false;

/**
 * Runs the subscription renewal engine for all active subscriptions due for billing.
 */
export async function processDueSubscriptions(): Promise<RenewalResult> {
  if (isProcessing) {
    console.log('[Subscription Worker] A renewal run is already in progress; skipping this tick.');
    return { processed: 0, succeeded: 0, failed: 0, skipped: true, details: [] };
  }

  isProcessing = true;
  const now = new Date();

  try {
    console.log(`[Subscription Worker] Scanning for due renewals at ${now.toISOString()}...`);

    const allSubs = await loadAllSubscriptions();
    const active = allSubs.filter((s: any) => String(s.status || '').toLowerCase() === 'active');

    const subscriptions: Array<{ sub: any; scheduledFor: Date | null }> = [];
    for (const sub of active) {
      const { due, scheduledFor } = await resolveDueDate(sub, now);
      if (due) subscriptions.push({ sub, scheduledFor });
    }

    console.log(`[Subscription Worker] Found ${subscriptions.length} subscription(s) due for renewal.`);

    const results: any[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const { sub, scheduledFor } of subscriptions) {
      const subId = String(sub.id);
      const customerEmail = String(sub.customerEmail || '').toLowerCase().trim();
      const recurringHref = sub.worldpayRecurringHref || sub.recurringHref;
      const schemeReference = sub.worldpaySchemeReference;
      const amount = Number(sub.amount || 25.0);
      const currency = sub.currency || 'GBP';
      const planName = planTitleFromSubscription(sub);
      const interval = normalizeBillingInterval(sub.billingInterval);

      console.log(
        `[Subscription Worker] Processing renewal for sub ${subId} (${customerEmail}) — £${amount.toFixed(2)} every ${interval}`
      );

      // A credential is only real if Worldpay issued it. Subscriptions created
      // by earlier builds carry locally generated placeholders, which look
      // present but cannot authorise anything — treat them as missing rather
      // than burning retry attempts on a charge that can never succeed.
      const hasUsableCredential =
        isUsableRecurringHref(recurringHref) ||
        (Boolean(schemeReference) && !isPlaceholderCredential(schemeReference));

      // In simulation mode the charge is deliberately faked, so a missing
      // credential must not block the run — this is how the 1-day test schedule
      // can be exercised end to end without live Worldpay stored credentials.
      //
      // This asks the charger rather than reading the flag directly, so a live
      // account is treated as unsimulatable in both places. Reading the env var
      // here would let the worker proceed into a charge the charger refuses.
      const allowSimulated = simulationAllowed();

      if (!hasUsableCredential && !allowSimulated) {
        console.warn(
          `[Subscription Worker] Sub ${subId} skipped: no usable Worldpay stored credential ` +
            `(href=${recurringHref || 'none'}, scheme=${schemeReference || 'none'}). ` +
            `The initial payment must be taken with a customer agreement so Worldpay returns a reusable reference.`
        );
        failed++;
        // Push the schedule forward so a broken subscription is not re-scanned every tick.
        await persistSubscriptionUpdate(subId, {
          nextBillingDate: nextBillingDateAfterCharge(interval, scheduledFor, now),
          lastPaymentStatus: 'missing_credential'
        });
        results.push({ id: subId, status: 'skipped', reason: 'Missing Worldpay stored credential' });
        continue;
      }

      // Claim the slot BEFORE charging. If anything below throws (or another
      // worker tick starts), the subscription is no longer selectable as due,
      // which is what prevents duplicate charges for the same period.
      const claimedNextBilling = nextBillingDateAfterCharge(interval, scheduledFor, now);
      await persistSubscriptionUpdate(subId, { nextBillingDate: claimedNextBilling });

      const transactionReference = `SUB-ORD-${Math.floor(10000 + Math.random() * 90000)}-${Date.now()
        .toString()
        .slice(-4)}`;

      try {
        // 1. Charge Worldpay using the stored MIT credential / scheme reference
        const chargeResult = await chargeRecurringSubscription({
          recurringHref,
          transactionReference,
          amount,
          currency,
          schemeReference,
          previousTransactionId: sub.worldpayTransactionId,
          customerEmail
        });

        console.log(`[Subscription Worker] Charge SUCCESS for ${subId}: Tx ${transactionReference}`);

        // 2. Calculate item subtotal & shipping cost for the renewal order
        const shippingAmount = typeof sub.shippingFee === 'number'
          ? sub.shippingFee
          : (typeof sub.shippingCost === 'number'
              ? sub.shippingCost
              : (typeof sub.shippingAmount === 'number'
                  ? sub.shippingAmount
                  : (typeof sub.deliveryCost === 'number'
                      ? sub.deliveryCost
                      : (amount >= 40 ? 0 : 2.99))));

        const itemSubtotal = Number(Math.max(0, amount - shippingAmount).toFixed(2)) || amount;

        // 3. Create the recurring order
        const newOrderId = `PS${Math.floor(10000 + Math.random() * 90000)}`;
        const orderItems = buildRenewalOrderItems(sub, itemSubtotal, planTitleFromSubscription(sub));

        const newOrderData = {
          id: newOrderId,
          orderId: newOrderId,
          customerName: sub.customerName || 'Valued Subscriber',
          customerEmail,
          destination: sub.shippingAddress || sub.destination || 'United Kingdom',
          items: orderItems,
          // The chosen products travel with the renewal so the order detail view
          // shows the real box contents rather than re-parsing the plan title.
          subscriptionItems: extractBoxItems(sub),
          subscriptionPlan: planName,
          total: amount,
          subtotal: itemSubtotal,
          shippingCost: shippingAmount,
          deliveryCost: shippingAmount,
          storeCreditApplied: 0,
          discountApplied: null,
          fulfillmentStatus: 'Unfulfilled',
          paymentStatus: 'Paid',
          paymentMethod: 'Worldpay Recurring Subscription',
          worldpayTxId: chargeResult?.id || transactionReference,
          gatewayTxId: chargeResult?.id || transactionReference,
          worldpayAuthCode: chargeResult?.authCode || null,
          gatewayAuthCode: chargeResult?.authCode || null,
          cardBrand: 'Worldpay Stored Card',
          deliveryMethod: sub.deliveryMethod || 'Royal Mail Tracked 24/48',
          carrier: 'Royal Mail',
          tags: ['Storefront', 'Subscription Order', 'Worldpay Recurring'],
          date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
            ' at ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          subscriptionId: subId,
          isSubscription: true,
          data: {
            subscriptionId: subId,
            schemeReference: chargeResult?.schemeReference || schemeReference,
            paymentMethod: 'Worldpay Access MIT',
            recurringRenewal: true,
            simulatedPayment: Boolean(chargeResult?.simulated),
            shippingCost: shippingAmount,
            subtotal: itemSubtotal
          },
          createdAt: new Date().toISOString()
        };

        // saveSingleOrder is the single funnel for order persistence AND for the
        // customer/admin notifications and Klaviyo events. Nothing is sent here.
        try {
          const { saveSingleOrder } = await import('../routes/orders');
          await saveSingleOrder(newOrderData);
        } catch (ordErr) {
          console.warn('[Subscription Worker] Order save fallback:', ordErr);
          const storedOrders: any[] = (await fetchResource('orders')) || [];
          storedOrders.unshift(newOrderData);
          await saveResource('orders', storedOrders);
        }

        // Optionally auto-register a Royal Mail shipment. Off by default so the
        // renewal confirmation is not immediately followed by a dispatch email.
        try {
          const { getRoyalMailSettings, createRoyalMailShipment } = await import('./royalMailService');
          const rmSettings = await getRoyalMailSettings();
          const hasKey = Boolean(rmSettings.apiKey || process.env.ROYAL_MAIL_API_KEY || process.env.RM_API_KEY);
          if (rmSettings.enabled && rmSettings.autoCreateShipmentOnPayment && hasKey) {
            createRoyalMailShipment(newOrderId, {
              serviceCode: rmSettings.defaultServiceCode || 'TPN',
              weightGrams: rmSettings.defaultWeightGrams || 350
            }).catch(err => {
              console.warn(
                `[Subscription Worker] Background Royal Mail shipment note for #${newOrderId}:`,
                err?.message
              );
            });
          }
        } catch (_rmErr) {}

        // 4. Record the successful payment against the subscription
        const updateData = {
          lastPaymentStatus: 'authorized',
          lastPaymentId: chargeResult?.id || transactionReference,
          lastPaymentAt: new Date(),
          worldpayTransactionId: chargeResult?.id || sub.worldpayTransactionId,
          worldpaySchemeReference: chargeResult?.schemeReference || schemeReference,
          nextBillingDate: claimedNextBilling,
          failedPaymentCount: 0
        };
        await persistSubscriptionUpdate(subId, updateData);

        // Update customer stats and next payment date
        try {
          const customers: any[] = (await fetchResource('customers')) || [];
          const foundCust = customers.find(
            (c: any) => String(c.email).toLowerCase().trim() === customerEmail
          );
          if (foundCust) {
            foundCust.ordersCount = (foundCust.ordersCount || 0) + 1;
            foundCust.amountSpent = Number(((foundCust.amountSpent || 0) + amount).toFixed(2));
            foundCust.nextPayment = claimedNextBilling.toISOString().split('T')[0];
            foundCust.subStatus = 'active';
            foundCust.subscriptionStatus = 'Active Subscriber';
            await saveResource('customers', customers);
          }
        } catch (_e) {}

        succeeded++;
        results.push({
          id: subId,
          status: 'succeeded',
          orderId: newOrderId,
          nextBillingDate: claimedNextBilling.toISOString(),
          transactionReference,
          simulated: Boolean(chargeResult?.simulated)
        });
      } catch (chargeErr: any) {
        console.error(`[Subscription Worker] Charge FAILED for sub ${subId}:`, chargeErr.message);
        failed++;

        const newFailedCount = (sub.failedPaymentCount || 0) + 1;
        const isPastDue = newFailedCount >= 3;

        // Retry in 24 hours, or stop after 3 consecutive failures.
        const retryBillingDate = new Date(now);
        retryBillingDate.setDate(retryBillingDate.getDate() + 1);

        const failUpdate: any = {
          lastPaymentStatus: 'failed',
          lastPaymentError: String(chargeErr.message || chargeErr).slice(0, 500),
          failedPaymentCount: newFailedCount,
          nextBillingDate: isPastDue ? null : retryBillingDate,
          status: isPastDue ? 'past_due' : 'active'
        };
        await persistSubscriptionUpdate(subId, failUpdate);

        results.push({
          id: subId,
          status: 'failed',
          error: chargeErr.message,
          retryScheduled: isPastDue ? 'none (past_due)' : retryBillingDate.toISOString()
        });
      }
    }

    return {
      processed: subscriptions.length,
      succeeded,
      failed,
      details: results
    };
  } finally {
    isProcessing = false;
  }
}

let cronIntervalHandle: NodeJS.Timeout | null = null;

/**
 * Initializes the background recurring worker timer.
 */
export function startSubscriptionRenewalWorker(intervalMs: number = 5 * 60 * 1000) {
  if (cronIntervalHandle) {
    clearInterval(cronIntervalHandle);
  }

  console.log(`[Subscription Worker] Background worker initialized (interval: ${intervalMs / 1000}s).`);

  // Run shortly after startup
  setTimeout(() => {
    processDueSubscriptions().catch(err => console.error('[Subscription Worker] Startup run error:', err));
  }, 3000);

  // Periodic recurring check
  cronIntervalHandle = setInterval(() => {
    processDueSubscriptions().catch(err => console.error('[Subscription Worker] Periodic run error:', err));
  }, intervalMs);
}
