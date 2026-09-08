import { fetchResource, saveResource, fetchStoreSetting, saveStoreSetting } from '../../serverDb';
import {
  createRoyalMailOrders,
  cancelOrder as cancelRoyalMailOrder,
  getOrderByReference,
  getRoyalMailLabel,
  markRoyalMailOrderDispatched,
  RoyalMailError,
  CreateRoyalMailOrderRequest
} from '../../src/lib/royalMail';

/**
 * Royal Mail Click & Drop integration — LIVE ONLY.
 *
 * There is no simulated mode and no fallback label generation. Every shipment,
 * tracking number and label in this module comes from the Royal Mail API. If
 * the API is unreachable, unauthorised, or rejects the order, the call fails
 * loudly rather than inventing a shipment: a fabricated tracking number sends
 * the customer a dispatch email for a parcel that does not exist, and a
 * hand-drawn label is not scannable by Royal Mail.
 */

export interface RoyalMailSettings {
  apiKey: string;
  integrationName: string;
  enabled: boolean;
  /**
   * When true, a Click & Drop order is created the instant a payment succeeds.
   * Off by default: a shipment should be registered when the order is actually
   * packed, not when it is paid for.
   */
  autoCreateShipmentOnPayment: boolean;
  defaultServiceCode: string; // Royal Mail service code, e.g. 'TPN', 'TPS', 'SD1'
  defaultPackageType: string; // 'Parcel', 'LargeLetter', 'Letter'
  defaultWeightGrams: number;
  senderAddress: {
    companyName: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    postcode: string;
    countryCode: string;
    contactEmail: string;
    contactPhone: string;
  };
}

/**
 * Defaults deliberately leave the trading identity blank. A placeholder sender
 * address would be printed on real labels and used as the returns address, so
 * it must be filled in from the admin Royal Mail settings before shipping.
 */
export const DEFAULT_ROYAL_MAIL_SETTINGS: RoyalMailSettings = {
  apiKey: process.env.RM_API_KEY || process.env.ROYAL_MAIL_API_KEY || '',
  integrationName: 'Pouch-Supply',
  enabled: true,
  autoCreateShipmentOnPayment:
    String(process.env.ROYAL_MAIL_AUTO_DISPATCH || '').toLowerCase() === 'true',
  defaultServiceCode: 'TPN',
  defaultPackageType: 'Parcel',
  defaultWeightGrams: 350,
  senderAddress: {
    companyName: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    postcode: '',
    countryCode: 'GB',
    contactEmail: process.env.ADMIN_NOTIFICATION_EMAIL || '',
    contactPhone: ''
  }
};

export interface AddressPayload {
  fullName: string;
  companyName?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  county?: string;
  postcode: string;
  countryCode?: string;
  email?: string;
  phone?: string;
}

export interface PackageItemPayload {
  name: string;
  quantity: number;
  unitValue: number;
  unitWeightGrams?: number;
  sku?: string;
}

export interface ShippingRateOption {
  serviceCode: string;
  serviceName: string;
  estimatedDelivery: string;
  price: number;
  currency: string;
  tracked: boolean;
  signatureRequired: boolean;
}

// 1. Fetch & Save Royal Mail Settings
export async function getRoyalMailSettings(): Promise<RoyalMailSettings> {
  const envKey = process.env.RM_API_KEY || process.env.ROYAL_MAIL_API_KEY || '';
  try {
    let stored: any = await fetchStoreSetting('royalmail_settings');
    if (!stored || (typeof stored === 'object' && Object.keys(stored).length === 0)) {
      const legacy: any = await fetchResource('royalmail_settings');
      if (legacy && Array.isArray(legacy) && legacy.length > 0) {
        stored = legacy[0];
      }
    }

    if (stored && typeof stored === 'object') {
      const item = Array.isArray(stored) ? stored[0] : stored;
      return {
        ...DEFAULT_ROYAL_MAIL_SETTINGS,
        ...item,
        apiKey: item.apiKey && item.apiKey.trim().length > 0 ? item.apiKey : (envKey || DEFAULT_ROYAL_MAIL_SETTINGS.apiKey),
        senderAddress: {
          ...DEFAULT_ROYAL_MAIL_SETTINGS.senderAddress,
          ...(item.senderAddress || {})
        }
      };
    }
  } catch (err) {
    console.warn('[RoyalMailService] Error reading settings, using defaults:', err);
  }
  return {
    ...DEFAULT_ROYAL_MAIL_SETTINGS,
    apiKey: envKey || DEFAULT_ROYAL_MAIL_SETTINGS.apiKey
  };
}

export async function saveRoyalMailSettings(settings: Partial<RoyalMailSettings>): Promise<RoyalMailSettings> {
  const current = await getRoyalMailSettings();
  const apiKeyVal = (settings.apiKey !== undefined ? settings.apiKey : current.apiKey) || '';
  const updated: RoyalMailSettings = {
    ...current,
    ...settings,
    apiKey: apiKeyVal,
    senderAddress: {
      ...current.senderAddress,
      ...(settings.senderAddress || {})
    }
  };

  if (apiKeyVal) {
    process.env.RM_API_KEY = apiKeyVal;
    process.env.ROYAL_MAIL_API_KEY = apiKeyVal;
  }

  await saveStoreSetting('royalmail_settings', updated);
  await saveResource('royalmail_settings', [updated]);
  return updated;
}

