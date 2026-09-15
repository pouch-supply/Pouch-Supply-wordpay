/**
 * Works out WHY the Hosted Payment Page is not producing a stored card.
 *
 *   npx tsx scripts/diagnoseWorldpayTokenisation.ts
 *
 * No payment is taken and no order is created. The probes create Hosted Payment
 * Page sessions that nobody visits, which is the same thing the checkout does
 * before a shopper reaches Worldpay; an unvisited page simply expires.
 *
 * The question it answers
 * -----------------------
 * PS65700 came back from Worldpay as `transactionType: cardOnFile` with no
 * token. cardOnFile proves the request that Worldpay accepted still carried
 * `customerAgreement` — the checkout's last-resort retry strips `customerAgreement`
 * and `createToken` together, so if it had fired the payment would have been
 * `oneTime`. The accepted request therefore carried `createToken` too, and
 * Worldpay returned no token for it.
 *
 * That leaves two possibilities, and they need different fixes:
 *
 *   A. `createToken` is not part of the payment_pages schema, so Worldpay parses
 *      the request, ignores the field it does not know, and creates an ordinary
 *      page. Tokenisation would then be impossible through the Hosted Payment
 *      Page and the first payment has to move to a flow that supports it.
 *
 *   B. `createToken` is understood but something about it is refused for this
 *      account (opt-in not enabled, tokens not provisioned on the entity).
 *
 * Probe 2 separates them. It sends a deliberately invalid `optIn` value. An API
 * that understands the field rejects the value; an API that ignores the field
 * accepts the request happily. Probe 3 is the control: a top-level field that
 * certainly does not exist, which establishes whether this endpoint rejects
 * unknown fields at all. Without that control, probe 2 on its own proves nothing.
 */
import 'dotenv/config';

const BASE = (process.env.WORLDPAY_BASE_URL || 'https://access.worldpay.com').replace(/\/+$/, '');
const ENTITY = process.env.WORLDPAY_ENTITY || process.env.WORLDPAY_ENTITY_ID || '';
const HPP_MEDIA = 'application/vnd.worldpay.payment_pages-v1.hal+json';

function authHeader(): string | null {
  const u = process.env.WORLDPAY_API_USERNAME;
  const p = process.env.WORLDPAY_API_PASSWORD;
  if (!u || !p) return null;
  return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
}

const auth = authHeader();
if (!auth || !ENTITY) {
  console.error('WORLDPAY_API_USERNAME / WORLDPAY_API_PASSWORD / WORLDPAY_ENTITY must be set.');
  process.exit(1);
}

const ref = () => `DIAG-${Date.now().toString().slice(-8)}-${Math.random().toString(36).slice(2, 6)}`;

function basePage(): Record<string, unknown> {
  return {
    transactionReference: ref(),
    merchant: { entity: ENTITY },
    narrative: { line1: 'Pouch Supply Diag' },
    value: { currency: 'GBP', amount: 100 },
    description: 'Tokenisation diagnostic',
    billingAddressName: 'Diagnostic Probe',
    resultURLs: {
      successURL: 'https://pouch-supply.com/diag/success',
      pendingURL: 'https://pouch-supply.com/diag/pending',
      failureURL: 'https://pouch-supply.com/diag/failure',
      errorURL: 'https://pouch-supply.com/diag/error',
      cancelURL: 'https://pouch-supply.com/diag/cancel',
      expiryURL: 'https://pouch-supply.com/diag/expiry'
    }
  };
}

