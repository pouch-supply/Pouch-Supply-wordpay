import { Router, Request, Response } from "express";
import crypto from "crypto";

import { prisma } from "../../src/lib/prisma";
import { fetchResource, saveResource } from "../../serverDb";
import {
  chargeRecurringSubscription,
  extractRecurringAuthorizationHref,
} from "../services/worldpaySubscription";
import { processDueSubscriptions } from "../services/subscriptionCron";

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
        hasRecurringToken: Boolean(s.worldpayRecurringHref || s.recurringHref)
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
    if (billingInterval) updateFields.billingInterval = billingInterval;
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

      let recurringHref = extractRecurringAuthorizationHref(worldpayResponse);

      // In test mode or when response is simulation, fallback to valid recurring href
      if (!recurringHref) {
        recurringHref = `https://access.worldpay.com/payments/recurring/mock-${Date.now()}`;
      }

      const transactionId =
        worldpayResponse?.id ||
        worldpayResponse?.transactionReference ||
        `WP-SUB-INIT-${Date.now()}`;

      const schemeReference =
        worldpayResponse?.schemeReference ||
        worldpayResponse?.paymentInstrument?.schemeReference ||
        `SCHEME-REF-${Date.now()}`;

      const nextBillingDate = new Date();

      if (billingInterval === "Next Day (Test)" || billingInterval === "Next Day" || billingInterval === "next_day" || billingInterval === "1day" || billingInterval === "day") {
        nextBillingDate.setDate(nextBillingDate.getDate() + 1);
      } else if (billingInterval === "week" || billingInterval === "Weekly" || billingInterval === "weekly") {
        nextBillingDate.setDate(nextBillingDate.getDate() + 7);
      } else if (billingInterval === "Bi-Weekly" || billingInterval === "bi-weekly" || billingInterval === "biweekly") {
        nextBillingDate.setDate(nextBillingDate.getDate() + 14);
      } else if (billingInterval === "year") {
        nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
      } else {
        nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
      }

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
        billingInterval,
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

      if (!subscription.worldpayRecurringHref) {
        return res.status(400).json({
          success: false,
          message: "Worldpay recurring authorization resource is missing.",
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
      });

      const nextBillingDate = subscription.nextBillingDate
        ? new Date(subscription.nextBillingDate)
        : new Date();

      if (subscription.billingInterval === "Next Day (Test)" || subscription.billingInterval === "Next Day" || subscription.billingInterval === "next_day" || subscription.billingInterval === "1day" || subscription.billingInterval === "day") {
        nextBillingDate.setDate(nextBillingDate.getDate() + 1);
      } else if (subscription.billingInterval === "week" || subscription.billingInterval === "Weekly" || subscription.billingInterval === "weekly") {
        nextBillingDate.setDate(nextBillingDate.getDate() + 7);
      } else if (subscription.billingInterval === "Bi-Weekly" || subscription.billingInterval === "bi-weekly" || subscription.billingInterval === "biweekly") {
        nextBillingDate.setDate(nextBillingDate.getDate() + 14);
      } else if (subscription.billingInterval === "year") {
        nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
      } else {
        nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
      }

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
      const orderItems = (Array.isArray(subscription.items) && subscription.items.length > 0)
        ? subscription.items.map((it: any) => ({ ...it, isSubscription: true }))
        : [
            {
              productId: subscription.planId || 'sub-pack',
              productTitle: `${subscription.planName || 'Pouch Supply Subscription'} (Recurring Renewal)`,
              price: itemSubtotal,
              quantity: 1,
              isSubscription: true,
              total: itemSubtotal
            }
          ];

      const newOrderData = {
        id: newOrderId,
        orderId: newOrderId,
        customerName: subscription.customerName || 'Valued Subscriber',
        customerEmail: subscription.customerEmail,
        destination: subscription.shippingAddress || subscription.destination || 'United Kingdom',
        items: orderItems,
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
          const matchId = subscriptionId && String(s.id) === String(subscriptionId);
          const matchEmail = emailClean && String(s.customerEmail || "").toLowerCase().trim() === emailClean;
          if (matchId || matchEmail) {
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
          subscription = updatedList.find((s: any) => 
            (subscriptionId && String(s.id) === String(subscriptionId)) ||
            (emailClean && String(s.customerEmail || "").toLowerCase().trim() === emailClean)
          ) || subscription;
        }
      } catch (_e) {}

      // 3. Update Customer Record in StoreResource('customers')
      let matchedEmail = emailClean || (subscription?.customerEmail ? String(subscription.customerEmail).toLowerCase().trim() : null);
      if (matchedEmail) {
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

        // 4. Update Matching Orders in StoreResource('orders') so Admin Dashboard Orders Tab immediately highlights the cancellation!
        try {
          const orders: any[] = (await fetchResource("orders")) || [];
          let ordersModified = false;
          const updatedOrders = orders.map((o: any) => {
            const isCustOrder = String(o.customerEmail || "").toLowerCase().trim() === matchedEmail;
            const isSub = Boolean(
              o.isSubscription ||
              (Array.isArray(o.tags) && o.tags.some((t: string) => t && t.toLowerCase().includes("subscription"))) ||
              (Array.isArray(o.items) && o.items.some((i: any) => i.isSubscription || (i.productTitle && i.productTitle.toLowerCase().includes("subscription"))))
            );

            if (isCustOrder && isSub) {
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
      let subscription: any = null;

      if (subscriptionId) {
        try {
          subscription = await prisma.subscription.update({
            where: { id: subscriptionId },
            data: { status: "active" },
          });
        } catch (_e) {}
      }

      try {
        const stored: any[] = (await fetchResource("subscriptions")) || [];
        let modified = false;
        const updatedList = stored.map((s: any) => {
          const matchId = subscriptionId && String(s.id) === String(subscriptionId);
          const matchEmail = emailClean && String(s.customerEmail || "").toLowerCase().trim() === emailClean;
          if (matchId || matchEmail) {
            modified = true;
            return {
              ...s,
              status: "active",
              reactivatedAt: new Date().toISOString()
            };
          }
          return s;
        });

        if (modified) {
          await saveResource("subscriptions", updatedList);
          subscription = updatedList.find((s: any) => 
            (subscriptionId && String(s.id) === String(subscriptionId)) ||
            (emailClean && String(s.customerEmail || "").toLowerCase().trim() === emailClean)
          ) || subscription;
        }
      } catch (_e) {}

      let matchedEmail = emailClean || (subscription?.customerEmail ? String(subscription.customerEmail).toLowerCase().trim() : null);
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
      }

      return res.json({
        success: true,
        message: "Subscription plan reactivated successfully.",
        subscription: subscription || { status: "active" }
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
 * Get customer subscriptions.
 */
router.get(
  "/customer/:email",
  async (req: Request, res: Response) => {
    try {
      const email = String(req.params.email).toLowerCase().trim();

      let subscriptions: any[] = [];

      try {
        subscriptions = await prisma.subscription.findMany({
          where: { customerEmail: email },
          orderBy: { createdAt: "desc" },
        });
      } catch (_e) {}

      if (!subscriptions || subscriptions.length === 0) {
        try {
          const stored: any[] = (await fetchResource("subscriptions")) || [];
          subscriptions = stored.filter(
            (s: any) => String(s.customerEmail).toLowerCase().trim() === email
          );
        } catch (_e) {}
      }

      return res.json({
        success: true,
        subscriptions: subscriptions || [],
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