/**
 * Resolves the live API key, or throws. Every outbound call goes through this
 * so a missing key can never silently degrade into a simulated shipment.
 */
export async function requireApiKey(settings?: RoyalMailSettings): Promise<string> {
  const s = settings || (await getRoyalMailSettings());
  const apiKey = (s.apiKey || process.env.RM_API_KEY || process.env.ROYAL_MAIL_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      'Royal Mail Click & Drop API key is not configured. Add your API Authorization key in ' +
        'Admin → Settings → Royal Mail (or set ROYAL_MAIL_API_KEY) before creating shipments.'
    );
  }
  return apiKey;
}

/**
 * Validates the sender identity that will be printed on the label and used as
 * the returns address. Click & Drop requires a real trading name.
 */
function requireSender(settings: RoyalMailSettings) {
  const sender = settings.senderAddress || ({} as RoyalMailSettings['senderAddress']);
  const tradingName = (sender.companyName || '').trim();
  if (!tradingName) {
    throw new Error(
      'Royal Mail sender trading name is not configured. Set your company name and address in ' +
        'Admin → Settings → Royal Mail before creating shipments.'
    );
  }
  return sender;
}

// 2. Validate Address
export function validateAddress(address: Partial<AddressPayload>): { valid: boolean; errors: string[]; parsed?: AddressPayload } {
  const errors: string[] = [];
  if (!address.fullName || address.fullName.trim().length < 2) {
    errors.push('Full recipient name is required');
  }
  if (!address.addressLine1 || address.addressLine1.trim().length < 3) {
    errors.push('Address line 1 is required');
  }
  if (!address.city || address.city.trim().length < 2) {
    errors.push('City / Town is required');
  }
  if (!address.postcode || address.postcode.trim().length < 3) {
    errors.push('Postcode / Postal Code is required');
  } else {
    // Basic UK Postcode formatting & check if country is GB
    const country = normalizeCountryCode(address.countryCode);
    if (country === 'GB') {
      const ukPostcodeRegex = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
      if (!ukPostcodeRegex.test(address.postcode.trim())) {
        errors.push('Postcode format does not appear to be a valid UK postcode (e.g. EC1A 1BB or SW1A 1AA)');
      }
    }
  }

  const parsed: AddressPayload = {
    fullName: (address.fullName || '').trim(),
    companyName: (address.companyName || '').trim(),
    addressLine1: (address.addressLine1 || '').trim(),
    addressLine2: (address.addressLine2 || '').trim(),
    city: (address.city || '').trim(),
    county: (address.county || '').trim(),
    postcode: (address.postcode || '').trim().toUpperCase(),
    countryCode: normalizeCountryCode(address.countryCode),
    email: (address.email || '').trim(),
    phone: (address.phone || '').trim()
  };

  return {
    valid: errors.length === 0,
    errors,
    parsed
  };
}

/**
 * 3. The store's own delivery price card.
 *
 * These are the prices YOU charge the customer at checkout and the service
 * codes you offer. Click & Drop has no public rating API — what you are billed
 * by Royal Mail comes from your account's contracted rates, not from here.
 *
 * The service codes, however, are not ours to choose. They must be real Royal
 * Mail codes AND present on your OBA / Royal Mail Tracked contract, or Click &
 * Drop rejects the shipment with error 31. The domestic Tracked codes are TPN
 * (Tracked 24) and TPS (Tracked 48) — note there is no "TPS24"; that value was
 * invented here and matched nothing. Letterboxable variants are TRN and TRS.
 * Confirm what your own account exposes before adding a code to this list.
 */
export function getShippingRates(weightGrams: number = 350, countryCode: string = 'GB'): ShippingRateOption[] {
  const isUK = normalizeCountryCode(countryCode) === 'GB';

  if (isUK) {
    return [
      {
        serviceCode: 'TPN',
        serviceName: 'Royal Mail Tracked 24®',
        estimatedDelivery: 'Next Working Day',
        price: 4.95,
        currency: 'GBP',
        tracked: true,
        signatureRequired: false
      },
      {
        serviceCode: 'TPS',
        serviceName: 'Royal Mail Tracked 48®',
        estimatedDelivery: '2-3 Working Days',
        price: 3.85,
        currency: 'GBP',
        tracked: true,
        signatureRequired: false
      },
      {
        serviceCode: 'SD1',
        serviceName: 'Royal Mail Special Delivery Guaranteed by 1pm®',
        estimatedDelivery: 'Next Day by 1:00 PM (Guaranteed)',
        price: 8.95,
        currency: 'GBP',
        tracked: true,
        signatureRequired: true
      },
      {
        serviceCode: 'CRL2',
        serviceName: 'Royal Mail 24 Business Parcel (Tracked Standard)',
        estimatedDelivery: '1-2 Working Days',
        price: 4.25,
        currency: 'GBP',
        tracked: true,
        signatureRequired: false
      }
    ];
  }

  return [
    {
      serviceCode: 'MP1',
      serviceName: 'Royal Mail International Tracked',
      estimatedDelivery: '3-5 Working Days (Europe) / 5-7 Days (Worldwide)',
      price: 12.50,
      currency: 'GBP',
      tracked: true,
      signatureRequired: false
    },
    {
      serviceCode: 'MP2',
      serviceName: 'Royal Mail International Tracked & Signed',
      estimatedDelivery: '3-5 Working Days (Europe) / 5-7 Days (Worldwide)',
      price: 14.95,
      currency: 'GBP',
      tracked: true,
      signatureRequired: true
    }
  ];
}

