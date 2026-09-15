/**
 * End-to-end verification of the Worldpay subscription token flow.
 *
 *   npx tsx scripts/verifyWorldpayTokenFlow.ts
 *
 * Drives the REAL Express app and the REAL route handlers. Only Worldpay itself
 * is stubbed, at the fetch boundary, so every assertion is about this codebase's
 * behaviour rather than about the stub. It answers the question a live test
 * cannot answer cheaply: if Worldpay behaves in each of the ways it actually
 * behaves, does the card end up stored and does the renewal present it?
 *
 * Safety. The script runs in a throwaway working directory with no
 * DATABASE_URL, so the local JSON store it writes is a temporary one and
 * production Neon is never touched. Mail and analytics credentials are cleared,
 * and the fetch stub throws on any host that is not Worldpay, so a run cannot
 * email a customer or publish an event. The Neon column write is covered
 * separately, in case 6, through the same writer the live path uses.
 *
 * What it cannot cover: Worldpay's own behaviour. Whether this merchant account
 * really issues a token, and really delivers a tokenCreated webhook, can only be
 * established by one real payment on the Hosted Payment Page.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const TOKEN_A = 'https://access.worldpay.com/tokens/6a1f9c2d4b8e47f0';
const TOKEN_B = 'https://access.worldpay.com/tokens/b73e5a19cc0d42aa';
const TOKEN_C = 'https://access.worldpay.com/tokens/f10c8d7e2a934bb6';
/** Space-padded exactly as the card schemes return it. */
const SCHEME_REF = 'MRLZRGKT60908  ';

type Scenario = {
  /** Worldpay refuses `optIn: "Silent"` because it is not enabled on the account. */
  silentRejected: boolean;
  /** Worldpay refuses stored-card mandates altogether. */
  mandateRejected: boolean;
  /** Token link the payment query publishes, if any. */
  queryToken: string | null;
};

const scenario: Scenario = { silentRejected: true, mandateRejected: false, queryToken: null };

