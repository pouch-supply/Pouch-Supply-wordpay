import { Router, Request, Response } from "express";
import crypto from "crypto";

import { prisma } from "../../src/lib/prisma";
import { fetchResource, saveResource } from "../../serverDb";
import {
  chargeRecurringSubscription,
  extractRecurringAuthorizationHref,
  extractSchemeReference,
  isPlaceholderCredential,
  isUsableRecurringHref,
} from "../services/worldpaySubscription";
import {
  processDueSubscriptions,
  calculateNextBillingDate,
  nextBillingDateAfterCharge,
  normalizeBillingInterval
} from "../services/subscriptionCron";
import { buildRenewalOrderItems, extractBoxItems, planTitleFromSubscription } from "../services/subscriptionBox";

const router = Router();

/**
 * Manual / Browser / Cron trigger to process all due renewals.
 * Supports both GET (for browser URL visits / cron pings) and POST.
 */
const handleProcessRenewals = async (_req: Request, res: Response) => {
  try {
    const result = await processDueSubscriptions();
    return res.json({
      success: true,
      message: `Processed ${result.processed} subscription(s): ${result.succeeded} succeeded, ${result.failed} failed.`,
      timestamp: new Date().toISOString(),
      ...result
    });
  } catch (error: any) {
    console.error("[Process Renewals Error]", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to process due subscriptions"
    });
  }
};

router.get("/process-renewals", handleProcessRenewals);
router.post("/process-renewals", handleProcessRenewals);
router.get("/cron", handleProcessRenewals);
router.post("/cron", handleProcessRenewals);

/**
 * Diagnostic endpoint: Returns all subscriptions, due renewals count, and worker status.
 */
/**
 * Whether Worldpay could actually be asked to charge this subscription again.
 *
 * Presence of a reference is not enough: subscriptions created before the
 * checkout requested a customer agreement carry manufactured values such as
 * "SCHEME-WP-CB-213847" and a /payments/recurring/wp-<id> URL that resolves to
 * nothing. Those are reported as unchargeable so they are not mistaken for live
 * recurring plans.
 */
function canChargeRecurring(sub: any): boolean {
  if (!sub) return false;
  const href = sub.worldpayRecurringHref || sub.recurringHref;
  const scheme = sub.worldpaySchemeReference;
  return isUsableRecurringHref(href) || (Boolean(scheme) && !isPlaceholderCredential(scheme));
}

/** Statuses that mean "this plan is still running and can bill". */
const LIVE_SUB_STATUSES = ["active", "subscribed", "paused", "trialing"];

/** A subscription the customer has removed from their account. Kept for admin history. */
const DELETED_SUB_STATUS = "deleted";

function isLiveStatus(status?: string): boolean {
  return LIVE_SUB_STATUSES.includes(String(status || "").toLowerCase());
}

function isDeletedStatus(status?: string): boolean {
  return String(status || "").toLowerCase() === DELETED_SUB_STATUS;
}

/**
 * Is this order part of the given subscription?
 *
 * When a specific subscription is being cancelled or resumed, only its own
 * orders should change. The customer-wide match is the fallback for records
 * written before orders carried a subscriptionId, and for the account-level
 * buttons that act on every plan at once.
 */
function orderBelongsToSubscription(order: any, subscription: any, allowUnlinked: boolean): boolean {
  if (!subscription) return false;
  const subId = String(subscription.id || "");
  if (!subId) return false;

  const orderSubId = String(
    order?.subscriptionId || order?.subscriptionDetails?.subscriptionId || order?.data?.subscriptionId || ""
  );
  if (orderSubId) return orderSubId === subId;
  if (String(subscription.sourceOrderId || "") === String(order?.id || "")) return true;

  // Orders written before checkout recorded a subscriptionId cannot be
  // attributed to one plan. They are still updated when the customer has only
  // one plan — there is nothing else they could belong to — and left alone
  // otherwise rather than guessing and clearing the wrong plan's cancellation.
  return allowUnlinked;
}

function isSubscriptionOrder(order: any): boolean {
  return Boolean(
    order?.isSubscription ||
      (Array.isArray(order?.tags) && order.tags.some((t: string) => t && t.toLowerCase().includes("subscription"))) ||
      (Array.isArray(order?.items) &&
        order.items.some((i: any) => i?.isSubscription || (i?.productTitle && i.productTitle.toLowerCase().includes("subscription"))))
  );
}

/**
 * Every subscription for one customer, merged from Prisma and the JSON store.
 *
 * Either store can be missing a record — Prisma writes are best-effort behind
 * try/catch throughout this file — so a decision like "does this customer still
 * have a live plan?" has to consider both.
 */
async function loadCustomerSubscriptions(email: string): Promise<any[]> {
  const clean = String(email || "").toLowerCase().trim();
  if (!clean) return [];
  const byId = new Map<string, any>();

  try {
    const rows = await prisma.subscription.findMany({ where: { customerEmail: clean } });
    for (const row of rows || []) byId.set(String(row.id), row);
  } catch (_e) {}

  try {
    const stored: any[] = (await fetchResource("subscriptions")) || [];
    for (const s of stored) {
      if (String(s?.customerEmail || "").toLowerCase().trim() !== clean) continue;
      const id = String(s.id || "");
      byId.set(id, { ...(byId.get(id) || {}), ...s });
    }
  } catch (_e) {}

  return Array.from(byId.values());
}

/**
 * Does the customer still have a plan that bills, ignoring the one being changed?
 *
 * The account-level "Cancelled" flag drives the storefront banner and the admin
 * customer record, so cancelling one of three plans must not mark the whole
 * account cancelled.
 */
async function customerHasOtherLiveSubscription(email: string, excludeId?: string | null): Promise<boolean> {
  const subs = await loadCustomerSubscriptions(email);
  return subs.some(s => (excludeId ? String(s.id) !== String(excludeId) : true) && isLiveStatus(s.status));
}

/**
 * The customer-facing shape of a subscription. Deliberately omits the Worldpay
 * mandate references — the account page only needs to know whether a recurring
 * charge is possible, not the credential that authorises it.
 */