/**
 * Royal Mail expects an ISO country code. Checkout stores a display name
 * ("United Kingdom"), which would otherwise reach the API verbatim.
 */
export function normalizeCountryCode(value?: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return 'GB';
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase() === 'UK' ? 'GB' : raw.toUpperCase();
  const mapped = COUNTRY_TOKENS[raw.toLowerCase()];
  return mapped || raw.toUpperCase();
}

const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

const COUNTRY_TOKENS: Record<string, string> = {
  'united kingdom': 'GB',
  'great britain': 'GB',
  uk: 'GB',
  gb: 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  ireland: 'IE',
  'republic of ireland': 'IE'
};

/**
 * Recovers a postable address from the single-line destination string that
 * checkout writes ("39 Tonks Drive, telford, tf4 2tq, United Kingdom").
 *
 * The shopper does enter the town and postcode separately; only the joined
 * string survives on older orders, so the parts are read back out of it rather
 * than reported as missing. Nothing is invented: a segment that cannot be
 * identified is left empty and validation still rejects the order.
 */
export function parseAddressString(raw: string, fallbackName = ''): Partial<AddressPayload> {
  const text = String(raw || '').trim();
  if (!text) return { fullName: fallbackName };

  let segments = text
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // Checkout seeded its address line from a previously saved full address and
  // then appended town/postcode/country again, so the tail can repeat verbatim.
  // Consecutive duplicates are collapsed before anything is read positionally.
  const deduped: string[] = [];
  for (const seg of segments) {
    if (!deduped.some(existing => existing.toLowerCase() === seg.toLowerCase())) {
      deduped.push(seg);
    }
  }
  segments = deduped;

  let countryCode = '';
  let postcode = '';
  let city = '';

  // Country: only ever the trailing segment, and only when it is a country name.
  if (segments.length > 1) {
    const last = segments[segments.length - 1].toLowerCase();
    if (COUNTRY_TOKENS[last]) {
      countryCode = COUNTRY_TOKENS[last];
      segments.pop();
    }
  }

  // Postcode: taken from wherever it appears, since some addresses put it on
  // the same segment as the town ("London EC1A 1BB").
  for (let i = segments.length - 1; i >= 0; i--) {
    const match = segments[i].match(UK_POSTCODE_RE);
    if (!match) continue;
    postcode = `${match[1]} ${match[2]}`.toUpperCase();
    const remainder = segments[i].replace(match[0], '').trim().replace(/^[,\s-]+|[,\s-]+$/g, '');
    if (remainder) {
      segments[i] = remainder;
    } else {
      segments.splice(i, 1);
    }
    break;
  }

  // Town: the last segment left once country and postcode are out of the way.
  // A single remaining segment is the street, not the town.
  if (segments.length > 1) {
    city = segments.pop() as string;
  }

  return {
    fullName: fallbackName,
    addressLine1: segments[0] || '',
    addressLine2: segments.slice(1).join(', '),
    city,
    postcode,
    countryCode: countryCode || 'GB'
  };
}

/**
 * Resolves the recipient address from a stored order.
 *
 * Returns the parsed address plus any validation errors. Nothing is defaulted:
 * a missing city or postcode is reported, never replaced with a placeholder,
 * because a placeholder would ship a real parcel to an address nobody lives at.
 */
function resolveRecipientFromOrder(order: any): { valid: boolean; errors: string[]; recipient: AddressPayload } {
  // A structured address is preferred wherever checkout recorded one; the flat
  // destination string is the fallback for orders placed before it did.
  const structured =
    (order.shippingAddress && typeof order.shippingAddress === 'object' ? order.shippingAddress : null) ||
    (order.data?.shippingAddress && typeof order.data.shippingAddress === 'object' ? order.data.shippingAddress : null) ||
    (order.data?.address && typeof order.data.address === 'object' ? order.data.address : null) ||
    (order.address && typeof order.address === 'object' ? order.address : null);

  const rawAddr = structured || order.data?.address || order.address || order.shippingAddress || order.destination || '';
  let addressObj: Partial<AddressPayload> = {};

  if (rawAddr && typeof rawAddr === 'object') {
    addressObj = {
      fullName: rawAddr.fullName || rawAddr.name || order.customerName,
      companyName: rawAddr.companyName || '',
      addressLine1: rawAddr.addressLine1 || rawAddr.street || rawAddr.line1 || '',
      addressLine2: rawAddr.addressLine2 || rawAddr.line2 || '',
      city: rawAddr.city || rawAddr.town || '',
      county: rawAddr.county || rawAddr.state || '',
      postcode: rawAddr.postcode || rawAddr.zip || '',
      countryCode: rawAddr.countryCode || rawAddr.country || 'GB',
      email: order.customerEmail,
      phone: rawAddr.phone || order.customerPhone || ''
    };
  } else {
    // The town and postcode the shopper typed are still present in the joined
    // destination string, so they are read back out of it instead of being
    // reported as missing. Anything genuinely absent stays empty and is caught
    // by validateAddress below.
    const parsedFromString = parseAddressString(
      typeof rawAddr === 'string' ? rawAddr : '',
      order.customerName || ''
    );
    addressObj = {
      ...parsedFromString,
      email: order.customerEmail,
      phone: order.customerPhone || ''
    };
  }

  const validation = validateAddress(addressObj);
  return {
    valid: validation.valid,
    errors: validation.errors,
    recipient: validation.parsed as AddressPayload
  };
}

