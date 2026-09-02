import { getPlanSlug, getPlanImage } from './planImages';

export interface SubscriptionProductItem {
  brand?: string;
  vendor?: string;
  name: string; // Product Name (e.g. "5.2 mg", "9 mg", "Freeze Max")
  productTitle?: string;
  variant: string; // Variant Name (e.g. "Watermelon Ice", "Wild Cherry", "Standard")
  variantName?: string;
  quantity: number;
  image?: string;
  price?: number;
  formattedLabel?: string; // e.g. "77 — 5.2 mg — Watermelon Ice (Qty:1)"
}

export interface ExtractedSubscriptionDetails {
  planName: string;
  planSlug: 'lite' | 'core' | 'pro' | 'ultimate';
  planImage: string;
  frequency: string;
  frequencyDiscount: string;
  paymentStatus: string;
  lastPaymentDate: string;
  nextPaymentDate: string;
  status?: string;
  isCancelled?: boolean;
  cancelledAt?: string;
  cancellationReason?: string;
  selectedProducts: SubscriptionProductItem[];
}

const KNOWN_BRANDS = [
  '77', 'SNU', 'CUBA', 'KILLA', 'PABLO', 'VELO', 'WHITE FOX', 'ZYN', 
  'XQS', 'NORDIC SPIRIT', 'CLEW', 'FUMI', 'FEDRS', 'GRANT', 'ICE', 
  'LOOP', 'KURWA', 'DZRT', 'SIBERIA', 'SKRUF', 'DOPE', 'CHAPO', 
  'HIT', 'VOLT', 'FIX', 'STRNG', 'ACE', 'THUNDER'
];

/**
 * Normalizes and formats a single subscription product representation
 */
export function formatSubscriptionItemDisplay(item: {
  brand?: string;
  vendor?: string;
  name?: string;
  productTitle?: string;
  variant?: string;
  variantName?: string;
  quantity?: number;
}): string {
  const brand = (item.brand || item.vendor || '').trim();
  let name = (item.name || item.productTitle || 'Product').trim();
  let variant = (item.variant || item.variantName || 'Standard').trim();
  const qty = Number(item.quantity || 1);

  // If name contains brand at start, remove it so brand is not duplicated
  if (brand && name.toLowerCase().startsWith(brand.toLowerCase())) {
    name = name.substring(brand.length).replace(/^[\s—–-]+/, '').trim();
  }

  // If variant is embedded in name in parentheses e.g. "5.2 mg (Watermelon Ice)"
  const titleVarMatch = name.match(/^(.*?)\s*\(([^)]+)\)$/);
  if (titleVarMatch && titleVarMatch[1] && titleVarMatch[2] && (!variant || variant === 'Standard')) {
    name = titleVarMatch[1].trim();
    variant = titleVarMatch[2].trim();
  }

  const parts: string[] = [];
  if (brand) parts.push(brand);
  if (name) parts.push(name);
  if (variant && variant !== 'Standard') {
    parts.push(variant);
  } else if (brand && (!variant || variant === 'Standard')) {
    parts.push('Standard');
  }

  const mainLabel = parts.join(' — ');
  return `${mainLabel} (Qty:${qty})`;
}

/**
 * Parses products and chosen variant names from subscription objects or summary strings
 */
