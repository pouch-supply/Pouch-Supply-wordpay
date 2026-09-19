/**
 * The one rule for what a subscription costs per delivery.
 *
 * Before this existed the calculation lived in two places that disagreed:
 * checkout applied a frequency discount and added shipping
 * (SubscriptionBuilder + the Worldpay callback), while a plan change from the
 * account portal wrote the raw tier price with neither. A customer who switched
 * plans therefore ended up on an amount they were never quoted, and admin price
 * edits reached neither path.
 *
 * `Subscription.amount` is the gross figure Worldpay is asked for, so it is what
 * this produces: items plus shipping, after the frequency discount.
 */

export type BillingFrequency = string;

/** Charged per can beyond a plan's included allowance. */
export const EXTRA_CAN_PRICE = 3.8;

/**
 * Discount for committing to a delivery rhythm. Weekly is the smallest because
 * the customer is already paying most often.
 */
export function frequencyDiscountPercent(frequency: BillingFrequency | undefined | null): number {
  const f = String(frequency || '').trim().toLowerCase();
  if (f === 'weekly' || f === 'week' || f === '1week') return 5;
  if (f === 'one month' || f === 'monthly' || f === 'month' || f === '1month') return 12;
  return 10;
}

export interface RecurringAmountInput {
  /** The plan's headline price, from the admin plan catalogue. */
  planPrice: number;
  /** Cans beyond the plan's allowance. */
  extraCans?: number;
  /** Delivery rhythm, which sets the discount. */
  frequency?: BillingFrequency | null;
  /** Shipping added on top AFTER the discount, exactly as checkout does it. */
  shippingCost?: number;
}

/** Rounds to pennies. Money must never carry floating-point dust into a charge. */
const pennies = (n: number): number => Number((Math.round(n * 100) / 100).toFixed(2));

/**
 * The gross recurring amount.
 *
 * Mirrors checkout step for step: extras are added before the discount, and
 * shipping after it — a discount on postage was never offered and applying one
 * here would quietly undercharge every delivery.
 */
export function computeRecurringAmount({
  planPrice,
  extraCans = 0,
  frequency,
  shippingCost = 0
}: RecurringAmountInput): number {
  const base = Number(planPrice) || 0;
  const extras = Math.max(0, Number(extraCans) || 0) * EXTRA_CAN_PRICE;
  const discounted = (base + extras) * ((100 - frequencyDiscountPercent(frequency)) / 100);
  const shipping = Math.max(0, Number(shippingCost) || 0);
  return pennies(discounted + shipping);
}

/**
 * The shipping a subscription should carry when its own record does not say.
 *
 * Mirrors the renewal split in subscriptionCron: free over the threshold,
 * otherwise the standard fee.
 */
export const FREE_SHIPPING_THRESHOLD = 40;
export const STANDARD_SHIPPING = 2.99;

export function defaultShippingFor(itemsTotal: number): number {
  return Number(itemsTotal) >= FREE_SHIPPING_THRESHOLD ? 0 : STANDARD_SHIPPING;
}

/**
 * The shipping already agreed for an existing subscription.
 *
 * Taken from the record wherever the various writers happened to put it, so a
 * repricing keeps the postage the customer agreed to rather than recomputing it
 * and moving them across the free-delivery threshold by accident.
 */
export function existingShippingFor(sub: any): number {
  const candidates = [
    sub?.shippingCost,
    sub?.shippingFee,
    sub?.shippingAmount,
    sub?.deliveryCost
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return defaultShippingFor(Number(sub?.itemPrice) || 0);
}