/**
 * Tests whether Royal Mail will accept a service code on THIS account.
 *
 * Which codes are valid is not a property of the API — it is a property of the
 * account's OBA / Royal Mail Tracked contract, and there is no endpoint that
 * lists them. The only authoritative check is to offer Click & Drop an order and
 * see whether it takes it, so that is what this does: it submits one throwaway
 * order and immediately deletes it again when it is accepted.
 *
 * Nothing is ever labelled, manifested or dispatched, so no postage is bought.
 * A code that is rejected creates nothing in the first place.
 */
export async function testServiceCode(serviceCode: string): Promise<{
  serviceCode: string;
  accepted: boolean;
  message: string;
  cleanedUp: boolean;
}> {
  const code = String(serviceCode || '').trim().toUpperCase();
  if (!code) {
    return { serviceCode: code, accepted: false, message: 'No service code supplied.', cleanedUp: false };
  }

  const settings = await getRoyalMailSettings();
  const apiKey = await requireApiKey(settings);
  const sender = requireSender(settings);

  const reference = `SVC-TEST-${Date.now().toString().slice(-8)}`;
  const payload: CreateRoyalMailOrderRequest = {
    orderReference: reference,
    isRecipientABusiness: false,
    recipient: {
      address: {
        fullName: 'Service Code Test',
        addressLine1: sender.addressLine1 || '1 Test Street',
        city: sender.city || 'London',
        postcode: sender.postcode || 'EC1A 1BB',
        countryCode: 'GB'
      }
    },
    sender: { tradingName: sender.companyName.trim() },
    subtotal: 1,
    shippingCostCharged: 0,
    total: 1,
    currencyCode: 'GBP',
    orderDate: new Date().toISOString(),
    packages: [
      {
        weightInGrams: settings.defaultWeightGrams || 350,
        packageFormatIdentifier: settings.defaultPackageType || 'Parcel',
        contents: [{ name: 'Service code test', quantity: 1, unitValue: 1, unitWeightInGrams: 100 }]
      }
    ],
    postageDetails: { serviceCode: code, sendNotificationsTo: 'none' }
  };

  let result: any;
  try {
    result = await createRoyalMailOrders([payload], apiKey);
  } catch (err: any) {
    return { serviceCode: code, accepted: false, message: err?.message || String(err), cleanedUp: false };
  }

  const failed = result?.failedOrders?.[0];
  if (failed) {
    const errors = Array.isArray(failed.errors) ? failed.errors : failed.errors ? [failed.errors] : [];
    const message = errors.map((e: any) => e?.errorMessage || e?.message || JSON.stringify(e)).join(' | ');
    return { serviceCode: code, accepted: false, message: message || 'Rejected by Royal Mail.', cleanedUp: false };
  }

  const identifier = result?.createdOrders?.[0]?.orderIdentifier;
  let cleanedUp = false;
  if (identifier) {
    try {
      await cancelRoyalMailOrder(String(identifier), apiKey);
      cleanedUp = true;
    } catch (delErr: any) {
      console.warn(
        `[RoyalMailService] Test order ${identifier} for ${code} could not be removed automatically:`,
        delErr?.message
      );
    }
  }

  return {
    serviceCode: code,
    accepted: true,
    message: cleanedUp
      ? `Royal Mail accepts "${code}" on this account.`
      : `Royal Mail accepts "${code}", but the throwaway test order (${identifier}) is still in Click & Drop and should be deleted manually.`,
    cleanedUp
  };
}

export interface CreateShipmentResult {
  success: boolean;
  trackingNumber: string | null;
  royalMailOrderId: string;
  carrier: string;
  serviceName: string;
  serviceCode: string;
  labelUrl: string;
  message: string;
  order: any;
}

/**
 * 4. Create a live Click & Drop shipment for a store order.
 *
 * Throws on any failure — a missing API key, an unpostable address, or a
 * rejection from Royal Mail. The order is only moved to Shipped once Royal Mail
 * has actually issued a tracking number; until then it sits in Processing with
 * the Click & Drop identifier recorded, so the customer never receives a
 * dispatch email containing a tracking number that does not exist.
 */
