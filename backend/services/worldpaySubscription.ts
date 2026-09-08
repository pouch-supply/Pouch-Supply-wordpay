import crypto from "crypto";

type WorldpayConfig = {
  baseUrl: string;
  entity: string;
  authHeader: string;
  isTestMode: boolean;
};

/**
 * Placeholder credential values that earlier builds of this app manufactured
 * locally instead of reading them from a Worldpay response. They are not real
 * credentials and must never be sent to the gateway.
 */
const PLACEHOLDER_PATTERNS = [
  /^SCHEME-MOCK/i,
  /^SCHEME-SIM-/i,
  /^SCHEME-REF-\d+$/i,
  /^SCHEME-WP-/i,
  /^WP-MOCK/i,
  /^WP-SUB-AUTH-/i,
  /^WP-SUB-RECURRING-/i,
  /^WP-SUB-INIT-/i,
  /^WP-TEST-TXN-/i,
  /mock/i,
  /test-simulation/i
];

export function isPlaceholderCredential(value?: string | null): boolean {
  if (!value || typeof value !== "string") return true;
  return PLACEHOLDER_PATTERNS.some(rx => rx.test(value));
}

/**
 * A recurring href is only usable if Worldpay itself returned it. A URL we
 * built from an order id points at nothing and will always 404.
 */
export function isUsableRecurringHref(href?: string | null): boolean {
  if (!href || typeof href !== "string") return false;
  if (!href.startsWith("http")) return false;
  if (isPlaceholderCredential(href)) return false;
  // Locally fabricated links all had this shape: /payments/recurring/wp-<orderId>
  if (/\/payments\/recurring\/(wp-|mock-)/i.test(href)) return false;
  return true;
}

/**
 * Simulated authorizations are a development convenience only. They record an
 * order as Paid without any money moving, so they must be opted into
 * explicitly — otherwise a live store silently reports fake successful
 * renewals, which is exactly the failure this flag exists to prevent.
 *
 * The opt-in is ignored entirely on a live Worldpay account. A live store was
 * booking renewal orders as Paid, emailing dispatch confirmations and adding to
 * the customer's lifetime spend on authorizations that never reached Worldpay.
 * Testing that flow belongs on the try/sandbox environment.
 */
export function simulationAllowed(): boolean {
  const optedIn = String(process.env.WORLDPAY_ALLOW_SIMULATED_MIT || "").toLowerCase() === "true";
  if (!optedIn) return false;

  if (isLiveWorldpayEnvironment()) {
    console.error(
      "[Worldpay Subscription] WORLDPAY_ALLOW_SIMULATED_MIT is set but the environment is LIVE. " +
        "Simulated charges are refused: a renewal without a real Worldpay stored credential " +
        "will fail instead of being recorded as paid. Point WORLDPAY_BASE_URL at the try " +
        "environment to exercise the recurring flow."
    );
    return false;
  }

  return true;
}

/**
 * True when this process is pointed at a real, money-moving Worldpay account.
 * Both the declared environment and the base URL are checked, so a stale
 * WORLDPAY_ENVIRONMENT value cannot re-enable simulation against production.
 */
export function isLiveWorldpayEnvironment(): boolean {
  const declared = String(process.env.WORLDPAY_ENVIRONMENT || "live").toLowerCase();
  const baseUrl = String(process.env.WORLDPAY_BASE_URL || "https://access.worldpay.com").toLowerCase();
  const looksSandboxed = /try\.|sandbox|test\.access\.worldpay/.test(baseUrl);
  if (looksSandboxed) return false;
  return declared === "live" || declared === "production" || baseUrl.includes("access.worldpay.com");
}

function getWorldpayConfig(): WorldpayConfig {
  const username = process.env.WORLDPAY_API_USERNAME;
  const password = process.env.WORLDPAY_API_PASSWORD;
  const entity = process.env.WORLDPAY_ENTITY || process.env.WORLDPAY_ENTITY_ID;
  const baseUrl = (process.env.WORLDPAY_BASE_URL || "https://access.worldpay.com").replace(/\/+$/, "");
  const environment = String(process.env.WORLDPAY_ENVIRONMENT || "live").toLowerCase();

  if (!username || !password || !entity) {
    throw new Error("Worldpay subscription credentials are not configured.");
  }

  return {
    baseUrl,
    entity,
    isTestMode: environment === "test" || environment === "sandbox",
    authHeader: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  };
}

function getHeaders(config: WorldpayConfig) {
  const correlationId = crypto.randomUUID
    ? crypto.randomUUID()
    : `sub-${Math.random().toString(36).substring(2, 10)}`;
  return {
    Authorization: config.authHeader,
    "Content-Type": "application/json",
    Accept: "application/json",
    "WP-CorrelationId": correlationId
  };
}

