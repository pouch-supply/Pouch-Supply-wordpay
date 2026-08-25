import { Discount, Customer, CartItem } from '../types';

export interface ResolveDiscountResult {
  success: boolean;
  discount?: Discount;
  error?: string;
  message?: string;
}

/**
 * Extracts the first 3 letters of a customer's name or email to serve as their unique loyalty coupon prefix.
 * e.g. "NEHA" -> "NEH", "Scott Kivlin" -> "SCO", "Bob" -> "BOB", "Jo" -> "JON"
 */
export function getCustomerPrefix(customer?: { name?: string; email?: string } | null): string {
  if (!customer) return 'PS';
  const nameCandidate = (customer.name || customer.email || 'POUCH').trim();
  // Strip non-letter characters
  const lettersOnly = nameCandidate.replace(/[^a-zA-Z]/g, '').toUpperCase();
  if (lettersOnly.length >= 3) {
    return lettersOnly.substring(0, 3);
  }
  return (lettersOnly + 'POUCH').substring(0, 3);
}

/**
 * Formats a loyalty milestone code with customer's 3-letter prefix (e.g. NEH-BRONZE1).
 */
export function formatLoyaltyCouponCode(baseCode: string, customer?: { name?: string; email?: string } | null): string {
  const prefix = getCustomerPrefix(customer);
  // If baseCode already contains a matching prefix, don't duplicate
  if (baseCode.toUpperCase().startsWith(`${prefix}-`)) {
    return baseCode.toUpperCase();
  }
  return `${prefix}-${baseCode.toUpperCase()}`;
}

export interface LoyaltyMilestoneDef {
  code: string;
  order: number;
  reward: string;
  type: Discount['type'];
  valueType?: 'Percentage' | 'Fixed amount';
  valueAmount?: number;
  details: string;
}

export const LOYALTY_MILESTONE_DEFINITIONS: Record<string, LoyaltyMilestoneDef> = {
  BRONZE1: {
    code: 'BRONZE1',
    order: 1,
    reward: 'Members receive 10% OFF',
    type: 'Amount off order',
    valueType: 'Percentage',
    valueAmount: 10,
    details: '10% Bronze Member Welcome Discount'
  },
  BRONZE3: {
    code: 'BRONZE3',
    order: 3,
    reward: 'FREE can of your choice',
    type: 'Amount off order',
    valueType: 'Fixed amount',
    valueAmount: 4.99,
    details: '1 FREE can of your choice (£4.99 off)'
  },
  BRONZE5: {
    code: 'BRONZE5',
    order: 5,
    reward: 'Free Royal Mail Tracked Delivery on your next order',
    type: 'Free shipping',
    valueType: 'Fixed amount',
    valueAmount: 2.99,
    details: 'Free Royal Mail Tracked Delivery (£2.99 shipping waiver)'
  },
  SILVER7: {
    code: 'SILVER7',
    order: 7,
    reward: 'FREE can 🥫',
    type: 'Amount off order',
    valueType: 'Fixed amount',
    valueAmount: 4.99,
    details: '1 FREE can reward (£4.99 off)'
  },
  SILVER9: {
    code: 'SILVER9',
    order: 9,
    reward: '£5 Store Credit 🎁',
    type: 'Amount off order',
    valueType: 'Fixed amount',
    valueAmount: 5.00,
    details: '£5.00 Voucher Discount'
  },
  SILVER11: {
    code: 'SILVER11',
    order: 11,
    reward: 'FREE can 🥫',
    type: 'Amount off order',
    valueType: 'Fixed amount',
    valueAmount: 4.99,
    details: '1 FREE can reward (£4.99 off)'
  },
  SILVER13: {
    code: 'SILVER13',
    order: 13,
    reward: 'Exclusive Pouch Supply merchandise 🎁',
    type: 'Amount off order',
    valueType: 'Fixed amount',
    valueAmount: 5.00,
    details: 'Exclusive Pouch Supply merchandise reward (£5.00 off)'
  },
  SILVER15: {
    code: 'SILVER15',
    order: 15,
    reward: '2 FREE cans 🥫',
    type: 'Amount off order',
    valueType: 'Fixed amount',
    valueAmount: 9.00,
    details: '2 FREE cans reward (£9.00 off)'
  },
  GOLD17: {
    code: 'GOLD17',
    order: 17,
    reward: '20% off your purchase 🎁',
    type: 'Amount off order',
    valueType: 'Percentage',
    valueAmount: 20,
    details: '20% Gold Member Discount'
  },
  GOLD19: {
    code: 'GOLD19',
    order: 19,
    reward: '2 FREE cans 🥫',
    type: 'Amount off order',
    valueType: 'Fixed amount',
    valueAmount: 9.00,
    details: '2 FREE cans reward (£9.00 off)'
  },
  GOLD21: {
    code: 'GOLD21',
    order: 21,
    reward: 'Mystery Reward (chosen by Pouch Supply) 🎁',
    type: 'Amount off order',
    valueType: 'Fixed amount',
    valueAmount: 5.00,
    details: 'Mystery Reward (£5.00 off / surprise gift)'
  },
  GOLD23: {
    code: 'GOLD23',
    order: 23,
    reward: '2 FREE cans 🥫',
    type: 'Amount off order',
    valueType: 'Fixed amount',
    valueAmount: 9.00,
    details: '2 FREE cans reward (£9.00 off)'
  },
  GOLD25: {
    code: 'GOLD25',
    order: 25,
    reward: 'Premium Pouch Supply merchandise 👕',
    type: 'Amount off order',
    valueType: 'Fixed amount',
    valueAmount: 10.00,
    details: 'Premium Merchandise Voucher (£10.00 off)'
  },
  GOLD27: {
    code: 'GOLD27',
    order: 27,
    reward: '20% off your purchase 🎁',
    type: 'Amount off order',
    valueType: 'Percentage',
    valueAmount: 20,
    details: '20% Gold Member Discount'
  },
  GOLD29: {
    code: 'GOLD29',
    order: 29,
    reward: '2 FREE cans 🥫',
    type: 'Amount off order',
    valueType: 'Fixed amount',
    valueAmount: 9.00,
    details: '2 FREE cans reward (£9.00 off)'
  },
  GOLD30: {
    code: 'GOLD30',
    order: 30,
    reward: 'Unlock Platinum Member 🏆',
    type: 'Amount off order',
    valueType: 'Percentage',
    valueAmount: 25,
    details: '25% Platinum Unlock Welcome Discount'
  },
  PLATINUM_ODD: {
    code: 'PLATINUM_ODD',
    order: 31,
    reward: 'Platinum Odd Order Choice Reward 💎',
    type: 'Amount off order',
    valueType: 'Fixed amount',
    valueAmount: 10.00,
    details: 'Platinum VIP Odd Order Reward (£10.00 off / 3 Free Cans voucher)'
  }
};