export async function createRoyalMailShipment(orderId: string, options: {
  serviceCode?: string;
  packageType?: string;
  weightGrams?: number;
} = {}): Promise<CreateShipmentResult> {
  const settings = await getRoyalMailSettings();
  const apiKey = await requireApiKey(settings);
  const sender = requireSender(settings);

  // Fetch order from DB
  const orders: any[] = (await fetchResource('orders')) || [];
  let order = orders.find((o: any) => String(o.id) === String(orderId));

  if (!order) {
    try {
      const { prisma } = await import('../../src/lib/prisma');
      order = await prisma.order.findUnique({ where: { id: orderId } });
    } catch (_e) {}
  }

  if (!order) {
    throw new Error(`Order #${orderId} not found in database.`);
  }

  const { valid, errors, recipient } = resolveRecipientFromOrder(order);
  if (!valid) {
    throw new Error(
      `Order #${orderId} cannot be shipped — the delivery address is incomplete: ${errors.join('; ')}. ` +
        `Edit the order's shipping address before creating a Royal Mail shipment.`
    );
  }

  const serviceCode = options.serviceCode || settings.defaultServiceCode || 'TPN';
  const rates = getShippingRates(options.weightGrams || settings.defaultWeightGrams, recipient.countryCode);
  const selectedRate = rates.find(r => r.serviceCode === serviceCode);
  const serviceName = selectedRate?.serviceName || `Royal Mail (${serviceCode})`;

  console.log(`[RoyalMailService] Creating live Click & Drop order for #${orderId} via ${serviceCode}`);

  const addressObj: any = {
    fullName: recipient.fullName,
    addressLine1: recipient.addressLine1,
    city: recipient.city,
    postcode: recipient.postcode,
    countryCode: recipient.countryCode || 'GB'
  };
  if (recipient.companyName?.trim()) addressObj.companyName = recipient.companyName.trim();
  if (recipient.addressLine2?.trim()) addressObj.addressLine2 = recipient.addressLine2.trim();
  if (recipient.county?.trim()) addressObj.county = recipient.county.trim();

  const recipientObj: any = { address: addressObj };
  if (recipient.email) recipientObj.emailAddress = recipient.email.trim();
  if (recipient.phone?.trim()) recipientObj.phoneNumber = recipient.phone.trim();

  const senderObj: any = { tradingName: sender.companyName.trim() };
  if (sender.contactPhone?.trim()) senderObj.phoneNumber = sender.contactPhone.trim();
  if (sender.contactEmail?.trim()) senderObj.emailAddress = sender.contactEmail.trim();

  const totalVal = Number(order.total) || 0;
  const shippingVal = Number(order.shippingCost ?? order.deliveryCost ?? 0);
  const subtotalVal = Number(order.subtotal) || Math.max(0, totalVal - shippingVal);

  const payload: CreateRoyalMailOrderRequest = {
    orderReference: String(order.id),
    isRecipientABusiness: Boolean(recipient.companyName?.trim()),
    recipient: recipientObj,
    sender: senderObj,
    subtotal: Math.round(subtotalVal * 100) / 100,
    shippingCostCharged: Math.round(shippingVal * 100) / 100,
    total: Math.round(totalVal * 100) / 100,
    currencyCode: 'GBP',
    orderDate: order.createdAt || new Date().toISOString(),
    packages: [
      {
        weightInGrams: options.weightGrams || settings.defaultWeightGrams || 350,
        packageFormatIdentifier: options.packageType || settings.defaultPackageType || 'Parcel',
        contents: Array.isArray(order.items) && order.items.length > 0
          ? order.items.map((it: any) => ({
              name: it.productTitle || it.title || 'Pouch Supply Item',
              SKU: it.sku || undefined,
              quantity: Number(it.quantity) || 1,
              unitValue: Number(it.price) || 0,
              unitWeightInGrams: Number(it.weightGrams) || 100
            }))
          : [
              {
                name: 'Pouch Supply Package',
                quantity: 1,
                unitValue: totalVal,
                unitWeightInGrams: options.weightGrams || settings.defaultWeightGrams || 350
              }
            ]
      }
    ],
    postageDetails: {
      serviceCode,
      sendNotificationsTo: recipientObj.emailAddress ? 'recipient' : 'none',
      receiveEmailNotification: Boolean(recipientObj.emailAddress),
      receiveSmsNotification: Boolean(recipientObj.phoneNumber)
    }
  };

  // Any failure here propagates. There is no simulated fallback.
  const result = await createRoyalMailOrders([payload], apiKey);

  if (result?.failedOrders && result.failedOrders.length > 0) {
    const errMsgs: string[] = [];
    let unknownServiceCode = false;

    result.failedOrders.forEach((f: any) => {
      const errors = Array.isArray(f.errors) ? f.errors : f.errors ? [f.errors] : [];
      errors.forEach((e: any) => {
        // Error 31 is the one operators actually hit: the code is either not a
        // Royal Mail code at all, or not on this account's contract. Saying so
        // beats echoing the raw JSON back into the dashboard.
        if (Number(e?.errorCode) === 31) unknownServiceCode = true;
        errMsgs.push(e?.errorMessage || e?.message || e?.code || JSON.stringify(e));
      });
    });

    let detail = errMsgs.join(' | ') || 'unknown error';
    if (unknownServiceCode) {
      detail +=
        ` — "${serviceCode}" is not a service Royal Mail will accept for this account. ` +
        'The domestic Tracked codes are TPN (Tracked 24) and TPS (Tracked 48); ' +
        'TRN and TRS are the letterboxable variants. Check which services are on ' +
        'your contract under Click & Drop > Settings > Shipping services, then set ' +
        'the code in Admin > Settings > Royal Mail.';
    }

    throw new Error(`Royal Mail rejected the shipment for order #${orderId}: ${detail}`);
  }

  const createdOrder = result?.createdOrders?.[0];
  if (!createdOrder?.orderIdentifier) {
    throw new Error(
      `Royal Mail did not return a Click & Drop order identifier for #${orderId}. The shipment was not created.`
    );
  }

  const royalMailOrderId = String(createdOrder.orderIdentifier);
  let trackingNumber: string | null =
    createdOrder.trackingNumber || createdOrder.packages?.[0]?.trackingNumber || null;

  // Click & Drop allocates the tracking number when the label is generated, so
  // it is often absent from the create response. Re-read the order once.
  if (!trackingNumber) {
    try {
      const detail: any = await getOrderByReference(royalMailOrderId, apiKey);
      trackingNumber = detail?.trackingNumber || detail?.packages?.[0]?.trackingNumber || null;
    } catch (lookupErr: any) {
      console.warn(`[RoyalMailService] Tracking lookup for #${orderId} deferred:`, lookupErr?.message);
    }
  }

  const carrierName = serviceName;
  const labelUrl = `/api/royalmail/label/${encodeURIComponent(royalMailOrderId)}/pdf`;

  // Only claim the parcel is shipped once Royal Mail has issued tracking.
  const nextFulfillment = trackingNumber ? 'Shipped' : 'Unfulfilled';

  const shippedOrder = {
    ...order,
    fulfillmentStatus: nextFulfillment,
    trackingNumber: trackingNumber,
    trackingId: trackingNumber,
    carrier: carrierName,
    data: {
      ...(order.data || {}),
      royalMail: {
        royalMailOrderId,
        trackingNumber,
        serviceCode,
        serviceName,
        carrier: carrierName,
        labelUrl,
        createdAt: new Date().toISOString(),
        shippedAt: trackingNumber ? new Date().toISOString() : null,
        addressValidation: { valid, errors }
      }
    }
  };

  // Persist through saveSingleOrder so the dispatch email and the Klaviyo
  // "shipped" event are emitted by the single order-notification funnel,
  // exactly once, and only on a real Unfulfilled -> Shipped transition.
  let updatedOrder = shippedOrder;
  try {
    const { saveSingleOrder } = await import('../routes/orders');
    updatedOrder = await saveSingleOrder(shippedOrder);
  } catch (saveErr: any) {
    console.error('[RoyalMailService] Order save error, falling back to direct store write:', saveErr?.message);
    try {
      const currentOrders: any[] = (await fetchResource('orders')) || [];
      const idx = currentOrders.findIndex((o: any) => String(o.id) === String(orderId));
      if (idx !== -1) {
        currentOrders[idx] = shippedOrder;
      } else {
        currentOrders.unshift(shippedOrder);
      }
      await saveResource('orders', currentOrders);
    } catch (resourceErr) {
      console.error('[RoyalMailService] StoreResource save error:', resourceErr);
    }
  }

  return {
    success: true,
    trackingNumber,
    royalMailOrderId,
    carrier: carrierName,
    serviceName,
    serviceCode,
    labelUrl,
    message: trackingNumber
      ? `Royal Mail shipment created. Tracking ${trackingNumber}.`
      : `Royal Mail order ${royalMailOrderId} created. Tracking is allocated when the label is generated — print the label, then sync the order.`,
    order: updatedOrder
  };
}

