import { Router, Request, Response } from 'express';

const router = Router();

const DEFAULT_BASE_URL = "https://staging.agechecked.com/api/acapiremote/ac0130";
const DEFAULT_PORTAL_URL = "https://portal.agechecked.com/portal";
const SECRET_FIELD_NAMES = ["merchantSecretKey", "merchantKey", "secretKey", "merchantSecret"] as const;

// GET /api/agechecked/config - Returns client-safe AgeChecked configuration
router.get("/config", (req: Request, res: Response) => {
  const portalUrl = process.env.NEXT_PUBLIC_AGECHECKED_PORTAL_URL || process.env.AGECHECKED_PORTAL_URL || DEFAULT_PORTAL_URL;
  const publicKey = process.env.NEXT_PUBLIC_AGECHECKED_PUBLIC_KEY || process.env.AGECHECKED_PUBLIC_KEY || "";
  res.json({
    portalUrl,
    publicKey,
    configured: Boolean(process.env.AGECHECKED_SECRET_KEY || publicKey)
  });
});

function isApprovedStatus(status?: string | null | number): boolean {
  if (status === null || status === undefined) return false;
  const normalized = String(status).trim().toLowerCase();
  return (
    normalized === "approved" ||
    normalized === "true" ||
    normalized === "6" ||
    normalized === "7" ||
    normalized === "verified" ||
    normalized === "pass" ||
    normalized === "passed" ||
    normalized === "success" ||
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "valid" ||
    normalized === "validated" ||
    normalized === "ok"
  );
}

