/**
 * Reports whether a subscription order ended up with a stored Worldpay card.
 *
 *   npx tsx scripts/inspectSubscriptionToken.ts PS65700
 *
 * Read-only: it queries the database and, with --worldpay, asks Worldpay about
 * the payment itself. It writes nothing and takes no payment.
 *
 * The three things that decide whether a plan can renew are printed together,
 * because only their combination is meaningful:
 *
 *   worldpayTokenHref       the CARD. Required. Without it a renewal has no
 *                           payment instrument to present.
 *   worldpaySchemeReference the AGREEMENT. Necessary but not sufficient — this
 *                           is what PS25640 had on its own, and it could not
 *                           renew.
 *   transactionType         cardOnFile means the mandate was taken; oneTime
 *                           means the checkout fell back to an untokenised sale
 *                           and no token will ever exist for it.
 */
import 'dotenv/config';
import { fetchResource } from '../serverDb';
import { prisma } from '../src/lib/prisma';
import { extractSchemeReference, extractTokenHref, isUsableTokenHref } from '../backend/services/worldpaySubscription';

const args = process.argv.slice(2);
const ORDER_ID = args.find(a => !a.startsWith('--'));
const ASK_WORLDPAY = args.includes('--worldpay');

if (!ORDER_ID) {
  console.error('Usage: npx tsx scripts/inspectSubscriptionToken.ts <ORDER_ID> [--worldpay]');
  process.exit(1);
}

const BASE = process.env.WORLDPAY_BASE_URL || 'https://access.worldpay.com';
const ENTITY = process.env.WORLDPAY_ENTITY || process.env.WORLDPAY_ENTITY_ID || '';
const QUERY_ACCEPT = 'application/vnd.worldpay.payment-queries-v1.hal+json';

function authHeader(): string | null {
  const u = process.env.WORLDPAY_API_USERNAME;
  const p = process.env.WORLDPAY_API_PASSWORD;
  if (!u || !p) return null;
  return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
}

async function lookupPayment(reference: string): Promise<any | null> {
  const auth = authHeader();
  if (!auth) {
    console.log('  (no Worldpay credentials in this environment — skipping the gateway query)');
    return null;
  }
  const url =
    `${BASE}/paymentQueries/payments?transactionReference=${encodeURIComponent(reference)}` +
    `&entityReference=${encodeURIComponent(ENTITY)}`;
  try {
    const res = await fetch(url, { method: 'GET', headers: { Authorization: auth, Accept: QUERY_ACCEPT } });
    if (!res.ok) {
      console.log(`  Worldpay query returned HTTP ${res.status}`);
      return null;
    }
    const data: any = await res.json().catch(() => null);
    return data?._embedded?.payments?.[0] || data?.payments?.[0] || null;
  } catch (err: any) {
    console.log('  Worldpay query failed:', err?.message);
    return null;
  }
}

async function main() {
  console.log(`\n=== ${ORDER_ID} ===\n`);

  const subs: any[] = (await fetchResource('subscriptions')) || [];
  const matches = subs.filter(
    (s: any) =>
      String(s?.sourceOrderId || '') === ORDER_ID ||
      String(s?.worldpayTransactionId || '') === ORDER_ID ||
      String(s?.lastPaymentId || '') === ORDER_ID
  );

  if (!matches.length) {
    console.log('No subscription is linked to this order.');
    console.log('Either the order was not a subscription, or the payment was never verified.');
  }

  for (const s of matches) {
    const hasCard = isUsableTokenHref(s.worldpayTokenHref);
    console.log(`subscription        : ${s.id}`);
    console.log(`status              : ${s.status}`);
    console.log(`customer            : ${s.customerEmail}`);
    console.log(`amount              : ${s.amount} ${s.currency || 'GBP'} every ${s.billingInterval}`);
    console.log(`nextBillingDate     : ${s.nextBillingDate}`);
    console.log('');
    console.log(`STORED CARD (token) : ${s.worldpayTokenHref || 'MISSING'}`);
    console.log(`agreement (scheme)  : ${s.worldpaySchemeReference || 'none'}`);
    console.log(`recurring href      : ${s.worldpayRecurringHref || 'none'}`);
    if (s.tokenisationDowngraded) {
      console.log('tokenisation        : REFUSED at checkout — this plan can never renew');
    }
    if (s.tokenLookupExhaustedAt) {
      console.log(`lookup exhausted    : ${s.tokenLookupExhaustedAt} (Worldpay holds no token for it)`);
    }
    console.log('');
    console.log(hasCard ? 'VERDICT: recurring payments ARE set up.' : 'VERDICT: recurring payments are NOT set up — no card is stored.');
    console.log('');

    // The typed Neon row is what the renewal worker reads, so confirm it agrees
    // with the blob rather than assuming the sync ran.
    const row = await prisma.subscription
      .findUnique({ where: { id: String(s.id) }, select: { worldpayTokenHref: true, worldpaySchemeReference: true } })
      .catch(() => null);
    if (!row) {
      console.log('Neon Subscription row: NOT FOUND (the typed table is out of sync with the store)');
    } else {
      const agrees = String(row.worldpayTokenHref || '') === String(s.worldpayTokenHref || '');
      console.log(`Neon Subscription row: token=${row.worldpayTokenHref || 'NULL'} ${agrees ? '(agrees)' : '(DISAGREES with the store copy)'}`);
    }
  }

  const parked: any[] = (await fetchResource('worldpayPendingTokens')) || [];
  const live = parked.filter((t: any) => isUsableTokenHref(t?.tokenHref));
  console.log(`\nParked tokens awaiting a subscription: ${live.length}`);
  for (const t of live) {
    console.log(`  ref=${t.reference || 'n/a'} namespace=${t.namespace || 'n/a'} receivedAt=${t.receivedAt}`);
  }

  if (ASK_WORLDPAY) {
    console.log('\n=== What Worldpay holds for this payment ===');
    const payment = await lookupPayment(ORDER_ID);
    if (!payment) {
      console.log('  no payment published for this reference');
    } else {
      const token = extractTokenHref(payment);
      console.log(`  lastEvent        : ${payment.lastEvent || payment.outcome}`);
      console.log(`  transactionType  : ${payment.transactionType || 'unknown'}`);
      console.log(`  scheme.reference : ${extractSchemeReference(payment) || 'none'}`);
      console.log(`  token on payment : ${token || 'NONE'}`);
      if (!token) {
        console.log('  -> Worldpay did not store a card for this payment. It cannot be recovered;');
        console.log('     the customer has to subscribe again once tokenisation is working.');
      }
    }
  }

  await prisma.$disconnect().catch(() => {});
}

main();