async function postPage(label: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/payment_pages`, {
    method: 'POST',
    headers: { Authorization: auth!, 'Content-Type': HPP_MEDIA, Accept: HPP_MEDIA },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep the raw text */
  }
  console.log(`\n--- ${label}`);
  console.log(`    HTTP ${res.status}`);
  if (parsed) {
    const keys = Object.keys(parsed);
    console.log(`    response keys: ${keys.join(', ') || '(none)'}`);
    if (parsed.errorName || parsed.message || parsed.description) {
      console.log(`    error: ${parsed.errorName || ''} ${parsed.description || parsed.message || ''}`.trim());
    }
    if (parsed.validationErrors) {
      console.log(`    validationErrors: ${JSON.stringify(parsed.validationErrors).slice(0, 400)}`);
    }
    // If the response ever echoes the token request back, that is direct proof
    // the field was understood.
    if (parsed.createToken || parsed._links?.['tokens:token']) {
      console.log(`    !! response references a token: ${JSON.stringify(parsed.createToken || parsed._links['tokens:token'])}`);
    }
  } else {
    console.log(`    body: ${text.slice(0, 300)}`);
  }
  return { status: res.status, parsed };
}

async function main() {
  console.log(`Worldpay tokenisation diagnostic`);
  console.log(`  base   : ${BASE}`);
  console.log(`  entity : ${ENTITY}`);

  // ---------------------------------------------------------------- discovery
  console.log('\n=== Which services this account exposes ===');
  try {
    const res = await fetch(`${BASE}/`, { method: 'GET', headers: { Authorization: auth!, Accept: 'application/json' } });
    const data: any = await res.json().catch(() => null);
    console.log(`    HTTP ${res.status}`);
    const links = data?._links || {};
    const names = Object.keys(links);
    if (!names.length) {
      console.log('    no _links returned');
    } else {
      for (const n of names) console.log(`    ${n}  ->  ${links[n]?.href || ''}`);
      const tokenish = names.filter(n => /token/i.test(n));
      console.log(
        tokenish.length
          ? `\n    token-related services: ${tokenish.join(', ')}`
          : '\n    NO token-related service is advertised for these credentials.'
      );
    }
  } catch (err: any) {
    console.log('    discovery failed:', err?.message);
  }

  // ------------------------------------------------------------------- probes
  console.log('\n=== Probes ===');

  const withToken = {
    ...basePage(),
    customerAgreement: { type: 'subscription', storedCardUsage: 'first' },
    createToken: {
      type: 'worldpay',
      namespace: 'diagnostic@pouch-supply.com',
      description: 'Pouch Supply subscription',
      optIn: process.env.WORLDPAY_TOKEN_OPT_IN || 'Silent'
    }
  };
  const p1 = await postPage('Probe 1: exactly what the checkout sends today', withToken);

  const badOptIn = {
    ...basePage(),
    customerAgreement: { type: 'subscription', storedCardUsage: 'first' },
    createToken: {
      type: 'worldpay',
      namespace: 'diagnostic@pouch-supply.com',
      description: 'Pouch Supply subscription',
      optIn: 'ThisIsNotAValidOptInValue'
    }
  };
  const p2 = await postPage('Probe 2: same, but with a deliberately invalid optIn', badOptIn);

  const nonsense = { ...basePage(), thisFieldCertainlyDoesNotExist: { nested: 'value' } };
  const p3 = await postPage('Probe 3 (control): a top-level field that does not exist', nonsense);

  const agreementOnly = {
    ...basePage(),
    customerAgreement: { type: 'subscription', storedCardUsage: 'first' }
  };
  const p4 = await postPage('Probe 4: customerAgreement with no createToken', agreementOnly);

  // ------------------------------------------------------------------ verdict
  console.log('\n\n=== Verdict ===');
  const ok = (r: { status: number }) => r.status >= 200 && r.status < 300;

  if (!ok(p1)) {
    console.log('  Probe 1 was REJECTED, so the live checkout request is being refused outright.');
    console.log('  Read the error above — that is the reason tokenisation never happens.');
  } else if (ok(p2) && ok(p3)) {
    console.log('  Probe 2 (invalid optIn) and Probe 3 (invented field) were both ACCEPTED.');
    console.log('  This endpoint does not validate fields it does not recognise, and it never');
    console.log('  complained about createToken either. The most likely reading is that');
    console.log('  createToken is NOT part of the payment_pages schema and is being silently');
    console.log('  discarded — which matches PS65700: agreement honoured, no token issued.');
    console.log('');
    console.log('  If so, no amount of adjusting createToken on this request will work, and the');
    console.log('  first payment has to be taken through a flow that does support tokenisation.');
    console.log('  Put this to Worldpay support verbatim:');
    console.log('    "On entity ' + ENTITY + ', does the Hosted Payment Pages API (payment_pages-v1)');
    console.log('     support creating a token? We send createToken alongside customerAgreement;');
    console.log('     the payment comes back transactionType cardOnFile but no token is created');
    console.log('     and no tokenCreated event is delivered. If HPP cannot tokenise, which');
    console.log('     integration should we use to store the card on the first payment?"');
  } else if (!ok(p2) && ok(p3)) {
    console.log('  Probe 2 was REJECTED while Probe 3 was accepted: createToken IS understood');
    console.log('  and validated, so the field is supported and the problem is its contents or');
    console.log('  an account permission. The rejection text above names it.');
  } else if (!ok(p3)) {
    console.log('  Probe 3 was REJECTED, so this endpoint does reject unknown fields. Since');
    console.log('  Probe 1 was accepted, createToken is a field Worldpay recognises, and the');
    console.log('  missing token is an account/permission matter rather than a schema one.');
    console.log('  Ask Worldpay whether tokens are provisioned on entity ' + ENTITY + '.');
  }

  console.log(`\n  (Probe 4, agreement without a token, returned HTTP ${p4.status}.)`);
  console.log('\n  None of these took a payment. The pages created here were never opened and expire unused.');
}

main();