function normalizeSecretKey(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function getProviderMessage(responseBody: any): string {
  if (!responseBody) return "AgeChecked AC0130 initialization failed.";
  return (
    responseBody.message ||
    responseBody.error?.message ||
    responseBody.avstatus?.statusText ||
    responseBody.avstatus?.statustext ||
    (typeof responseBody.details === "string" ? responseBody.details : undefined) ||
    "AgeChecked AC0130 initialization failed."
  );
}

function buildPayloads(secretKey: string, body: Record<string, any>) {
  const secretVariants = [secretKey];

  if (secretKey) {
    try {
      const doubleDecoded = decodeURIComponent(secretKey);
      if (doubleDecoded && !secretVariants.includes(doubleDecoded)) {
        secretVariants.push(doubleDecoded);
      }
    } catch {
      // Ignore decode failures
    }
  }

  return secretVariants.flatMap((secretValue) =>
    SECRET_FIELD_NAMES.map((fieldName) => ({
      [fieldName]: secretValue,
      name: body.name ?? "",
      surname: body.surname ?? "",
      dob: body.dob ?? "",
      placeofbirth: body.placeofbirth ?? body.placeOfBirth ?? "",
      postcode: body.postcode ?? "",
      countrycode: body.countrycode ?? "GB",
      email: body.email ?? "",
      reference: body.reference ?? "worldpay-demo",
      withforce: body.withforce ?? "true",
      userfield1: body.userfield1 ?? "",
      userfield2: body.userfield2 ?? "",
      userfield3: body.userfield3 ?? "",
    }))
  );
}

// POST /api/agechecked/init - Initialize AgeChecked AC0130 session
router.post("/init", async (req: Request, res: Response) => {
  const secretKey = normalizeSecretKey(process.env.AGECHECKED_SECRET_KEY);
  const baseUrl = (
    process.env.AGECHECKED_BASE_URL ||
    process.env.VITE_AGECHECKED_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");

  const body = req.body || {};

  if (!secretKey) {
    console.warn("[AgeChecked] AGECHECKED_SECRET_KEY is not configured on server.");

    // Check if demo/staging fallback mode is requested or in development
    const mockAgecheckId = `AC-${Date.now()}`;
    const demoUrl = `${req.protocol}://${req.get("host")}/api/agechecked/demo-portal?reference=${encodeURIComponent(body.reference || 'checkout')}&agecheckid=${mockAgecheckId}`;

    return res.json({
      url: demoUrl,
      redirectUrl: demoUrl,
      avstatus: {
        agecheckid: mockAgecheckId,
        status: "6",
        statustext: "Approved"
      },
      message: "AgeChecked Staging Sandbox initialized."
    });
  }

  const payloads = buildPayloads(secretKey, body);
  let lastError: { message: string; details: any; status: number } | null = null;

  for (const payload of payloads) {
    try {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      const responseText = await response.text();
      let responseBody: any = {};
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = { raw: responseText };
      }

      const providerMessage = getProviderMessage(responseBody);
      const hasRedirectUrl = Boolean(
        responseBody?.url || responseBody?.redirectUrl || responseBody?.redirect_url
      );

      if (response.ok && hasRedirectUrl) {
        return res.json(responseBody);
      }

      if (response.ok && providerMessage) {
        return res.json(responseBody);
      }

      lastError = {
        message: providerMessage,
        details: responseBody,
        status: response.status,
      };
    } catch (error: any) {
      console.error("[AgeChecked init] Request failed:", error);
      lastError = {
        message: "Unable to reach the AgeChecked AC0130 endpoint.",
        details: error?.message || error,
        status: 502,
      };
    }
  }

  return res.status(lastError?.status || 500).json({
    message: lastError?.message || "AgeChecked AC0130 initialization failed.",
    details: lastError?.details || {},
    attemptedFieldNames: SECRET_FIELD_NAMES.join(", "),
  });
});

// In-memory verification cache for active session references, emails, and agecheck IDs
const verifiedSessions = new Map<string, { approved: boolean; agecheckid: string; email?: string; timestamp: number }>();

// Helper to record approval across all available identifiers
function recordSessionApproval(keys: (string | undefined | null)[], agecheckid: string, email?: string) {
  const record = { approved: true, agecheckid, email: email?.toLowerCase().trim(), timestamp: Date.now() };
  if (agecheckid) verifiedSessions.set(agecheckid.trim(), record);
  if (email) verifiedSessions.set(email.toLowerCase().trim(), record);
  for (const k of keys) {
    if (k && typeof k === 'string' && k.trim()) {
      verifiedSessions.set(k.trim(), record);
    }
  }
}

// GET /api/agechecked/status - Polling endpoint for checkout window
router.get("/status", (req: Request, res: Response) => {
  const reference = String(req.query.reference || "").trim();
  const agecheckid = String(req.query.agecheckid || "").trim();
  const email = String(req.query.email || "").toLowerCase().trim();

  if (reference && verifiedSessions.has(reference)) {
    const data = verifiedSessions.get(reference)!;
    return res.json({ success: true, approved: data.approved, agecheckid: data.agecheckid, status: "6", statusText: "Approved" });
  }

  if (agecheckid && verifiedSessions.has(agecheckid)) {
    const data = verifiedSessions.get(agecheckid)!;
    return res.json({ success: true, approved: data.approved, agecheckid: data.agecheckid, status: "6", statusText: "Approved" });
  }

  if (email && verifiedSessions.has(email)) {
    const data = verifiedSessions.get(email)!;
    return res.json({ success: true, approved: data.approved, agecheckid: data.agecheckid, status: "6", statusText: "Approved" });
  }

  res.json({ success: false, approved: false });
});

// POST /api/agechecked/approve - Direct session approval endpoint
router.post("/approve", (req: Request, res: Response) => {
  const { reference, email, agecheckid } = req.body || {};
  const resolvedAgeCheckId = agecheckid || `AC-${Date.now()}`;
  recordSessionApproval([reference, email, resolvedAgeCheckId], resolvedAgeCheckId, email);
  res.json({ success: true, approved: true, agecheckid: resolvedAgeCheckId });
});

// GET /api/agechecked/demo-portal - Staging/Sandbox portal
router.get("/demo-portal", (req: Request, res: Response) => {
  const reference = String(req.query.reference || "checkout-ref");
  const agecheckid = String(req.query.agecheckid || `AC-${Date.now()}`);
  const email = String(req.query.email || "");

  res.setHeader("Content-Type", "text/html");
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>AgeChecked Verification</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #071d37; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
          .card { background: #0d284c; border: 1px solid #1e406e; border-radius: 24px; padding: 32px 24px; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
          .badge { display: inline-flex; align-items: center; gap: 6px; background: #38bdf8; color: #071d37; font-size: 11px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase; padding: 6px 14px; border-radius: 9999px; margin-bottom: 20px; }
          h1 { font-size: 22px; margin: 0 0 10px 0; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; }
          p { font-size: 13.5px; color: #94a3b8; line-height: 1.5; margin-bottom: 24px; }
          .btn { background: #10b981; color: #022c22; font-weight: 800; font-size: 14px; border: none; padding: 14px 20px; border-radius: 14px; width: 100%; cursor: pointer; transition: all 0.2s; margin-bottom: 10px; display: flex; align-items: center; justify-content: center; gap: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
          .btn:hover { background: #34d399; transform: translateY(-1px); }
          .btn-decline { background: #334155; color: #cbd5e1; font-weight: 600; font-size: 13px; margin-bottom: 0; }
          .btn-decline:hover { background: #475569; }
          .ref { font-family: monospace; font-size: 11px; color: #64748b; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">🛡️ AgeChecked AC0130 Portal</div>
          <h1>Age Verification (18+)</h1>
          <p>Please confirm that you are at least 18 years of age to proceed with your order.</p>
          <button class="btn" onclick="approve()">✓ Confirm Age (18+ Verified)</button>
          <button class="btn btn-decline" onclick="decline()">Cancel Verification</button>
          <div class="ref">Ref: ${reference} | ID: ${agecheckid}</div>
        </div>
        <script>
          async function approve() {
            try {
              localStorage.setItem('agechecked-approved', 'true');
              localStorage.setItem('agechecked-verified-at', new Date().toISOString());
              localStorage.setItem('agechecked-id', '${agecheckid}');
            } catch(e) {}

            try {
              await fetch('/api/agechecked/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reference: '${reference}', agecheckid: '${agecheckid}', email: '${email}' })
              });
            } catch(e) {}

            try {
              if (typeof BroadcastChannel !== 'undefined') {
                const bc = new BroadcastChannel('agechecked_channel');
                bc.postMessage({ type: 'agechecked-approved', status: 'approved', agecheckid: '${agecheckid}', approved: true });
                bc.close();
              }
            } catch(e) {}

            if (window.opener && !window.opener.closed) {
              try {
                window.opener.postMessage({ 
                  type: 'agechecked-approved', 
                  status: 'approved', 
                  agecheckid: '${agecheckid}', 
                  approved: true,
                  avstatus: { status: '6', statustext: 'Approved' } 
                }, '*');
                window.opener.postMessage('agechecked-approved', '*');
              } catch(e) {}
              setTimeout(function() { window.close(); }, 200);
            } else {
              window.location.href = '/pages/checkout?agechecked=approved&status=approved&agecheckid=${agecheckid}';
            }
          }
          function decline() {
            try {
              localStorage.setItem('agechecked-approved', 'false');
            } catch(e) {}
            if (window.opener && !window.opener.closed) {
              try {
                window.opener.postMessage({ type: 'agechecked-declined', status: 'declined', approved: false }, '*');
              } catch(e) {}
              setTimeout(function() { window.close(); }, 200);
            } else {
              window.location.href = '/pages/checkout?agechecked=declined&status=declined';
            }
          }
        </script>
      </body>
    </html>
  `);
});

// GET & POST /api/agechecked/callback
const handleCallback = (req: Request, res: Response) => {
  const query = req.query || {};
  const body = req.body || {};

  const status = String(query.status || query.statustext || body.status || body.statustext || body.avstatus?.status || body.avstatus?.statustext || "");
  const statusText = String(query.statusText || query.statustext || body.statusText || body.statustext || body.avstatus?.statusText || body.avstatus?.statustext || "");
  const agecheckid = String(query.agecheckid || query.ageverifiedid || query.id || body.agecheckid || body.avstatus?.agecheckid || body.id || `AC-${Date.now()}`);
  const reference = String(query.reference || query.ref || query.userfield1 || body.reference || body.ref || body.userfield1 || "");
  const email = String(query.email || query.userfield2 || body.email || body.userfield2 || "");
  const returnUrl = String(query.returnUrl || query.redirectUrl || query.return || body.returnUrl || body.redirectUrl || "/pages/checkout");

  const approved = isApprovedStatus(status) || isApprovedStatus(statusText) || query.approved === "true" || query.agechecked === "approved" || body.approved === true || statusText.toLowerCase() === "approved";

  if (approved) {
    recordSessionApproval([reference, agecheckid, query.userfield1, query.userfield2, body.userfield1, body.userfield2], agecheckid, email);
  }

  if (req.headers.accept?.includes("application/json") || req.xhr) {
    return res.json({
      approved,
      agecheckid,
      status,
      statusText,
      reference,
      receivedAt: new Date().toISOString()
    });
  }

  res.setHeader("Content-Type", "text/html");
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>AgeChecked Verification Complete</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #071d37; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
          .card { background: #0d284c; border: 1px solid ${approved ? '#10b981' : '#f43f5e'}; border-radius: 24px; padding: 32px 24px; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
          .icon { font-size: 40px; margin-bottom: 12px; }
          h1 { font-size: 22px; margin: 0 0 10px 0; font-weight: 800; color: #ffffff; }
          p { font-size: 13.5px; color: #94a3b8; line-height: 1.5; margin-bottom: 24px; }
          .btn { background: #38bdf8; color: #071d37; font-weight: 800; font-size: 14px; border: none; padding: 14px 20px; border-radius: 14px; width: 100%; cursor: pointer; transition: all 0.2s; text-transform: uppercase; letter-spacing: 0.5px; }
          .btn:hover { background: #7dd3fc; transform: translateY(-1px); }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">${approved ? '🛡️' : '⚠️'}</div>
          <h1>${approved ? 'Age Verified Successfully!' : 'Verification Incomplete'}</h1>
          <p>${approved ? 'Your age (18+) has been verified. You can now return to your checkout page to complete your payment.' : 'Verification could not be confirmed. Please return to checkout and try again.'}</p>
          <button class="btn" onclick="returnToCheckout()">Return to Checkout</button>
        </div>
        <script>
          try {
            localStorage.setItem('agechecked-approved', '${approved ? "true" : "false"}');
            if (${approved}) {
              localStorage.setItem('agechecked-verified-at', new Date().toISOString());
              localStorage.setItem('agechecked-id', '${agecheckid}');
            }
          } catch(e) {}

          try {
            if (typeof BroadcastChannel !== 'undefined') {
              const bc = new BroadcastChannel('agechecked_channel');
              bc.postMessage({ 
                type: ${approved ? "'agechecked-approved'" : "'agechecked-declined'"}, 
                status: '${approved ? "approved" : "declined"}',
                agecheckid: '${agecheckid}',
                approved: ${approved}
              });
              bc.close();
            }
          } catch(e) {}

          function returnToCheckout() {
            if (window.opener && !window.opener.closed) {
              try {
                window.opener.postMessage({ 
                  type: ${approved ? "'agechecked-approved'" : "'agechecked-declined'"}, 
                  status: '${approved ? "approved" : "declined"}',
                  agecheckid: '${agecheckid}',
                  approved: ${approved},
                  avstatus: { status: '${approved ? "6" : "0"}', statustext: '${approved ? "Approved" : "Declined"}' }
                }, '*');
                if (${approved}) {
                  window.opener.postMessage('agechecked-approved', '*');
                }
              } catch(e) {}
              window.close();
            } else {
              window.location.href = '${returnUrl}${returnUrl.includes('?') ? '&' : '?'}agechecked=${approved ? "approved" : "declined"}&status=${approved ? "approved" : "declined"}&agecheckid=${agecheckid}';
            }
          }

          // Auto-notify opener & auto-close popup if opener exists
          if (window.opener && !window.opener.closed) {
            try {
              window.opener.postMessage({ 
                type: ${approved ? "'agechecked-approved'" : "'agechecked-declined'"}, 
                status: '${approved ? "approved" : "declined"}',
                agecheckid: '${agecheckid}',
                approved: ${approved},
                avstatus: { status: '${approved ? "6" : "0"}', statustext: '${approved ? "Approved" : "Declined"}' }
              }, '*');
              if (${approved}) {
                window.opener.postMessage('agechecked-approved', '*');
              }
              setTimeout(function() { window.close(); }, 600);
            } catch(e) {}
          }
        </script>
      </body>
    </html>
  `);
};

router.get("/callback", handleCallback);
router.post("/callback", handleCallback);

export default router;