/**
 * 5. Mark a Click & Drop order as despatched with Royal Mail.
 */
export async function dispatchRoyalMailShipment(orderId: string): Promise<{ success: boolean; message: string; order: any }> {
  const apiKey = await requireApiKey();

  const orders: any[] = (await fetchResource('orders')) || [];
  const order = orders.find((o: any) => String(o.id) === String(orderId));
  if (!order) {
    throw new Error(`Order #${orderId} not found.`);
  }

  const royalMailOrderId = order.data?.royalMail?.royalMailOrderId;
  if (!royalMailOrderId) {
    throw new Error(
      `Order #${orderId} has no Royal Mail Click & Drop shipment. Create the shipment before marking it despatched.`
    );
  }

  await markRoyalMailOrderDispatched(Number(royalMailOrderId) || String(royalMailOrderId), apiKey);

  // Pull the tracking number now that the order is manifested.
  let trackingNumber = order.trackingNumber || order.trackingId || null;
  try {
    const detail: any = await getOrderByReference(String(royalMailOrderId), apiKey);
    trackingNumber = detail?.trackingNumber || detail?.packages?.[0]?.trackingNumber || trackingNumber;
  } catch (_e) {}

  const { saveSingleOrder } = await import('../routes/orders');
  const updatedOrder = await saveSingleOrder({
    ...order,
    fulfillmentStatus: 'Shipped',
    trackingNumber,
    trackingId: trackingNumber,
    data: {
      ...(order.data || {}),
      royalMail: {
        ...(order.data?.royalMail || {}),
        trackingNumber,
        status: 'despatched',
        shippedAt: new Date().toISOString()
      }
    }
  });

  return {
    success: true,
    message: `Order #${orderId} marked as despatched with Royal Mail.`,
    order: updatedOrder
  };
}

/**
 * 6. Retrieve the official Royal Mail postage label PDF for a store order.
 */