function toCustomerSubscription(s: any, now: Date = new Date()) {
  return {
    id: s.id,
    // The order the plan was bought on. The account page shows it so a customer
    // can quote one reference to support for both the plan and its first
    // payment. Records written before checkout recorded it have none, and the
    // account page falls back to the customer's own order history there.
    sourceOrderId: s.sourceOrderId || null,
    planId: s.planId,
    planName: s.planName,
    customerEmail: s.customerEmail,
    customerName: s.customerName,
    amount: s.amount,
    currency: s.currency || "GBP",
    status: s.status,
    billingInterval: s.billingInterval,
    nextBillingDate: s.nextBillingDate,
    isDue: Boolean(s.nextBillingDate && new Date(s.nextBillingDate) <= now),
    cansCount: s.cansCount,
    items: s.items,
    itemPrice: s.itemPrice,
    shippingCost: s.shippingCost,
    deliveryMethod: s.deliveryMethod,
    lastPaymentStatus: s.lastPaymentStatus,
    lastPaymentAt: s.lastPaymentAt,
    cancelledAt: s.cancelledAt,
    cancellationReason: s.cancellationReason,
    reactivatedAt: s.reactivatedAt,
    createdAt: s.createdAt,
    canChargeRecurring: canChargeRecurring(s),
    // Resuming a plan whose mandate was never issued would look successful and
    // then fail silently at the next renewal, so the account page says so up front.
    credentialIssue: canChargeRecurring(s)
      ? null
      : "This plan has no stored-card mandate with Worldpay, so it cannot take a recurring payment. Subscribe again to set one up."
  };
}

router.get("/status", async (_req: Request, res: Response) => {
  try {
    let subscriptions: any[] = [];
    try {
      subscriptions = await prisma.subscription.findMany({
        orderBy: { createdAt: "desc" }
      });
    } catch (_e) {}

    if (!subscriptions || subscriptions.length === 0) {
      try {
        subscriptions = (await fetchResource("subscriptions")) || [];
      } catch (_e) {}
    }

    const now = new Date();
    const active = subscriptions.filter((s: any) => s.status === "active");
    const due = active.filter((s: any) => !s.nextBillingDate || new Date(s.nextBillingDate) <= now);

    return res.json({
      success: true,
      workerStatus: "running",
      interval: "5 minutes",
      totalCount: subscriptions.length,
      activeCount: active.length,
      dueNowCount: due.length,
      timestamp: now.toISOString(),
      subscriptions: subscriptions.map((s: any) => ({
        id: s.id,
        customerName: s.customerName,
        customerEmail: s.customerEmail,
        planName: s.planName,
        amount: s.amount,
        currency: s.currency || "GBP",
        status: s.status,
        billingInterval: s.billingInterval,
        nextBillingDate: s.nextBillingDate,
        isDue: !s.nextBillingDate || new Date(s.nextBillingDate) <= now,
        lastPaymentStatus: s.lastPaymentStatus,
        lastPaymentAt: s.lastPaymentAt,
        worldpayTransactionId: s.worldpayTransactionId,
        // A stored value is not the same as a usable mandate. Earlier builds wrote
        // locally manufactured references that look present but authorise nothing,
        // so reporting mere presence here showed dead subscriptions as healthy.
        hasRecurringToken: canChargeRecurring(s),
        canChargeRecurring: canChargeRecurring(s),
        credentialIssue: canChargeRecurring(s)
          ? null
          : "No Worldpay stored-card mandate. This subscription cannot take a recurring payment; the customer must subscribe again so Worldpay issues one."
      }))
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch subscription status"
    });
  }
});

/**
 * Update billing interval or next billing date for a subscription.
 */
router.post("/update-schedule", async (req: Request, res: Response) => {
  try {
    const { subscriptionId, customerEmail, billingInterval, nextBillingDate, chargeImmediately } = req.body;
    
    if (!subscriptionId && !customerEmail) {
      return res.status(400).json({ success: false, message: "subscriptionId or customerEmail is required" });
    }

    const emailClean = customerEmail ? String(customerEmail).toLowerCase().trim() : null;
    let targetNextDate: Date | null = null;
    if (chargeImmediately) {
      targetNextDate = new Date(Date.now() - 1000); // 1 sec in the past to trigger immediately
    } else if (nextBillingDate) {
      targetNextDate = new Date(nextBillingDate);
    }

    const updateFields: any = {};
    if (billingInterval) updateFields.billingInterval = normalizeBillingInterval(billingInterval);
    if (targetNextDate) updateFields.nextBillingDate = targetNextDate;

    if (subscriptionId) {
      try {
        await prisma.subscription.update({
          where: { id: subscriptionId },
          data: updateFields
        });
      } catch (_e) {}
    }

    try {
      const stored: any[] = (await fetchResource("subscriptions")) || [];
      const updatedList = stored.map((s: any) => {
        const match = (subscriptionId && String(s.id) === String(subscriptionId)) ||
          (emailClean && String(s.customerEmail || "").toLowerCase().trim() === emailClean);
        if (match) {
          return { ...s, ...updateFields };
        }
        return s;
      });
      await saveResource("subscriptions", updatedList);
    } catch (_e) {}

    return res.json({
      success: true,
      message: "Subscription schedule updated successfully",
      updatedFields: updateFields
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update schedule"
    });
  }
});

/**
 * Update complete subscription plan, products/flavors, and box items for an active customer.
 * Persists updates to Neon PostgreSQL, StoreResource, Customer profile, and recent subscription orders.
 */