export function parseSubscriptionProducts(order: any, subItem?: any): SubscriptionProductItem[] {
  const results: SubscriptionProductItem[] = [];

  // 1. First priority: Check if structured items already exist in subItem or order
  const rawItems = 
    subItem?.subscriptionItems || 
    subItem?.items || 
    order?.subscriptionDetails?.items || 
    order?.subscriptionDetails?.selectedProducts || 
    order?.subscriptionItems;

  if (Array.isArray(rawItems) && rawItems.length > 0) {
    rawItems.forEach((it: any) => {
      const p = it.product || it;
      let rawName = p.title || p.productTitle || p.name || it.productTitle || it.title || 'Product';
      let rawBrand = (it.brand || it.vendor || p.vendor || p.brand || '').trim();
      let variant = (it as any).variantName || (it as any).variant || (p as any).concreteVariantName || (p as any).variant || (it as any).strength || (it as any).flavour || (p as any).strength || (p as any).flavour || '';

      // Check if rawName starts with known brand if brand is missing
      if (!rawBrand) {
        for (const kb of KNOWN_BRANDS) {
          if (rawName.toLowerCase().startsWith(kb.toLowerCase())) {
            rawBrand = kb;
            break;
          }
        }
      }

      // If rawName starts with rawBrand, strip brand from name
      let name = rawName;
      if (rawBrand && name.toLowerCase().startsWith(rawBrand.toLowerCase())) {
        name = name.substring(rawBrand.length).replace(/^[\s—–-]+/, '').trim();
      }

      // If variant is empty, check if it's formatted like "5.2 mg (Watermelon Ice)" or "5.2 mg — Watermelon Ice"
      if (!variant || variant === 'Standard') {
        const titleMatch = name.match(/^(.*?)\s*\(([^)]+)\)$/);
        if (titleMatch && titleMatch[1] && titleMatch[2] && !titleMatch[2].toLowerCase().includes('qty:')) {
          name = titleMatch[1].trim();
          variant = titleMatch[2].trim();
        } else if (name.includes(' — ') || name.includes(' - ')) {
          const split = name.split(/\s*(?:—|–|-)\s*/);
          if (split.length > 1) {
            name = split[0].trim();
            variant = split.slice(1).join(' — ').trim();
          }
        }
      }

      if (!variant) variant = 'Standard';

      const quantity = Number(it.quantity || p.quantity || 1);
      const image = it.image || p.image || '';
      const price = Number(it.price || p.price || 0);

      const formattedLabel = formatSubscriptionItemDisplay({
        brand: rawBrand,
        name,
        variant,
        quantity
      });

      results.push({ 
        brand: rawBrand,
        vendor: rawBrand,
        name, 
        productTitle: name,
        variant, 
        variantName: variant,
        quantity, 
        image, 
        price,
        formattedLabel
      });
    });

    if (results.length > 0) return results;
  }

  // 2. Second priority: Parse from subscription productTitle description summary
  // Example formats:
  // "PRO Plan [Bi-Weekly - 10% OFF] - (77 — 5.2 mg — Watermelon Ice (Qty:1), SNU — 9 mg — Wild Cherry (Qty:1))"
  // "PRO Plan [Bi-Weekly - 10% OFF] - (9 mg (Wild Cherry) (Qty:1), 10.9 mg (Freezing Peppermint) (Qty:1))"
  const rawTitle: string = (subItem?.productTitle || order?.items?.[0]?.productTitle || '').trim();
  if (!rawTitle) return results;

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
  } else if (rawTitle.startsWith('(') && rawTitle.endsWith(')')) {
    itemsSummary = rawTitle.slice(1, -1);
  }

  if (itemsSummary) {
    // Split by comma outside parentheses so nested tags do not split
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

    parts.forEach(part => {
      const trimmed = part.trim();
      if (!trimmed) return;

      // Extract quantity e.g. (Qty:5) or x 5 or * 5
      let qty = 1;
      let cleanPart = trimmed;

      const qtyMatch = cleanPart.match(/\(Qty\s*:\s*(\d+)\)/i) || cleanPart.match(/\bx\s*(\d+)\b/i) || cleanPart.match(/\*\s*(\d+)\b/);
      if (qtyMatch) {
        qty = parseInt(qtyMatch[1], 10) || 1;
        cleanPart = cleanPart.replace(/\(Qty\s*:\s*(\d+)\)/i, '').replace(/\bx\s*(\d+)\b/i, '').replace(/\*\s*(\d+)\b/, '').trim();
      }

      let brand = '';
      let name = cleanPart;
      let variant = 'Standard';

      // Check if separated by " — " or " - " (e.g. "77 — 5.2 mg — Watermelon Ice")
      if (cleanPart.includes(' — ') || cleanPart.includes(' – ') || (cleanPart.includes(' - ') && !cleanPart.includes(')-('))) {
        const segments = cleanPart.split(/\s*(?:—|–|-)\s*/);
        if (segments.length >= 3) {
          brand = segments[0].trim();
          name = segments[1].trim();
          variant = segments.slice(2).join(' — ').trim();
        } else if (segments.length === 2) {
          // Check if first segment is known brand
          const firstSeg = segments[0].trim();
          const isBrand = KNOWN_BRANDS.some(kb => kb.toLowerCase() === firstSeg.toLowerCase());
          if (isBrand) {
            brand = firstSeg;
            name = segments[1].trim();
            // Check if name has variant in parentheses e.g. "5.2 mg (Watermelon Ice)"
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
        // Formats like "9 mg (Wild Cherry)" or "77 5.2 mg (Watermelon Ice)"
        const varMatch = cleanPart.match(/^(.*?)\s*\(([^)]+)\)$/);
        if (varMatch && varMatch[1] && varMatch[2]) {
          name = varMatch[1].trim();
          variant = varMatch[2].trim();
        }

        // Check if name starts with known brand
        for (const kb of KNOWN_BRANDS) {
          if (name.toLowerCase().startsWith(kb.toLowerCase())) {
            brand = kb;
            name = name.substring(kb.length).replace(/^[\s—–-]+/, '').trim();
            break;
          }
        }
      }

      const formattedLabel = formatSubscriptionItemDisplay({
        brand,
        name,
        variant,
        quantity: qty
      });

      results.push({
        brand: brand || undefined,
        vendor: brand || undefined,
        name: name || 'Product',
        productTitle: name || 'Product',
        variant: variant || 'Standard',
        variantName: variant || 'Standard',
        quantity: qty,
        formattedLabel
      });
    });

    if (results.length > 0) return results;
  }

  return results;
}

