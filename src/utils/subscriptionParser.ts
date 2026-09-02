import { getPlanSlug } from './planImages';

export interface SubscriptionProductItem {
  name: string;
  variant: string;
  quantity: number;
  image?: string;
  price?: number;
}

export interface ExtractedSubscriptionDetails {
  planName: string;
  planSlug: 'lite' | 'core' | 'pro' | 'ultimate';
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
      const rawName = p.title || p.productTitle || p.name || it.productTitle || it.title || 'Product';
      
      let variant = (it as any).variantName || (it as any).variant || (p as any).concreteVariantName || (p as any).variant || (it as any).strength || (it as any).flavour || (p as any).strength || (p as any).flavour || '';
      
      let name = rawName;
      // If variant is empty, extract from title if formatted like "VELO Freeze Max (14mg)"
      if (!variant || variant === 'Standard') {
        const titleMatch = rawName.match(/^(.*?)\s*\(([^)]+)\)$/);
        if (titleMatch && titleMatch[1] && titleMatch[2] && !titleMatch[2].toLowerCase().includes('qty:')) {
          name = titleMatch[1].trim();
          variant = titleMatch[2].trim();
        } else if (rawName.includes(' - ')) {
          const split = rawName.split(' - ');
          if (split.length > 1) {
            name = split[0].trim();
            variant = split.slice(1).join(' - ').trim();
          }
        }
      }

      if (!variant) variant = 'Standard';

      const quantity = Number(it.quantity || p.quantity || 1);
      const image = it.image || p.image || '';
      const price = Number(it.price || p.price || 0);

      results.push({ name, variant, quantity, image, price });
    });

    if (results.length > 0) return results;
  }

  // 2. Second priority: Parse from subscription productTitle description summary
  // Example formats:
  // "PRO Plan [Bi-Weekly - 10% OFF] - (VELO Freeze Max (14mg) (Qty:5), ZYN Cool Mint (6mg) (Qty:5))"
  // "PRO Plan (10 Cans) - (White Fox Full Charge (Qty:2), Killa Cold Mint (16mg) (Qty:8))"
  // "CORE Plan - (FUMI Spicy Cola (8mg) (Qty:4), VELO Ruby Berry (6mg) (Qty:4))"
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
    // Split by comma outside parentheses so "(14mg)" inside variant does not split
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

      // Extract variant from remaining string e.g. "VELO Freeze Max (14mg)" or "Cuba Black - 43mg"
      let name = cleanPart;
      let variant = 'Standard';

      const varMatch = cleanPart.match(/^(.*?)\s*\(([^)]+)\)$/);
      if (varMatch && varMatch[1] && varMatch[2]) {
        name = varMatch[1].trim();
        variant = varMatch[2].trim();
      } else if (cleanPart.includes(' - ')) {
        const split = cleanPart.split(' - ');
        name = split[0].trim();
        variant = split.slice(1).join(' - ').trim();
      }

      results.push({
        name,
        variant: variant || 'Standard',
        quantity: qty
      });
    });
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

  // 3. Extract selected products with variant names
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