/**
 * Extracts base code from input code which may contain customer prefixes or hyphens.
 * e.g. "NEH-BRONZE1" -> "BRONZE1", "NEHBRONZE1" -> "BRONZE1", "BRONZE1" -> "BRONZE1"
 */
export function extractBaseMilestoneCode(inputCode: string): string | null {
  const clean = inputCode.trim().toUpperCase().replace(/[\s_]+/g, '-');
  
  // 1. Direct match with definitions
  if (LOYALTY_MILESTONE_DEFINITIONS[clean]) {
    return clean;
  }

  // 2. Handle with hyphen: e.g. "NEH-BRONZE1" -> "BRONZE1", "SCO-PLATINUM_ODD" -> "PLATINUM_ODD"
  if (clean.includes('-')) {
    const parts = clean.split('-');
    const withoutPrefix = parts.slice(1).join('-');
    if (LOYALTY_MILESTONE_DEFINITIONS[withoutPrefix]) {
      return withoutPrefix;
    }
    const lastPart = parts[parts.length - 1];
    if (LOYALTY_MILESTONE_DEFINITIONS[lastPart]) {
      return lastPart;
    }
  }

  // 3. Handle without hyphen: e.g. "NEHBRONZE1" or "SCOGOLD17" (strip 2-4 letter prefix)
  const noHyphen = clean.replace(/[^A-Z0-9]/g, '');
  for (const baseKey of Object.keys(LOYALTY_MILESTONE_DEFINITIONS)) {
    if (noHyphen.endsWith(baseKey)) {
      return baseKey;
    }
  }

  // 4. Dynamic Platinum patterns like PLATINUM31, PLATINUM33, PLATINUM
  if (noHyphen.includes('PLATINUM')) {
    return 'PLATINUM_ODD';
  }

  return null;
}

/**
 * Resolves any promo code (DB discounts, loyalty rewards with customer prefixes, referrals, subscriber perks).
 */