export async function getRoyalMailLabelForOrder(
  orderId: string,
  options: { includeReturnsLabel?: boolean; includeCN?: boolean } = {}
): Promise<{ pdf: ArrayBuffer; royalMailOrderId: string }> {
  const apiKey = await requireApiKey();

  const orders: any[] = (await fetchResource('orders')) || [];
  const order = orders.find((o: any) => String(o.id) === String(orderId));
  if (!order) {
    throw new Error(`Order #${orderId} not found.`);
  }

  const royalMailOrderId = order.data?.royalMail?.royalMailOrderId;
  if (!royalMailOrderId) {
    throw new Error(
      `Order #${orderId} has no Royal Mail shipment yet. Create the Click & Drop shipment first, then print the label.`
    );
  }

  const pdf = await getRoyalMailLabel(
    Number(royalMailOrderId) || String(royalMailOrderId),
    options,
    apiKey
  );

  return { pdf, royalMailOrderId: String(royalMailOrderId) };
}

// 7. Cancel Shipment
export async function cancelRoyalMailShipment(orderId: string, royalMailOrderId?: string): Promise<{ success: boolean; message: string }> {
  const apiKey = await requireApiKey();

  const orders: any[] = (await fetchResource('orders')) || [];
  const order = orders.find((o: any) => String(o.id) === String(orderId));
  const ref = royalMailOrderId || order?.data?.royalMail?.royalMailOrderId;

  if (!ref) {
    throw new Error(`Order #${orderId} has no Royal Mail shipment to cancel.`);
  }

  // Propagates on failure: the local record must not say "cancelled" while the
  // shipment is still live in Click & Drop and about to be collected.
  await cancelRoyalMailOrder(String(ref), apiKey);

  if (order) {
    const { saveSingleOrder } = await import('../routes/orders');
    await saveSingleOrder({
      ...order,
      fulfillmentStatus: 'Unfulfilled',
      trackingNumber: null,
      trackingId: null,
      carrier: null,
      data: {
        ...(order.data || {}),
        royalMail: {
          ...(order.data?.royalMail || {}),
          status: 'Cancelled',
          trackingNumber: null,
          cancelledAt: new Date().toISOString()
        }
      }
    });
  }

  return { success: true, message: 'Shipment cancelled in Royal Mail Click & Drop.' };
}

export interface TrackingResult {
  trackingNumber: string | null;
  orderId?: string;
  royalMailOrderId?: string;
  status: string;
  statusDescription: string;
  carrier: string;
  estimatedDelivery: string;
  recipientLocation?: string;
  officialTrackingUrl: string | null;
  isLive: boolean;
  history: Array<{ timestamp: string; location: string; status: string; description: string }>;
}

/**
 * 8. Live tracking lookup against Click & Drop.
 *
 * Reports only what Royal Mail actually says. The previous implementation
 * synthesised a full delivery timeline ("processed through NDC hub",
 * "Delivered & Signed") from the local order status alone, which showed
 * customers scan events that never happened.
 */