router.post("/update-plan", async (req: Request, res: Response) => {
  try {
    const {
      subscriptionId,
      customerEmail,
      planId,
      planName,
      subPlan,
      amount,
      subPrice,
      billingInterval,
      subFrequency,
      subCansCount,
      cansCount,
      items,
      subItems,
      status,
      subStatus,
      nextPayment,
      nextDelivery,
      nextBillingDate
    } = req.body;

    if (!customerEmail && !subscriptionId) {
      return res.status(400).json({ success: false, message: "customerEmail or subscriptionId is required" });
    }

    const emailClean = customerEmail ? String(customerEmail).toLowerCase().trim() : null;
    const finalPlanName = subPlan || planName || (planId ? planId.toUpperCase() : "Custom Box");
    const finalPlanId = planId || (subPlan ? subPlan.toLowerCase().split(" ")[0] : "custom");
    const finalAmount = Number(subPrice ?? amount ?? 0);
    // Store the canonical interval so the renewal worker schedules the plan the
    // admin actually picked, whatever wording the UI sent.
    const finalInterval = normalizeBillingInterval(subFrequency || billingInterval || "Bi-Weekly");
    const finalItems = subItems || items || [];
    const finalCans = subCansCount ?? cansCount ?? (Array.isArray(finalItems) ? finalItems.reduce((sum: number, it: any) => sum + (Number(it.quantity) || 1), 0) : 6);
    const finalStatus = (subStatus || status || "active").toLowerCase();

    // The box contents belong in Postgres too. They were only ever written to
    // the JSON store, so a renewal reading the subscription from Prisma could
    // not reproduce the box the customer had just edited.
    const planFields = {
      planId: finalPlanId,
      planName: finalPlanName,
      amount: finalAmount,
      billingInterval: finalInterval,
      status: finalStatus,
      ...(Array.isArray(finalItems) ? { items: finalItems } : {}),
      ...(Number.isFinite(Number(finalCans)) ? { cansCount: Number(finalCans) } : {}),
      ...(nextBillingDate ? { nextBillingDate: new Date(nextBillingDate) } : {})
    };

    // 1. Update Prisma subscription record if exists
    if (subscriptionId) {
      try {
        await prisma.subscription.update({
          where: { id: subscriptionId },
          data: planFields
        });
      } catch (_e) {}
    } else if (emailClean) {
      try {
        const existingSub = await prisma.subscription.findFirst({
          where: { customerEmail: emailClean }
        });
        if (existingSub) {
          await prisma.subscription.update({
            where: { id: existingSub.id },
            data: planFields
          });
        }
      } catch (_e) {}
    }

    // 2. Update StoreResource 'subscriptions'
    try {
      const storedSubs: any[] = (await fetchResource("subscriptions")) || [];
      let foundSub = false;
      const updatedSubs = storedSubs.map((s: any) => {
        // A named subscription is the only one touched. Matching on the email as
        // well meant editing one plan rewrote every plan the customer had — a
        // customer with two boxes saw both change when they edited either.
        const match = subscriptionId
          ? String(s.id) === String(subscriptionId)
          : Boolean(emailClean && String(s.customerEmail || "").toLowerCase().trim() === emailClean && !isDeletedStatus(s.status));
        if (match) {
          foundSub = true;
          return {
            ...s,
            planId: finalPlanId,
            planName: finalPlanName,
            amount: finalAmount,
            billingInterval: finalInterval,
            items: finalItems,
            cansCount: finalCans,
            status: finalStatus,
            updatedAt: new Date().toISOString()
          };
        }
        return s;
      });

      if (!foundSub && emailClean) {
        updatedSubs.push({
          id: subscriptionId || `sub_${Date.now()}`,
          customerEmail: emailClean,
          planId: finalPlanId,
          planName: finalPlanName,
          amount: finalAmount,
          billingInterval: finalInterval,
          items: finalItems,
          cansCount: finalCans,
          status: finalStatus,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
      await saveResource("subscriptions", updatedSubs);
    } catch (_e) {}

    // 3. Update StoreResource 'customers' & Prisma Customer
    let updatedCustomerRecord: any = null;
    if (emailClean) {
      try {
        const storedCustomers: any[] = (await fetchResource("customers")) || [];
        const updatedCustList = storedCustomers.map((c: any) => {
          if (String(c.email || "").toLowerCase().trim() === emailClean) {
            const updatedC = {
              ...c,
              subscriptionStatus: finalStatus === "active" ? "Subscribed" : (finalStatus === "paused" ? "Paused" : "Not subscribed"),
              subStatus: finalStatus === "active" ? "Active" : (finalStatus === "paused" ? "Paused" : "Cancelled"),
              subPlan: finalPlanName,
              subPrice: finalAmount,
              subFrequency: finalInterval,
              subCansCount: finalCans,
              subItems: finalItems,
              subPlanManuallyConfigured: true,
              ...(nextPayment ? { nextPayment } : {}),
              ...(nextDelivery ? { nextDelivery } : {}),
              data: {
                ...(c.data || {}),
                subPlan: finalPlanName,
                subPrice: finalAmount,
                subFrequency: finalInterval,
                subCansCount: finalCans,
                subItems: finalItems,
                subPlanManuallyConfigured: true
              }
            };
            updatedCustomerRecord = updatedC;
            return updatedC;
          }
          return c;
        });

        await saveResource("customers", updatedCustList);

        // Update Prisma customer table
        try {
          await prisma.customer.updateMany({
            where: { email: emailClean },
            data: {
              subscriptionStatus: finalStatus === "active" ? "Subscribed" : (finalStatus === "paused" ? "Paused" : "Not subscribed"),
              subStatus: finalStatus === "active" ? "Active" : (finalStatus === "paused" ? "Paused" : "Cancelled"),
              subPlan: finalPlanName,
              subPrice: finalAmount,
              subFrequency: finalInterval,
              subCansCount: finalCans,
              ...(nextPayment ? { nextPayment } : {}),
              ...(nextDelivery ? { nextDelivery } : {})
            }
          });
        } catch (_prErr) {}
      } catch (_e) {}
    }

    // 4. Update the most recent subscription order in StoreResource 'orders' if available
    if (emailClean) {
      try {
        const storedOrders: any[] = (await fetchResource("orders")) || [];
        const updatedOrders = storedOrders.map((o: any) => {
          const isCustomerOrder = String(o.customerEmail || "").toLowerCase().trim() === emailClean;
          if (isCustomerOrder && Array.isArray(o.items)) {
            const hasSubItem = o.items.some((i: any) => i.isSubscription || i.subscriptionPlan) ||
              Boolean(o.subscriptionDetails) ||
              (Array.isArray(o.tags) && o.tags.some((t: any) => String(t).toLowerCase().includes('subscription')));

            if (hasSubItem) {
              const updatedItems = o.items.map((i: any) => {
                const isSub = i.isSubscription || i.subscriptionPlan || (Array.isArray(o.tags) && o.tags.some((t: any) => String(t).toLowerCase().includes('subscription')));
                if (isSub) {
                  return {
                    ...i,
                    subscriptionPlan: finalPlanName,
                    subscriptionFrequency: finalInterval,
                    price: finalAmount > 0 ? finalAmount : i.price,
                    selectedProducts: finalItems,
                    selectedFlavors: finalItems,
                    subscriptionItems: finalItems,
                    items: finalItems
                  };
                }
                return i;
              });

              return {
                ...o,
                items: updatedItems,
                subscriptionDetails: {
                  ...(o.subscriptionDetails || {}),
                  planName: finalPlanName,
                  frequency: finalInterval,
                  items: finalItems,
                  selectedProducts: finalItems,
                  subItems: finalItems,
                  lastSwappedAt: new Date().toISOString()
                },
                total: finalAmount > 0 ? finalAmount : o.total
              };
            }
          }
          return o;
        });
        await saveResource("orders", updatedOrders);
      } catch (_ordErr) {}
    }

    console.log(`[Subscription Plan Update] Successfully updated subscription for ${emailClean || subscriptionId}: ${finalPlanName} (£${finalAmount})`);

    return res.json({
      success: true,
      message: `Subscription plan updated to ${finalPlanName} successfully!`,
      plan: {
        planId: finalPlanId,
        planName: finalPlanName,
        amount: finalAmount,
        billingInterval: finalInterval,
        cansCount: finalCans,
        items: finalItems,
        status: finalStatus
      },
      customer: updatedCustomerRecord
    });
  } catch (error: any) {
    console.error("[Subscription Plan Update] Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update subscription plan"
    });
  }
});

/**
 * Create subscription record after the FIRST successful payment.
 */
router.post(
  "/create",
  async (req: Request, res: Response) => {
    try {
      const {
        customerId,
        customerName,
        customerEmail,
        planId,
        planName,
        amount,
        shippingCost,
        shippingFee,
        shippingAddress,
        deliveryMethod,
        items,
        currency = "GBP",
        billingInterval = "month",
        worldpayResponse,
      } = req.body;

      if (!customerEmail) {
        return res.status(400).json({
          success: false,
          message: "customerEmail is required",
        });
      }

      if (!planId) {
        return res.status(400).json({
          success: false,
          message: "planId is required",
        });
      }

      if (!amount || Number(amount) <= 0) {
        return res.status(400).json({
          success: false,
          message: "Valid subscription amount is required",
        });
      }

      // Only Worldpay can issue a stored-credential reference. Substituting a
      // locally generated "mock-" URL made the subscription look chargeable
      // while every renewal actually hit a non-existent endpoint.
      const recurringHref = extractRecurringAuthorizationHref(worldpayResponse);
      const schemeReference = extractSchemeReference(worldpayResponse);

      const transactionId =
        worldpayResponse?.id || worldpayResponse?.transactionReference || null;

      if (!recurringHref && !schemeReference) {
        console.warn(
          `[Subscription Create] No Worldpay stored credential in the supplied gateway response for ${customerEmail}. ` +
            `Renewals for this subscription will fail until a scheme transaction reference is recorded.`
        );
      }

      // Shared normaliser — the previous exact-string comparisons silently fell
      // through to monthly for any casing or wording they did not list.
      const normalizedInterval = normalizeBillingInterval(billingInterval);
      const nextBillingDate = calculateNextBillingDate(normalizedInterval, new Date());

      const emailClean = String(customerEmail).toLowerCase().trim();
      const subId = `sub_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;

      const effectiveShipping = typeof shippingFee === 'number'
        ? shippingFee
        : (typeof shippingCost === 'number' ? shippingCost : (Number(amount) >= 40 ? 0 : 2.99));

      const subData = {
        id: subId,
        customerId: customerId || null,
        customerEmail: emailClean,
        customerName: customerName || "Valued Customer",
        planId,
        planName: planName || "Nicotine Pouch Subscription Plan",
        amount: Number(amount),
        shippingFee: effectiveShipping,
        shippingCost: effectiveShipping,
        shippingAmount: effectiveShipping,
        shippingAddress: shippingAddress || 'United Kingdom',
        deliveryMethod: deliveryMethod || 'Royal Mail Tracked 24/48',
        items: Array.isArray(items) ? items : undefined,
        currency,
        status: "active",
        billingInterval: normalizedInterval,
        nextBillingDate,
        worldpayTransactionId: transactionId,
        worldpayRecurringHref: recurringHref,
        worldpaySchemeReference: schemeReference,
        lastPaymentStatus: "authorized",
        lastPaymentId: transactionId,
        lastPaymentAt: new Date(),
      };

      let subscription: any = null;

      try {
        subscription = await prisma.subscription.create({
          data: subData,
        });
      } catch (prismaErr) {
        console.warn("[Subscription Create] Prisma save fallback:", prismaErr);
        subscription = subData;
      }

      // Sync to StoreResource for persistence redundancy
      try {
        const existing: any[] = (await fetchResource("subscriptions")) || [];
        existing.unshift(subscription);
        await saveResource("subscriptions", existing.slice(0, 500));
      } catch (_e) {}

      // Update customer subscription status
      try {
        const customers: any[] = (await fetchResource("customers")) || [];
        const foundCust = customers.find((c: any) => c.email.toLowerCase() === emailClean);
        if (foundCust) {
          foundCust.subscriptionStatus = "Active Subscriber";
          foundCust.subStatus = "active";
          foundCust.subPlan = planName || planId;
          foundCust.subPrice = Number(amount);
          foundCust.nextPayment = nextBillingDate.toISOString().split("T")[0];
          await saveResource("customers", customers);
        }
      } catch (_e) {}

      return res.status(201).json({
        success: true,
        subscription,
      });
    } catch (error: any) {
      console.error("[Subscription Create]", error);

      return res.status(500).json({
        success: false,
        message: error.message || "Failed to create subscription",
      });
    }
  }
);

/**
 * Charge an existing subscription.
 */
router.post(
  "/charge",
  async (req: Request, res: Response) => {
    try {
      const { subscriptionId } = req.body;

      if (!subscriptionId) {
        return res.status(400).json({
          success: false,
          message: "subscriptionId is required",
        });
      }

      let subscription: any = null;

      try {
        subscription = await prisma.subscription.findUnique({
          where: { id: subscriptionId },
        });
      } catch (_e) {}

      if (!subscription) {
        try {
          const stored: any[] = (await fetchResource("subscriptions")) || [];
          subscription = stored.find((s: any) => String(s.id) === String(subscriptionId));
        } catch (_e) {}
      }

      if (!subscription) {
        return res.status(404).json({
          success: false,
          message: "Subscription not found",
        });
      }

      if (subscription.status !== "active") {
        return res.status(400).json({
          success: false,
          message: `Subscription is ${subscription.status}.`,
        });
      }

      if (!subscription.worldpayRecurringHref && !subscription.worldpaySchemeReference) {
        return res.status(400).json({
          success: false,
          message:
            "This subscription has no Worldpay stored credential, so no recurring payment can be taken.",
        });
      }

      const transactionReference = `SUB-${Date.now()}-${crypto
        .randomBytes(4)
        .toString("hex")
        .toUpperCase()}`;

      const chargeAmount = Number(subscription.amount);
      const result = await chargeRecurringSubscription({
        recurringHref: subscription.worldpayRecurringHref,
        transactionReference,
        amount: chargeAmount,
        currency: subscription.currency || "GBP",
        schemeReference: subscription.worldpaySchemeReference,
        previousTransactionId: subscription.worldpayTransactionId,
        customerEmail: subscription.customerEmail,
      });

      // Shared scheduling helper, anchored to the date that was due.
      const nextBillingDate = nextBillingDateAfterCharge(
        subscription.billingInterval,
        subscription.nextBillingDate ? new Date(subscription.nextBillingDate) : null
      );

      const updatePayload = {
        lastPaymentStatus: "authorized",
        lastPaymentId: result?.id || transactionReference,
        lastPaymentAt: new Date(),
        nextBillingDate,
        failedPaymentCount: 0,
      };

      let updated: any = null;

      try {
        updated = await prisma.subscription.update({
          where: { id: subscription.id },
          data: updatePayload,
        });
      } catch (_e) {
        updated = { ...subscription, ...updatePayload };
      }

      try {
        const stored: any[] = (await fetchResource("subscriptions")) || [];
        const updatedList = stored.map((s: any) =>
          String(s.id) === String(subscription.id) ? { ...s, ...updatePayload } : s
        );
        await saveResource("subscriptions", updatedList);
      } catch (_e) {}

      // Calculate shipping cost and item subtotal
      const shippingAmount = typeof subscription.shippingFee === 'number'
        ? subscription.shippingFee
        : (typeof subscription.shippingCost === 'number'
            ? subscription.shippingCost
            : (typeof subscription.shippingAmount === 'number'
                ? subscription.shippingAmount
                : (typeof subscription.deliveryCost === 'number'
                    ? subscription.deliveryCost
                    : (chargeAmount >= 40 ? 0 : 2.99))));

      const itemSubtotal = Number(Math.max(0, chargeAmount - shippingAmount).toFixed(2)) || chargeAmount;

      // Create recurring order record in database
      const newOrderId = `PS${Math.floor(10000 + Math.random() * 90000)}`;
      const orderItems = buildRenewalOrderItems(subscription, itemSubtotal, planTitleFromSubscription(subscription));

      const newOrderData = {
        id: newOrderId,
        orderId: newOrderId,
        customerName: subscription.customerName || 'Valued Subscriber',
        customerEmail: subscription.customerEmail,
        destination: subscription.shippingAddress || subscription.destination || 'United Kingdom',
        items: orderItems,
        // The chosen products travel with the renewal so the order detail view
        // shows the real box contents rather than re-parsing the plan title.
        subscriptionItems: extractBoxItems(subscription),
        subscriptionPlan: planTitleFromSubscription(subscription),
        total: chargeAmount,
        subtotal: itemSubtotal,
        shippingCost: shippingAmount,
        deliveryCost: shippingAmount,
        storeCreditApplied: 0,
        discountApplied: null,
        status: 'Processing',
        fulfillmentStatus: 'Unfulfilled',
        paymentStatus: 'Paid',
        paymentMethod: 'Worldpay Recurring Subscription',
        worldpayTxId: result?.id || transactionReference,
        gatewayTxId: result?.id || transactionReference,
        worldpayAuthCode: result?.authCode || 'AUTH-OK-MIT',
        gatewayAuthCode: result?.authCode || 'AUTH-OK-MIT',
        cardBrand: 'Worldpay Stored Card',
        deliveryMethod: subscription.deliveryMethod || 'Royal Mail Tracked 24/48',
        carrier: 'Royal Mail',
        tags: ['Storefront', 'Subscription Order', 'Worldpay Recurring'],
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        subscriptionId: subscription.id,
        isSubscription: true,
        data: {
          subscriptionId: subscription.id,
          schemeReference: result?.schemeReference || subscription.worldpaySchemeReference,
          paymentMethod: 'Worldpay Access MIT',
          recurringRenewal: true,
          shippingCost: shippingAmount,
          subtotal: itemSubtotal
        },
        createdAt: new Date().toISOString()
      };

      try {
        const { saveSingleOrder } = await import('./orders');
        await saveSingleOrder(newOrderData);
      } catch (_ordErr) {}

      return res.json({
        success: true,
        transactionReference,
        worldpayResponse: result,
        subscription: updated,
      });
    } catch (error: any) {
      console.error("[Subscription Charge]", error);

      const subscriptionId = req.body?.subscriptionId;

      if (subscriptionId) {
        const retryDate = new Date();
        retryDate.setDate(retryDate.getDate() + 1);

        const failUpdate = {
          lastPaymentStatus: "failed",
          failedPaymentCount: { increment: 1 },
          nextBillingDate: retryDate,
        };

        try {
          await prisma.subscription.update({
            where: { id: subscriptionId },
            data: failUpdate,
          });
        } catch (_e) {}

        try {
          const stored: any[] = (await fetchResource("subscriptions")) || [];
          const updatedList = stored.map((s: any) =>
            String(s.id) === String(subscriptionId)
              ? { ...s, lastPaymentStatus: "failed", failedPaymentCount: (s.failedPaymentCount || 0) + 1, nextBillingDate: retryDate }
              : s
          );
          await saveResource("subscriptions", updatedList);
        } catch (_e) {}
      }

      return res.status(402).json({
        success: false,
        message: error.message || "Recurring payment failed",
      });
    }
  }
);

/**
 * Cancel subscription.
 */
router.post(
  "/cancel",
  async (req: Request, res: Response) => {
    try {
      const { subscriptionId, customerEmail, reason } = req.body;

      if (!subscriptionId && !customerEmail) {
        return res.status(400).json({
          success: false,
          message: "subscriptionId or customerEmail is required",
        });
      }

      const emailClean = customerEmail ? String(customerEmail).toLowerCase().trim() : null;
      const cancellationTime = new Date().toISOString();
      const cancelReason = reason || "Customer cancelled subscription plan via Account portal";

      let subscription: any = null;

      // 1. Update in Prisma if subscriptionId is provided
      if (subscriptionId) {
        try {
          subscription = await prisma.subscription.update({
            where: { id: subscriptionId },
            data: { status: "cancelled" },
          });
        } catch (_e) {}
      }

      // 2. Update in StoreResource('subscriptions')
      try {
        const stored: any[] = (await fetchResource("subscriptions")) || [];
        let modified = false;
        const updatedList = stored.map((s: any) => {
          // A named plan is the only one cancelled. Falling through to the email
          // as well cancelled every plan the customer held, so cancelling one of
          // three stopped all three. The email is the match only when no plan is
          // named — that is what the account-level button means.
          const match = subscriptionId
            ? String(s.id) === String(subscriptionId)
            : Boolean(emailClean && String(s.customerEmail || "").toLowerCase().trim() === emailClean);
          if (match) {
            modified = true;
            return {
              ...s,
              status: "cancelled",
              cancelledAt: cancellationTime,
              cancellationReason: cancelReason
            };
          }
          return s;
        });

        if (modified) {
          await saveResource("subscriptions", updatedList);
          // Reports back the plan that was actually changed, using the same
          // rule the update above applied.
          subscription = updatedList.find((s: any) =>
            subscriptionId
              ? String(s.id) === String(subscriptionId)
              : Boolean(emailClean && String(s.customerEmail || "").toLowerCase().trim() === emailClean)
          ) || subscription;
        }
      } catch (_e) {}

      // 3. Update Customer Record in StoreResource('customers')
      let matchedEmail = emailClean || (subscription?.customerEmail ? String(subscription.customerEmail).toLowerCase().trim() : null);

      // Cancelling one of several plans must not mark the whole account
      // cancelled — the storefront banner and the admin customer record both
      // read this flag.
      const stillSubscribed = matchedEmail
        ? await customerHasOtherLiveSubscription(matchedEmail, subscriptionId || subscription?.id)
        : false;

      if (matchedEmail && !stillSubscribed) {
        try {
          const customers: any[] = (await fetchResource("customers")) || [];
          let custModified = false;
          const updatedCustomers = customers.map((c: any) => {
            if (String(c.email || "").toLowerCase().trim() === matchedEmail) {
              custModified = true;
              return {
                ...c,
                subscriptionStatus: "Cancelled",
                subStatus: "Cancelled",
                isSubscriptionCancelled: true,
                subscriptionCancelledAt: cancellationTime,
                subscriptionCancellationReason: cancelReason
              };
            }
            return c;
          });

          if (custModified) {
            await saveResource("customers", updatedCustomers);
          }
        } catch (custErr) {
          console.warn("[Subscription Cancel] Failed to update customer:", custErr);
        }
      }

      if (matchedEmail) {
        // Orders written before checkout recorded a subscriptionId can only be
        // attributed to a plan when the customer holds a single one.
        const singlePlanCustomer = (await loadCustomerSubscriptions(matchedEmail)).length <= 1;

        // 4. Update Matching Orders in StoreResource('orders') so Admin Dashboard Orders Tab immediately highlights the cancellation!
        try {
          const orders: any[] = (await fetchResource("orders")) || [];
          let ordersModified = false;
          const updatedOrders = orders.map((o: any) => {
            const isCustOrder = String(o.customerEmail || "").toLowerCase().trim() === matchedEmail;
            const isSub = isSubscriptionOrder(o);
            // With a specific plan named, only its own orders are marked. Without
            // one the customer cancelled everything, so every subscription order
            // is fair game — that is what the account-level button means.
            const inScope = subscriptionId
              ? orderBelongsToSubscription(o, subscription || { id: subscriptionId }, singlePlanCustomer)
              : true;

            if (isCustOrder && isSub && inScope) {
              ordersModified = true;
              const tags = Array.isArray(o.tags) ? [...o.tags] : ["Storefront", "Online Order"];
              if (!tags.includes("Subscription Cancelled")) {
                tags.push("Subscription Cancelled");
              }

              const subDetails = o.subscriptionDetails ? { ...o.subscriptionDetails } : {};
              subDetails.status = "Cancelled";
              subDetails.isCancelled = true;
              subDetails.cancelledAt = cancellationTime;
              subDetails.cancellationReason = cancelReason;

              return {
                ...o,
                tags,
                subscriptionCancelled: true,
                subscriptionCancelledAt: cancellationTime,
                subscriptionCancellationReason: cancelReason,
                subscriptionDetails: subDetails
              };
            }
            return o;
          });

          if (ordersModified) {
            await saveResource("orders", updatedOrders);
            console.log(`[Subscription Cancel] Updated matching orders for customer: ${matchedEmail}`);
          }
        } catch (orderErr) {
          console.warn("[Subscription Cancel] Failed to update orders:", orderErr);
        }
      }

      return res.json({
        success: true,
        message: "Subscription successfully cancelled.",
        accountStillSubscribed: stillSubscribed,
        subscription: subscription || { status: "cancelled", cancelledAt: cancellationTime, cancellationReason: cancelReason }
      });
    } catch (error: any) {
      console.error("[Subscription Cancel Error]", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to cancel subscription",
      });
    }
  }
);

/**
 * Reactivate subscription.
 */
router.post(
  "/reactivate",
  async (req: Request, res: Response) => {
    try {
      const { subscriptionId, customerEmail } = req.body;

      if (!subscriptionId && !customerEmail) {
        return res.status(400).json({
          success: false,
          message: "subscriptionId or customerEmail is required",
        });
      }

      const emailClean = customerEmail ? String(customerEmail).toLowerCase().trim() : null;
      const now = new Date();
      let subscription: any = null;

      /**
       * A plan cancelled in March and resumed in September still carries March's
       * nextBillingDate. The renewal worker treats any date in the past as due,
       * so resuming would charge the customer within minutes — for a delivery
       * period they spent unsubscribed. Resuming therefore restarts the clock
       * from today; a date still in the future is left alone so a resume during
       * the paid period does not push the next box back.
       */
      const resumeBillingDate = (sub: any): Date => {
        const raw = sub?.nextBillingDate ? new Date(sub.nextBillingDate) : null;
        if (raw && !isNaN(raw.getTime()) && raw > now) return raw;
        return calculateNextBillingDate(normalizeBillingInterval(sub?.billingInterval), now);
      };

      // A subscription the customer deleted from their account is not resumable
      // by the account-wide button — it is only brought back by name.
      const resumableFromStore = async (): Promise<any[]> => {
        try {
          const stored: any[] = (await fetchResource("subscriptions")) || [];
          return stored.filter((s: any) => {
            const matchId = subscriptionId && String(s.id) === String(subscriptionId);
            const matchEmail = emailClean && String(s.customerEmail || "").toLowerCase().trim() === emailClean;
            if (!matchId && !matchEmail) return false;
            return matchId ? true : !isDeletedStatus(s.status);
          });
        } catch (_e) {
          return [];
        }
      };

      if (subscriptionId) {
        try {
          const existing = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
          subscription = await prisma.subscription.update({
            where: { id: subscriptionId },
            data: {
              status: "active",
              nextBillingDate: resumeBillingDate(existing || (await resumableFromStore())[0]),
              cancelledAt: null,
              cancellationReason: null,
            },
          });
        } catch (_e) {}
      } else if (emailClean) {
        try {
          const existing = await prisma.subscription.findMany({
            where: { customerEmail: emailClean, status: { not: DELETED_SUB_STATUS } },
          });
          // Each plan keeps its own schedule, so they are re-anchored one by one
          // rather than with a single updateMany.
          for (const row of existing || []) {
            await prisma.subscription.update({
              where: { id: row.id },
              data: {
                status: "active",
                nextBillingDate: resumeBillingDate(row),
                cancelledAt: null,
                cancellationReason: null,
              },
            });
          }
          subscription = await prisma.subscription.findFirst({
            where: { customerEmail: emailClean, status: { not: DELETED_SUB_STATUS } },
            orderBy: { createdAt: "desc" },
          });
        } catch (_e) {}
      }

      try {
        const stored: any[] = (await fetchResource("subscriptions")) || [];
        let modified = false;
        const updatedList = stored.map((s: any) => {
          // A named plan is the only one resumed; without one, every plan the
          // customer holds is. Matching the email as well as the id meant
          // resuming one of three plans quietly restarted all three.
          // Without an explicit id, a deleted plan stays deleted.
          const match = subscriptionId
            ? String(s.id) === String(subscriptionId)
            : Boolean(emailClean && String(s.customerEmail || "").toLowerCase().trim() === emailClean && !isDeletedStatus(s.status));
          if (match) {
            modified = true;
            const { cancelledAt, cancellationReason, deletedAt, ...rest } = s;
            return {
              ...rest,
              status: "active",
              nextBillingDate: resumeBillingDate(s).toISOString(),
              reactivatedAt: now.toISOString()
            };
          }
          return s;
        });

        if (modified) {
          await saveResource("subscriptions", updatedList);
          // Reports back the plan that was actually changed, using the same
          // rule the update above applied.
          subscription = updatedList.find((s: any) =>
            subscriptionId
              ? String(s.id) === String(subscriptionId)
              : Boolean(emailClean && String(s.customerEmail || "").toLowerCase().trim() === emailClean)
          ) || subscription;
        }
      } catch (_e) {}

      let matchedEmail = emailClean || (subscription?.customerEmail ? String(subscription.customerEmail).toLowerCase().trim() : null);
      // Same rule as cancellation: an order with no subscriptionId is only
      // attributable when the customer holds a single plan.
      const singlePlanCustomer = matchedEmail ? (await loadCustomerSubscriptions(matchedEmail)).length <= 1 : false;
      if (matchedEmail) {
        try {
          const customers: any[] = (await fetchResource("customers")) || [];
          const updatedCustomers = customers.map((c: any) => {
            if (String(c.email || "").toLowerCase().trim() === matchedEmail) {
              return {
                ...c,
                subscriptionStatus: "Subscribed",
                subStatus: "Active",
                isSubscriptionCancelled: false,
              };
            }
            return c;
          });
          await saveResource("customers", updatedCustomers);
        } catch (_e) {}

        // Reverse the cancellation markers used by the Admin Dashboard. The
        // subscription record alone is not enough because customer status is
        // also derived from historical subscription orders.
        try {
          const orders: any[] = (await fetchResource("orders")) || [];
          let ordersModified = false;
          const updatedOrders = orders.map((o: any) => {
            const isCustOrder = String(o.customerEmail || "").toLowerCase().trim() === matchedEmail;
            const isSub = isSubscriptionOrder(o);
            // Resuming one plan must not clear the cancelled marker from another
            // plan's orders, or the admin dashboard would show a cancelled
            // subscription as running again.
            const inScope = subscriptionId
              ? orderBelongsToSubscription(o, subscription || { id: subscriptionId }, singlePlanCustomer)
              : true;

            if (!isCustOrder || !isSub || !inScope) return o;

            ordersModified = true;
            const tags = (Array.isArray(o.tags) ? o.tags : [])
              .filter((tag: string) => tag.toLowerCase() !== "subscription cancelled");
            const subDetails = o.subscriptionDetails ? { ...o.subscriptionDetails } : {};
            subDetails.status = "Active";
            subDetails.isCancelled = false;
            subDetails.resumedAt = now.toISOString();
            delete subDetails.cancelledAt;
            delete subDetails.cancellationReason;

            return {
              ...o,
              tags,
              subscriptionCancelled: false,
              subscriptionCancelledAt: null,
              subscriptionCancellationReason: null,
              // Recorded so the admin dashboard can say the plan was resumed
              // instead of the cancellation simply vanishing from the order.
              subscriptionResumedAt: now.toISOString(),
              subscriptionDetails: subDetails
            };
          });

          if (ordersModified) {
            await saveResource("orders", updatedOrders);
            console.log(`[Subscription Reactivate] Updated matching orders for customer: ${matchedEmail}`);
          }
        } catch (orderErr) {
          console.warn("[Subscription Reactivate] Failed to update orders:", orderErr);
        }
      }

      const resumedSubscription = subscription || { status: "active" };
      return res.json({
        success: true,
        message: "Subscription plan reactivated successfully.",
        // The account page shows this so the customer can see when the next box
        // is coming, rather than wondering whether resuming charged them today.
        nextBillingDate: (resumedSubscription as any).nextBillingDate || null,
        subscription: resumedSubscription
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to reactivate subscription",
      });
    }
  }
);

/**
 * Remove a finished subscription from the customer's account.
 *
 * This is a soft delete. The record keeps its payment history, renewal orders
 * and Worldpay references — a store cannot answer a chargeback or a refund
 * request about a plan it has erased — but it stops appearing in the customer's
 * list and is never picked up by the renewal worker or the account-wide resume.
 *
 * A live plan is refused: deleting one would stop billing without going through
 * cancellation, leaving the customer's card mandate and the admin record saying
 * different things.
 */
router.post(
  "/delete",
  async (req: Request, res: Response) => {
    try {
      const { subscriptionId, customerEmail } = req.body;

      if (!subscriptionId) {
        return res.status(400).json({ success: false, message: "subscriptionId is required" });
      }

      const emailClean = customerEmail ? String(customerEmail).toLowerCase().trim() : null;
      const deletedAt = new Date().toISOString();

      let stored: any[] = [];
      try {
        stored = (await fetchResource("subscriptions")) || [];
      } catch (_e) {}

      let existing: any = stored.find((s: any) => String(s.id) === String(subscriptionId)) || null;
      if (!existing) {
        try {
          existing = await prisma.subscription.findUnique({ where: { id: String(subscriptionId) } });
        } catch (_e) {}
      }

      if (!existing) {
        return res.status(404).json({ success: false, message: "Subscription not found." });
      }

      // The account portal identifies its customer by email only, so a request
      // that names an email must match the subscription it is trying to remove.
      // Without this, any signed-in customer could delete anyone's plan by id.
      if (emailClean && String(existing.customerEmail || "").toLowerCase().trim() !== emailClean) {
        return res.status(403).json({
          success: false,
          message: "This subscription belongs to a different account."
        });
      }

      if (isLiveStatus(existing.status)) {
        return res.status(409).json({
          success: false,
          message:
            "This subscription is still active. Cancel it first — that stops the recurring payment — and then it can be removed."
        });
      }

      if (isDeletedStatus(existing.status)) {
        return res.json({ success: true, message: "Subscription already removed.", subscriptionId });
      }

      try {
        await prisma.subscription.update({
          where: { id: String(subscriptionId) },
          data: { status: DELETED_SUB_STATUS },
        });
      } catch (_e) {}

      try {
        const updatedList = stored.map((s: any) =>
          String(s.id) === String(subscriptionId)
            ? { ...s, status: DELETED_SUB_STATUS, deletedAt, previousStatus: s.status }
            : s
        );
        await saveResource("subscriptions", updatedList);
      } catch (storeErr) {
        console.warn("[Subscription Delete] Failed to update store:", storeErr);
      }

      return res.json({
        success: true,
        message: "Subscription removed from your account.",
        subscriptionId,
        deletedAt
      });
    } catch (error: any) {
      console.error("[Subscription Delete Error]", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to remove subscription",
      });
    }
  }
);

/**
 * Get customer subscriptions.
 */
router.get(
  "/customer/:email",
  async (req: Request, res: Response) => {
    try {
      const email = String(req.params.email).toLowerCase().trim();
      const now = new Date();

      // Merged from both stores rather than "Prisma, else the file store": a
      // plan that exists in only one of them used to be invisible whenever the
      // other returned anything at all.
      const all = await loadCustomerSubscriptions(email);
      const subscriptions = all
        .filter(s => !isDeletedStatus(s.status))
        .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

      return res.json({
        success: true,
        subscriptions: subscriptions.map(s => toCustomerSubscription(s, now)),
        // Ids and removal times, no plan detail. The account page rebuilds a
        // plan card from a subscription order when this endpoint has no record
        // for it, so it needs to tell "never stored" apart from "the customer
        // removed it" — otherwise removing a plan would resurrect it from its
        // own orders. The timestamp matters too: an order placed after the
        // removal is new activity the removal cannot account for, and hiding it
        // would lose a paid order from the customer's view.
        deletedSubscriptions: all
          .filter(s => isDeletedStatus(s.status))
          .map(s => ({
            id: String(s.id),
            deletedAt: s.deletedAt || s.updatedAt || null,
            // Lets the account page recognise an order that belonged to this
            // plan back when orders did not record which plan billed them.
            planName: s.planName || null,
          })),
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch subscriptions",
      });
    }
  }
);

export default router;