/**
 * Creates the first payment for a subscription and asks Worldpay to store the
 * credential so that later merchant-initiated charges are possible.
 *
 * The `customerAgreement` block is what makes the card reusable. Without it
 * Worldpay authorises a one-off payment and returns no scheme reference, so
 * every subsequent recurring charge has nothing to present.
 */
export async function createInitialSubscriptionPayment({
  orderReference,
  amount,
  currency = "GBP",
  paymentInstrument,
  customerEmail
}: {
  orderReference: string;
  amount: number;
  currency?: string;
  paymentInstrument?: any;
  customerEmail?: string | null;
}) {
  const config = getWorldpayConfig();

  const body: any = {
    transactionReference: orderReference,
    merchant: { entity: config.entity },
    instruction: {
      narrative: { line1: "Pouch Supply Sub" },
      value: {
        currency,
        amount: Math.round(amount * 100)
      },
      customerAgreement: {
        type: "subscription",
        storedCardUsage: "first"
      }
    }
  };

  if (paymentInstrument) {
    body.instruction.paymentInstrument = paymentInstrument;
  }
  if (customerEmail) {
    body.customer = { email: customerEmail };
  }

  const response = await fetch(`${config.baseUrl}/api/payments/authorizations`, {
    method: "POST",
    headers: getHeaders(config),
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.description ||
        data?.message ||
        `Worldpay initial subscription payment failed (${response.status})`
    );
  }

  return data;
}

/**
 * Extracts the scheme transaction reference Worldpay issues for a stored
 * credential. This is the value that must be presented on every subsequent
 * merchant-initiated charge.
 */
export function extractSchemeReference(response: any): string | null {
  if (!response || typeof response !== "object") return null;

  const candidates = [
    response?.schemeReference,
    response?.schemeTransactionReference,
    response?.paymentInstrument?.schemeReference,
    response?.paymentInstrument?.schemeTransactionReference,
    response?.instruction?.paymentInstrument?.schemeReference,
    response?.customerAgreement?.schemeReference,
    response?.paymentInstrument?.card?.schemeReference
  ];

  for (const value of candidates) {
    if (value && typeof value === "string" && !isPlaceholderCredential(value)) {
      return value;
    }
  }

  return null;
}

/**
 * Extract the recurring action href returned by Worldpay.
 *
 * We inspect multiple HAL structures because Worldpay exposes action links
 * through `_links`. Anything that is not a genuine Worldpay-issued link is
 * rejected — a manufactured URL is worse than no URL, because it sends the
 * recurring charge to an endpoint that does not exist.
 */
export function extractRecurringAuthorizationHref(response: any): string | null {
  if (!response) return null;

  if (typeof response === "string") {
    return isUsableRecurringHref(response) ? response : null;
  }

  const links = response?._links;

  if (links && typeof links === "object") {
    const possibleKeys = [
      "payments:recurringAuthorize",
      "recurringAuthorize",
      "payments:recurring",
      "recurring"
    ];

    for (const key of possibleKeys) {
      const item = links[key];
      const href = typeof item === "string" ? item : item?.href;
      if (isUsableRecurringHref(href)) {
        return href as string;
      }
    }
  }

  const direct =
    response?.recurringHref || response?.worldpayRecurringHref || response?.worldpayRecurringUrl;

  return isUsableRecurringHref(direct) ? direct : null;
}

export interface RecurringChargeResult {
  id: string;
  status: string;
  outcome?: string;
  transactionReference: string;
  amount: number;
  currency: string;
  authCode?: string | null;
  schemeReference?: string | null;
  paymentMethod?: string;
  simulated: boolean;
  rawResponse?: any;
  timestamp: string;
}

/**
 * Perform a merchant initiated (MIT) recurring subscription payment.
 *
 * Requires a stored credential that Worldpay issued during the initial
 * payment — either a recurring action href or a scheme transaction reference.
 * Neither can be invented locally.
 */