const calls = {
  paymentPages: [] as any[],
  authorizations: [] as any[],
  queries: [] as string[]
};

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  // A throwaway store, named before serverDb is imported: it reads
  // LOCAL_STORE_PATH once, at module load. Without this the run would write its
  // test orders into the repo's own local_store_data.json.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-token-verify-'));
  process.env.LOCAL_STORE_PATH = path.join(sandbox, 'local_store_data.json');

  process.env.DATABASE_URL = '';
  process.env.WORLDPAY_ENTITY = 'PO1234567';
  process.env.WORLDPAY_API_USERNAME = 'harness-user';
  process.env.WORLDPAY_API_PASSWORD = 'harness-pass';
  process.env.WORLDPAY_BASE_URL = 'https://access.worldpay.com';
  process.env.WORLDPAY_ENVIRONMENT = 'live';
  process.env.WORLDPAY_TOKEN_OPT_IN = 'Silent';
  process.env.NODE_ENV = 'test';

  // No outbound side effects from a test run.
  process.env.GMAIL_APP_PASSWORD = '';
  process.env.SMTP_PASS = '';
  process.env.RESEND_API_KEY = '';
  process.env.KLAVIYO_PRIVATE_KEY = '';
  process.env.KLAVIYO_PUBLIC_KEY = '';
  process.env.KLAVIYO_COMPANY_ID = '';

  const realFetch = globalThis.fetch.bind(globalThis);

  const json = (status: number, payload: any) =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url || input);
    if (url.includes('127.0.0.1') || url.includes('localhost')) return realFetch(input, init);
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (url.includes('/payment_pages')) {
      calls.paymentPages.push(body);
      if (scenario.mandateRejected && body?.createToken) {
        return json(400, { errorName: 'bodyDoesNotMatchSchema', message: 'customerAgreement not enabled' });
      }
      if (scenario.silentRejected && body?.createToken?.optIn === 'Silent') {
        return json(400, { errorName: 'bodyDoesNotMatchSchema', message: 'optIn Silent is not enabled for this entity' });
      }
      return json(201, {
        _links: { 'payment_pages:redirect': { href: 'https://payments.worldpay.com/app/hpp/integration/x' } }
      });
    }

    if (url.includes('/paymentQueries/payments')) {
      calls.queries.push(url);
      const payment: any = {
        id: 'pay-harness-0001',
        lastEvent: 'settlementRequestSubmitted',
        transactionType: 'cardOnFile',
        authorizationCode: 'AUTH123',
        scheme: { reference: SCHEME_REF },
        paymentInstrument: { card: { brand: 'visa' } }
      };
      if (scenario.queryToken) payment._links = { 'tokens:token': { href: scenario.queryToken } };
      return json(200, { _embedded: { payments: [payment] } });
    }

    if (url.includes('/payments/authorizations')) {
      calls.authorizations.push(body);
      return json(201, {
        id: 'auth-harness-0001',
        outcome: 'authorized',
        authorizationCode: 'AUTH999',
        scheme: { reference: SCHEME_REF }
      });
    }

    // Proves the run reaches nothing but Worldpay.
    throw new Error(`[verify] blocked outbound call: ${url}`);
  }) as any;

  const { createExpressApp } = await import('../serverApp');
  const { fetchResource } = await import('../serverDb');
  const { toSubscriptionRow } = await import('../src/lib/subscriptionRow');

  const app = await createExpressApp();
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  const post = async (route: string, body: any) => {
    const res = await realFetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const subscriptionFor = async (orderId: string) => {
    const subs: any[] = (await fetchResource('subscriptions')) || [];
    return subs.find((s: any) => String(s.sourceOrderId) === String(orderId));
  };

  const checkoutBody = (orderId: string, email: string) => ({
    orderId,
    amount: 25,
    total: 25,
    customerName: 'Harness Tester',
    customerEmail: email,
    customerPhone: '07581708618',
    destination: '39 Tonks Drive, Telford, TF4 2TQ, United Kingdom',
    shippingAddress: {
      addressLine1: '39 Tonks Drive',
      city: 'Telford',
      postcode: 'TF4 2TQ',
      country: 'United Kingdom',
      countryCode: 'GB',
      phone: '07581708618'
    },
    items: [
      {
        productId: 'sub-pack-harness',
        productTitle: 'LITE Plan - harness',
        price: 22.01,
        quantity: 1,
        isSubscription: true,
        subscriptionPlan: 'LITE Plan',
        subscriptionFrequency: 'month'
      }
    ],
    recurring: true
  });

  /** The Access webhook shape: the token rides under eventDetails, not data. */
  const tokenCreatedEvent = (orderId: string, email: string, token: string) => ({
    eventId: `evt-${Date.now()}`,
    eventTimestamp: new Date().toISOString(),
    eventDetails: {
      type: 'tokenCreated',
      transactionReference: orderId,
      namespace: email,
      tokenPaymentInstrument: { href: token }
    }
  });

  try {
    console.log('\n=== 1. Checkout asks Worldpay to store the card, and keeps asking ===');
    const ORDER_1 = 'PS90001';
    const EMAIL_1 = 'harness.one@pouch-supply.com';
    const session = await post('/api/worldpay/session', checkoutBody(ORDER_1, EMAIL_1));

    check('payment page created despite the Silent rejection', session.status === 200, `status ${session.status}`);
    check('two payment-page attempts were made', calls.paymentPages.length === 2, `saw ${calls.paymentPages.length}`);
    check('attempt 1 asked for a stored card', Boolean(calls.paymentPages[0]?.createToken));
    check('attempt 1 used the configured optIn', calls.paymentPages[0]?.createToken?.optIn === 'Silent');
    check(
      'attempt 2 retried with optIn ASK rather than dropping the token',
      calls.paymentPages[1]?.createToken?.optIn === 'ASK',
      `got ${JSON.stringify(calls.paymentPages[1]?.createToken?.optIn)}`
    );
    check('attempt 2 kept the customer agreement', calls.paymentPages[1]?.customerAgreement?.type === 'subscription');
    check('namespace is the shopper email, so the token can be matched back', calls.paymentPages[1]?.createToken?.namespace === EMAIL_1);

    console.log('\n=== 2. Token arrives on the webhook after the order, and is saved ===');
    scenario.queryToken = null;
    await post('/api/worldpay/verify-payment', { orderId: ORDER_1, status: 'SUCCESS' });

    const beforeWebhook = await subscriptionFor(ORDER_1);
    check('subscription was created by the verified payment', Boolean(beforeWebhook), 'no subscription found');
    check('it starts with no stored card', !beforeWebhook?.worldpayTokenHref);
    check('it captured the scheme reference', String(beforeWebhook?.worldpaySchemeReference || '').trim() === SCHEME_REF.trim());

    const hook = await post('/api/worldpay/webhook', tokenCreatedEvent(ORDER_1, EMAIL_1, TOKEN_A));
    check('webhook accepted the tokenCreated event', hook.status === 200, `status ${hook.status}`);
    check('webhook reported it processed the token', hook.body?.processed === true, JSON.stringify(hook.body));

    const afterWebhook = await subscriptionFor(ORDER_1);
    check('token was saved against the subscription', afterWebhook?.worldpayTokenHref === TOKEN_A, `got ${afterWebhook?.worldpayTokenHref}`);

    console.log('\n=== 3. The renewal presents the stored card ===');
    calls.authorizations.length = 0;
    const charge = await post('/api/subscriptions/charge', { subscriptionId: afterWebhook?.id });
    check('recurring charge succeeded', charge.body?.success === true, JSON.stringify(charge.body).slice(0, 200));

    const mit = calls.authorizations[0];
    check('a charge was actually sent to Worldpay', Boolean(mit));
    check('it carried the card as a payment instrument', mit?.instruction?.paymentInstrument?.type === 'card/token', JSON.stringify(mit?.instruction?.paymentInstrument));
    check('the instrument is the token from the webhook', mit?.instruction?.paymentInstrument?.href === TOKEN_A);
    check('it is flagged as a subsequent stored-card use', mit?.instruction?.customerAgreement?.storedCardUsage === 'subsequent');
    check('it carried the scheme reference too', String(mit?.instruction?.customerAgreement?.schemeReference || '').trim() === SCHEME_REF.trim());

    console.log('\n=== 4. Token that arrives BEFORE its order is parked, then claimed ===');
    const ORDER_2 = 'PS90002';
    const EMAIL_2 = 'harness.two@pouch-supply.com';
    const early = await post('/api/worldpay/webhook', tokenCreatedEvent(ORDER_2, EMAIL_2, TOKEN_B));
    check('early webhook was accepted', early.status === 200);

    const parked: any[] = (await fetchResource('worldpayPendingTokens')) || [];
    check('unmatched token was parked rather than dropped', parked.some((t: any) => t?.tokenHref === TOKEN_B), JSON.stringify(parked));

    await post('/api/worldpay/session', checkoutBody(ORDER_2, EMAIL_2));
    await post('/api/worldpay/verify-payment', { orderId: ORDER_2, status: 'SUCCESS' });

    const claimed = await subscriptionFor(ORDER_2);
    check('the parked token was claimed by its subscription', claimed?.worldpayTokenHref === TOKEN_B, `got ${claimed?.worldpayTokenHref}`);

    const parkedAfter: any[] = (await fetchResource('worldpayPendingTokens')) || [];
    check(
      'the claimed token is retired so it cannot be claimed twice',
      parkedAfter.filter((t: any) => t?.tokenHref === TOKEN_B).length === 0,
      JSON.stringify(parkedAfter)
    );

    console.log('\n=== 5. If the webhook never arrives, the sweep recovers the card ===');
    const ORDER_3 = 'PS90003';
    const EMAIL_3 = 'harness.three@pouch-supply.com';
    scenario.queryToken = null;
    await post('/api/worldpay/session', checkoutBody(ORDER_3, EMAIL_3));
    await post('/api/worldpay/verify-payment', { orderId: ORDER_3, status: 'SUCCESS' });

    const stranded = await subscriptionFor(ORDER_3);
    check('subscription exists with no stored card (webhook never came)', Boolean(stranded) && !stranded?.worldpayTokenHref);

    scenario.queryToken = TOKEN_C;
    const sweep = await post('/api/worldpay/recover-tokens', {});
    check('sweep ran', sweep.status === 200, `status ${sweep.status}`);

    const healed = await subscriptionFor(ORDER_3);
    check('sweep recovered the card without any webhook', healed?.worldpayTokenHref === TOKEN_C, `got ${healed?.worldpayTokenHref}`);

    console.log('\n=== 6. The token reaches the typed Neon column ===');
    const row = toSubscriptionRow({
      id: 'sub-row-check',
      customerEmail: EMAIL_1,
      planId: 'sub-pack-harness',
      planName: 'LITE Plan',
      amount: 25,
      status: 'active',
      worldpayTokenHref: TOKEN_A
    });
    check('worldpayTokenHref is written into the Subscription row', row.worldpayTokenHref === TOKEN_A, JSON.stringify(row.worldpayTokenHref));

    console.log('\n=== 7. A plan Worldpay refused to tokenise is marked, not left looking healthy ===');
    const ORDER_4 = 'PS90004';
    const EMAIL_4 = 'harness.four@pouch-supply.com';
    scenario.mandateRejected = true;
    calls.paymentPages.length = 0;
    const downgraded = await post('/api/worldpay/session', checkoutBody(ORDER_4, EMAIL_4));
    check('the sale still completed', downgraded.status === 200, `status ${downgraded.status}`);
    check('the last attempt dropped the token to save the sale', !calls.paymentPages[calls.paymentPages.length - 1]?.createToken);

    scenario.queryToken = null;
    await post('/api/worldpay/verify-payment', { orderId: ORDER_4, status: 'SUCCESS' });
    const flagged = await subscriptionFor(ORDER_4);
    check('the subscription records that it cannot renew', flagged?.tokenisationDowngraded === true, JSON.stringify(flagged?.tokenisationDowngraded));
    scenario.mandateRejected = false;

    console.log('\n=== 8. A card Worldpay does not hold is asked for once, not forever ===');
    const ORDER_5 = 'PS90005';
    const EMAIL_5 = 'harness.five@pouch-supply.com';
    scenario.queryToken = null;
    await post('/api/worldpay/session', checkoutBody(ORDER_5, EMAIL_5));
    await post('/api/worldpay/verify-payment', { orderId: ORDER_5, status: 'SUCCESS' });

    await post('/api/worldpay/recover-tokens', {});
    const exhausted = await subscriptionFor(ORDER_5);
    check('a subscription with no recoverable card is marked as such', Boolean(exhausted?.tokenLookupExhaustedAt), JSON.stringify(exhausted?.tokenLookupExhaustedAt));

    const queriesBefore = calls.queries.length;
    await post('/api/worldpay/recover-tokens', {});
    check(
      'the next sweep does not ask Worldpay about it again',
      calls.queries.length === queriesBefore,
      `${calls.queries.length - queriesBefore} extra quer(ies)`
    );
  } catch (err: any) {
    failures.push(`harness threw: ${err?.stack || err?.message || err}`);
    console.error('\n[verify] threw:', err);
  } finally {
    server.close();
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(70));
  process.exit(failures.length ? 1 : 0);
}

main();