export async function getRoyalMailTracking(trackingNumberOrQuery: string): Promise<TrackingResult> {
  const query = (trackingNumberOrQuery || '').trim();
  const apiKey = await requireApiKey();

  // Find the matching store order so we can resolve the Click & Drop identifier.
  let matchedOrder: any = null;
  try {
    const orders: any[] = (await fetchResource('orders')) || [];
    matchedOrder = orders.find((o: any) =>
      String(o.trackingNumber || '').toUpperCase() === query.toUpperCase() ||
      String(o.trackingId || '').toUpperCase() === query.toUpperCase() ||
      String(o.id || '').toUpperCase() === query.toUpperCase() ||
      String(o.data?.royalMail?.trackingNumber || '').toUpperCase() === query.toUpperCase() ||
      String(o.data?.royalMail?.royalMailOrderId || '').toUpperCase() === query.toUpperCase()
    );
  } catch (_e) {}

  const royalMailOrderId = matchedOrder?.data?.royalMail?.royalMailOrderId;
  const lookupRef = royalMailOrderId || (matchedOrder?.id ? String(matchedOrder.id) : query);

  let cdOrder: any = null;
  try {
    cdOrder = await getOrderByReference(String(lookupRef), apiKey);
  } catch (err: any) {
    if (err instanceof RoyalMailError && err.status === 404) {
      throw new Error(
        `Royal Mail has no record of "${query}". Confirm the shipment was created in Click & Drop.`
      );
    }
    throw err;
  }

  const trackingNumber =
    cdOrder?.trackingNumber ||
    cdOrder?.packages?.[0]?.trackingNumber ||
    matchedOrder?.trackingNumber ||
    null;

  const rawStatus = String(cdOrder?.status || cdOrder?.orderStatus || '').trim();
  const statusLower = rawStatus.toLowerCase();

  let displayStatus = rawStatus || 'Awaiting Despatch';
  let statusDescription = 'Royal Mail has the order. No scan events have been recorded yet.';
  let estimatedDelivery = 'Awaiting despatch';

  if (statusLower.includes('deliver')) {
    displayStatus = 'Delivered';
    statusDescription = 'Royal Mail has recorded this item as delivered.';
    estimatedDelivery = 'Delivered';
  } else if (statusLower.includes('despatch') || statusLower.includes('manifest') || statusLower.includes('shipped')) {
    displayStatus = 'In Transit';
    statusDescription = 'Item has been despatched and is moving through the Royal Mail network.';
    estimatedDelivery = 'In transit';
  } else if (statusLower.includes('cancel')) {
    displayStatus = 'Cancelled';
    statusDescription = 'This Click & Drop order has been cancelled.';
    estimatedDelivery = 'Cancelled';
  }

  // Only real, dated events from Click & Drop — no synthesised scan history.
  const history: TrackingResult['history'] = [];
  const pushEvent = (iso: any, status: string, description: string) => {
    if (!iso) return;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return;
    history.push({
      timestamp: `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      location: 'Royal Mail Click & Drop',
      status,
      description
    });
  };

  pushEvent(cdOrder?.shippedOn, 'Despatched', 'Item despatched to Royal Mail.');
  pushEvent(cdOrder?.manifestedOn, 'Manifested', 'Order manifested with Royal Mail.');
  pushEvent(cdOrder?.printedOn, 'Label Printed', 'Postage label generated.');
  pushEvent(cdOrder?.createdOn, 'Order Created', 'Shipment registered in Click & Drop.');

  const rawAddr = matchedOrder?.data?.address || matchedOrder?.destination || '';
  const destinationStr = rawAddr && typeof rawAddr === 'object'
    ? [rawAddr.city, rawAddr.postcode].filter(Boolean).join(', ')
    : String(rawAddr || '');

  return {
    trackingNumber,
    orderId: matchedOrder?.id,
    royalMailOrderId: royalMailOrderId ? String(royalMailOrderId) : undefined,
    status: displayStatus,
    statusDescription,
    carrier: matchedOrder?.carrier || 'Royal Mail',
    estimatedDelivery,
    recipientLocation: destinationStr || undefined,
    officialTrackingUrl: trackingNumber
      ? `https://www.royalmail.com/track-your-item#/tracking-details/${encodeURIComponent(trackingNumber)}`
      : null,
    isLive: true,
    history
  };
}

/**
 * 9. Sync live status for an order from Royal Mail Click & Drop.
 */
export async function syncRoyalMailOrderStatus(orderId: string): Promise<{
  success: boolean;
  order: any;
  message: string;
  clickAndDropStatus?: string;
}> {
  const apiKey = await requireApiKey();

  const orders: any[] = (await fetchResource('orders')) || [];
  const order = orders.find((o: any) => String(o.id) === String(orderId));

  if (!order) {
    throw new Error(`Order #${orderId} not found.`);
  }

  const royalMailOrderId = order.data?.royalMail?.royalMailOrderId;
  if (!royalMailOrderId) {
    throw new Error(`Order #${orderId} has no Royal Mail shipment to sync.`);
  }

  const cdOrder: any = await getOrderByReference(String(royalMailOrderId), apiKey);
  if (!cdOrder) {
    throw new Error(`Royal Mail returned no record for Click & Drop order ${royalMailOrderId}.`);
  }

  const cdStatus = (cdOrder.status || cdOrder.orderStatus || '').toLowerCase();
  const newTrackingNumber =
    cdOrder.trackingNumber ||
    cdOrder.packages?.[0]?.trackingNumber ||
    order.trackingNumber ||
    order.trackingId ||
    null;

  let updatedFulfillment = order.fulfillmentStatus;
  if (cdStatus.includes('deliver')) {
    updatedFulfillment = 'Delivered';
  } else if (cdStatus.includes('despatch') || cdStatus.includes('manifest') || cdStatus.includes('shipped')) {
    // Only advance to Shipped once there is a real tracking number to send.
    updatedFulfillment = newTrackingNumber ? 'Shipped' : order.fulfillmentStatus;
  }

  const syncedOrder = {
    ...order,
    fulfillmentStatus: updatedFulfillment,
    trackingNumber: newTrackingNumber,
    trackingId: newTrackingNumber,
    data: {
      ...(order.data || {}),
      royalMail: {
        ...(order.data?.royalMail || {}),
        status: cdOrder.status || cdOrder.orderStatus,
        trackingNumber: newTrackingNumber,
        syncedAt: new Date().toISOString(),
        clickAndDropDetails: cdOrder
      }
    }
  };

  // Route through saveSingleOrder so a status change that moves the order to
  // Shipped or Delivered notifies the customer through the same funnel as every
  // other status change — once, and only on a real change.
  const { saveSingleOrder } = await import('../routes/orders');
  const updatedOrder = await saveSingleOrder(syncedOrder);

  return {
    success: true,
    order: updatedOrder,
    message: `Synced with Royal Mail Click & Drop. Status: ${cdOrder.status || 'Updated'}`,
    clickAndDropStatus: cdOrder.status || cdOrder.orderStatus
  };
}

/**
 * 10. Official Royal Mail pre-paid returns label PDF.
 *
 * Requested from Royal Mail with `includeReturnsLabel`, so it carries a real
 * returns barcode. There is no locally generated substitute — a hand-drawn
 * label cannot be scanned and the parcel would be refused.
 */
export async function createRoyalMailReturnLabel(orderId: string): Promise<{
  success: boolean;
  pdf: ArrayBuffer;
  royalMailOrderId: string;
  message: string;
}> {
  const { pdf, royalMailOrderId } = await getRoyalMailLabelForOrder(orderId, {
    includeReturnsLabel: true
  });

  return {
    success: true,
    pdf,
    royalMailOrderId,
    message: `Royal Mail pre-paid returns label retrieved for order #${orderId}.`
  };
}

export { createRoyalMailReturnLabel as createReturnLabel };