export async function chargeRecurringSubscription({
  recurringHref,
  transactionReference,
  amount,
  currency = "GBP",
  schemeReference,
  previousTransactionId,
  customerEmail
}: {
  recurringHref?: string | null;
  transactionReference: string;
  amount: number;
  currency?: string;
  schemeReference?: string | null;
  previousTransactionId?: string | null;
  customerEmail?: string | null;
}): Promise<RecurringChargeResult> {
  let config: WorldpayConfig | null = null;
  let configError: string | null = null;

  try {
    config = getWorldpayConfig();
  } catch (cfgErr: any) {
    configError = cfgErr.message;
    console.warn("[Worldpay Subscription] Credentials note:", cfgErr.message);
  }

  const usableHref = isUsableRecurringHref(recurringHref);
  const usableScheme = Boolean(schemeReference) && !isPlaceholderCredential(schemeReference);
  const usablePreviousTx =
    Boolean(previousTransactionId) && !isPlaceholderCredential(previousTransactionId);

  if (!config) {
    if (simulationAllowed()) {
      return buildSimulatedResult(transactionReference, amount, currency, schemeReference);
    }
    throw new Error(
      configError ||
        "Worldpay credentials are not configured, so no recurring payment can be taken."
    );
  }

  if (!usableHref && !usableScheme && !usablePreviousTx) {
    if (simulationAllowed()) {
      console.warn(
        `[Worldpay Subscription] No stored credential for ${transactionReference}; returning a SIMULATED authorization because WORLDPAY_ALLOW_SIMULATED_MIT=true.`
      );
      return buildSimulatedResult(transactionReference, amount, currency, schemeReference);
    }
    throw new Error(
      "No Worldpay stored credential is available for this subscription. " +
        "The initial payment must be taken with a customer agreement so Worldpay returns a " +
        "scheme transaction reference to reuse for recurring charges."
    );
  }

  const targetUrl = usableHref
    ? (recurringHref as string)
    : `${config.baseUrl}/api/payments/authorizations`;

  console.log(
    `[Worldpay Subscription] Initiating MIT recurring charge via ${targetUrl} for ${transactionReference} (£${amount})`
  );

  const instruction: any = {
    narrative: { line1: "Pouch Supply Sub" },
    value: {
      currency,
      amount: Math.round(amount * 100)
    },
    debtRepayment: false,
    customerAgreement: {
      type: "subscription",
      storedCardUsage: "subsequent"
    }
  };

  if (usableScheme) {
    instruction.customerAgreement.schemeReference = schemeReference;
  } else if (usablePreviousTx) {
    instruction.customerAgreement.schemeReference = previousTransactionId;
  }

  const mitPayload: any = {
    transactionReference,
    merchant: { entity: config.entity },
    instruction
  };

  if (customerEmail) {
    mitPayload.customer = { email: customerEmail };
  }

  const response = await fetch(targetUrl, {
    method: "POST",
    headers: getHeaders(config),
    body: JSON.stringify(mitPayload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errMsg =
      data?.description || data?.message || `Worldpay returned HTTP ${response.status}`;
    console.error(
      `[Worldpay Subscription] Recurring charge REJECTED for ${transactionReference}: ${response.status} — ${errMsg}`
    );

    // Only fall back to a simulated success when explicitly enabled for
    // development. In every other case a rejection is a real failure and the
    // renewal must be recorded as failed rather than as a paid order.
    if (simulationAllowed()) {
      console.warn(
        "[Worldpay Subscription] WORLDPAY_ALLOW_SIMULATED_MIT=true — returning a simulated authorization instead of failing."
      );
      return buildSimulatedResult(transactionReference, amount, currency, schemeReference);
    }

    throw new Error(errMsg);
  }

  const outcome = String(data?.outcome || data?.lastEvent || "").toLowerCase();
  const declined =
    outcome.includes("refus") || outcome.includes("declin") || outcome.includes("fail");

  if (declined) {
    throw new Error(
      `Worldpay declined the recurring payment for ${transactionReference} (outcome: ${data?.outcome || "refused"}).`
    );
  }

  console.log(
    `[Worldpay Subscription] Live recurring payment SUCCESS for ${transactionReference}:`,
    data?.id || data?.outcome || "authorized"
  );

  return {
    id: data?.id || data?.transactionReference || transactionReference,
    status: "authorized",
    outcome: data?.outcome || "authorized",
    transactionReference,
    amount,
    currency,
    authCode: data?.authorizationCode || data?.authCode || null,
    schemeReference: extractSchemeReference(data) || (usableScheme ? schemeReference : null),
    simulated: false,
    rawResponse: data,
    timestamp: new Date().toISOString()
  };
}

function buildSimulatedResult(
  transactionReference: string,
  amount: number,
  currency: string,
  schemeReference?: string | null
): RecurringChargeResult {
  console.log(
    `[Worldpay Subscription] SIMULATED (no money taken) MIT authorization for tx: ${transactionReference}`
  );
  return {
    id: `WP-SIM-${Date.now().toString().slice(-6)}`,
    status: "authorized",
    transactionReference,
    amount,
    currency,
    authCode: "AUTH-SIMULATED",
    paymentMethod: "Simulated Worldpay Recurring",
    schemeReference: schemeReference || null,
    simulated: true,
    timestamp: new Date().toISOString()
  };
}