/**
 * Extracts complete, normalized subscription metadata for any order
 */
export function extractSubscriptionDetails(order: any): ExtractedSubscriptionDetails {
  const details: any = order.subscriptionDetails ? { ...order.subscriptionDetails } : {};

  const subItem = order.items?.find((i: any) => 
    i.isSubscription || 
    i.vendor === 'Subscription Pack' || 
    (i.productTitle && (i.productTitle.toLowerCase().includes('subscription') || i.productTitle.toLowerCase().includes('plan') || i.productTitle.toLowerCase().includes('pack'))) ||
    (i.productId && (i.productId.startsWith('sub-pack') || i.productId.includes('sub-pack')))
  ) as any;

  // 1. Resolve plan name and slug accurately
  const rawPlanString = details.planName || subItem?.subscriptionPlan || subItem?.productTitle || order.subPlan || order.subscriptionPlan || '';
  const planSlug = getPlanSlug(rawPlanString);
  
  let planName = 'PRO Plan';
  if (planSlug === 'ultimate') planName = 'ULTIMATE Plan';
  else if (planSlug === 'pro') planName = 'PRO Plan';
  else if (planSlug === 'core') planName = 'CORE Plan';
  else if (planSlug === 'lite') planName = 'LITE Plan';

  const planImage = getPlanImage(planName, details.planImage || subItem?.image || (order.items && order.items[0]?.image));

  // 2. Resolve frequency and discount
  const title = (subItem?.productTitle || '').toLowerCase();
  let frequency = details.frequency || subItem?.subscriptionFrequency || order.subscriptionFrequency || '';
  let frequencyDiscount = details.frequencyDiscount || subItem?.frequencyDiscount || order.frequencyDiscount || '';

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

  const baseDate = order.createdAt ? new Date(order.createdAt) : new Date();
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

  // 3. Extract selected products with brand, name, variant, and quantities
  const selectedProducts = parseSubscriptionProducts(order, subItem);

  const isCancelled = 
    Boolean(order.subscriptionCancelled) || 
    details.status === 'Cancelled' || 
    Boolean(details.isCancelled) ||
    (Array.isArray(order.tags) && order.tags.some((t: any) => typeof t === 'string' && t.toLowerCase().includes('subscription cancelled')));

  return {
    ...details,
    planName,
    planSlug,
    planImage,
    frequency,
    frequencyDiscount,
    paymentStatus: order.paymentStatus || details.paymentStatus || 'Paid',
    lastPaymentDate: details.lastPaymentDate || baseDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    nextPaymentDate: details.nextPaymentDate || nextDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    selectedProducts,
    status: isCancelled ? 'Cancelled' : (details.status || 'Active'),
    isCancelled,
    cancelledAt: order.subscriptionCancelledAt || details.cancelledAt,
    cancellationReason: order.subscriptionCancellationReason || details.cancellationReason || (isCancelled ? 'Customer requested cancellation' : undefined)
  };
}