export function resolveDiscountCode(
  rawInputCode: string,
  activeDiscounts: Discount[] = [],
  customers: Customer[] = [],
  loggedInCustomer: Customer | null = null,
  cartItems: CartItem[] = [],
  subtotal: number = 0
): ResolveDiscountResult {
  const code = rawInputCode.trim().toUpperCase();
  if (!code) {
    return { success: false, error: 'Please enter a discount code.' };
  }

  // 1. Check exact match in active database discounts
  const dbMatch = activeDiscounts.find(
    d => d.status === 'Active' && (d.title.toUpperCase() === code || d.id.toUpperCase() === code)
  );
  if (dbMatch) {
    return {
      success: true,
      discount: dbMatch,
      message: `Discount code "${code}" applied: ${dbMatch.details || dbMatch.title}!`
    };
  }

  // 2. Check if DB discount matches after stripping 3-letter customer prefix (e.g. "NEH-SUMMER20" -> "SUMMER20")
  if (code.includes('-') || code.length > 4) {
    const parts = code.split('-');
    const strippedHyphen = parts.length > 1 ? parts.slice(1).join('-') : code.substring(3);
    const dbPrefixMatch = activeDiscounts.find(
      d => d.status === 'Active' && d.title.toUpperCase() === strippedHyphen
    );
    if (dbPrefixMatch) {
      return {
        success: true,
        discount: {
          ...dbPrefixMatch,
          title: code // keep entered code for display
        },
        message: `Discount code "${code}" applied: ${dbPrefixMatch.details || dbPrefixMatch.title}!`
      };
    }
  }

  // 3. Check Loyalty Tier Milestone Coupons (with or without customer prefix like NEH-BRONZE1 or NEHBRONZE1)
  const baseMilestoneKey = extractBaseMilestoneCode(code);
  if (baseMilestoneKey && LOYALTY_MILESTONE_DEFINITIONS[baseMilestoneKey]) {
    const def = LOYALTY_MILESTONE_DEFINITIONS[baseMilestoneKey];
    const customerPrefix = getCustomerPrefix(loggedInCustomer);
    const virtualLoyaltyDiscount: Discount = {
      id: `disc-loyalty-${def.code.toLowerCase()}`,
      title: code,
      status: 'Active',
      method: 'Code',
      eligibility: 'All customers',
      type: def.type,
      valueType: def.valueType,
      valueAmount: def.valueAmount,
      details: def.details,
      used: 0,
      limitOnePerCustomer: false
    };

    return {
      success: true,
      discount: virtualLoyaltyDiscount,
      message: `Loyalty Coupon "${code}" applied: ${def.details}!`
    };
  }

  // 4. Special Subscriber Discounts (SUB10, SUBSCRIBER10, FIRST50)
  if (code === 'SUB10' || code === 'SUBSCRIBER10' || code === 'FIRST50') {
    const subDiscount: Discount = {
      id: 'disc-sub-first50',
      title: code,
      status: 'Active',
      method: 'Code',
      eligibility: 'All customers',
      type: 'Amount off order',
      valueType: 'Percentage',
      valueAmount: 10,
      details: '10% First 50 Subscribers Permanent Discount',
      used: 1,
      limitOnePerCustomer: false
    };
    return {
      success: true,
      discount: subDiscount,
      message: '10% First 50 Subscribers discount applied!'
    };
  }

  // 5. Customer Referral Codes
  const matchingCustomer = customers.find(c => c.referralCode && c.referralCode.toUpperCase() === code);
  if (matchingCustomer) {
    if (loggedInCustomer && loggedInCustomer.id === matchingCustomer.id) {
      return {
        success: false,
        error: 'You cannot use your own referral code.'
      };
    }

    const virtualRefDiscount: Discount = {
      id: `disc-ref-virtual-${matchingCustomer.id}`,
      title: code,
      status: 'Active',
      method: 'Code',
      eligibility: 'All customers',
      type: 'Amount off order',
      valueType: 'Percentage',
      valueAmount: 10,
      details: `10% referral discount courtesy of ${(matchingCustomer.name || 'a friend').split(' ')[0]}`,
      used: 0,
      limitOnePerCustomer: true
    };

    return {
      success: true,
      discount: virtualRefDiscount,
      message: 'Referral code applied! You receive a 10% discount on your order.'
    };
  }

  return {
    success: false,
    error: 'Invalid or expired discount code.'
  };
}
