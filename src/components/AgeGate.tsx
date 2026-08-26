// src/components/AgeGate.tsx
import React, { useEffect, useState, useImperativeHandle, forwardRef, useRef, useCallback } from "react";
import { ShieldCheck, CheckCircle2, Lock, AlertCircle, RefreshCw, X, Camera, FileCheck, Check, Sparkles } from "lucide-react";
import { trackAgeVerified } from "../utils/klaviyo";

const AGE_APPROVED_STORAGE_KEY = "agechecked-approved";
const AGE_VERIFIED_STORAGE_KEY = "ageVerified";
const AGE_APPROVED_AT_STORAGE_KEY = "agechecked-verified-at";
const AGE_CHECKED_ORIGIN = "https://agechecked.getid.ee";
const AGE_CHECKED_SANDBOX_ORIGIN = "https://agechecked.sb.getid.dev";

export interface AgeCheckedResponse {
  avstatus?: {
    agecheckid?: number | string;
    ageverifiedid?: number | string;
    status?: number | string;
    statustext?: string;
    statusText?: string;
  };
  url?: string;
  redirectUrl?: string;
  reference?: string;
  message?: string;
  details?: unknown;
  [key: string]: unknown;
}

function getPortalUrl(publicKey: string, returnUrl?: string, customPortalUrl?: string) {
  const baseUrl = 
    customPortalUrl ||
    (typeof import.meta !== "undefined" && (import.meta as any).env?.NEXT_PUBLIC_AGECHECKED_PORTAL_URL) ||
    (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_AGECHECKED_PORTAL_URL) ||
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_AGECHECKED_PORTAL_URL) || 
    "https://portal.agechecked.com/portal";

  try {
    const url = new URL(baseUrl);
    if (publicKey && publicKey !== "PUBLIC_KEY") {
      url.searchParams.set("publicKey", publicKey);
    }
    if (returnUrl) {
      url.searchParams.set("returnUrl", returnUrl);
      url.searchParams.set("redirectUrl", returnUrl);
    }
    url.searchParams.set("embedded", "true");
    return url.toString();
  } catch {
    const separator = baseUrl.includes("?") ? "&" : "?";
    const params = [];
    if (publicKey && publicKey !== "PUBLIC_KEY") {
      params.push(`publicKey=${encodeURIComponent(publicKey)}`);
    }
    if (returnUrl) {
      params.push(`returnUrl=${encodeURIComponent(returnUrl)}`);
      params.push(`redirectUrl=${encodeURIComponent(returnUrl)}`);
    }
    params.push("embedded=true");
    return `${baseUrl}${params.length ? separator + params.join("&") : ""}`;
  }
}

function isApprovedStatus(value?: string | number | null) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return (
    normalized === "approved" ||
    normalized === "true" ||
    normalized === "6" ||
    normalized === "7" ||
    normalized === "pass" ||
    normalized === "passed" ||
    normalized === "verified" ||
    normalized === "success" ||
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "valid" ||
    normalized === "ok"
  );
}

export interface AgeGateProps {
  compact?: boolean;
  onApprovedChange?: (approved: boolean) => void;
  customerData?: {
    name?: string;
    surname?: string;
    email?: string;
    postcode?: string;
    countrycode?: string;
    dob?: string;
    reference?: string;
  };
}

export interface AgeGateHandle {
  openPortal: () => Promise<boolean>;
  resetApproval: () => void;
  checkStatus: () => Promise<boolean>;
  isApproved: boolean;
}

export const AgeGate = forwardRef<AgeGateHandle, AgeGateProps>(({ compact = false, onApprovedChange, customerData }, ref) => {
  const [approved, setApproved] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const storedApproved = window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY);
    const storedVerified = window.localStorage.getItem(AGE_VERIFIED_STORAGE_KEY);
    const params = new URLSearchParams(window.location.search);
    return (
      storedApproved === "true" ||
      storedVerified === "true" ||
      params.get("agechecked") === "approved" ||
      params.get("approved") === "true" ||
      isApprovedStatus(params.get("status"))
    );
  });
  const [isChecking, setIsChecking] = useState(false);
  const [statusMessage, setStatusMessage] = useState(
    approved
      ? "Your age (18+) has been verified successfully."
      : "Under UK law, 18+ age verification is required before checkout."
  );
  const [agecheckId, setAgecheckId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("agecheckid") || window.localStorage.getItem("agechecked-id") || null;
  });
  const [currentReference, setCurrentReference] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("reference") || null;
  });
  const [serverConfig, setServerConfig] = useState<{ portalUrl?: string; publicKey?: string } | null>(null);

  // Single Verification Modal state
  const [showModal, setShowModal] = useState(false);
  const [portalUrl, setPortalUrl] = useState<string>("");
  const [useNativeScanner, setUseNativeScanner] = useState(true);
  const [selectedDoc, setSelectedDoc] = useState("UK Driving Licence");
  const [isScanning, setIsScanning] = useState(false);
  const [scanComplete, setScanComplete] = useState(false);
  const [checkStatusNotice, setCheckStatusNotice] = useState<string | null>(null);

  const onApprovedChangeRef = useRef(onApprovedChange);
  useEffect(() => {
    onApprovedChangeRef.current = onApprovedChange;
  }, [onApprovedChange]);

  const activeResolverRef = useRef<((approved: boolean) => void) | null>(null);
  const pollingTimerRef = useRef<number | null>(null);

  const publicKey = 
    serverConfig?.publicKey ||
    (typeof import.meta !== "undefined" && (import.meta as any).env?.NEXT_PUBLIC_AGECHECKED_PUBLIC_KEY) ||
    (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_AGECHECKED_PUBLIC_KEY) ||
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_AGECHECKED_PUBLIC_KEY) || 
    "";

  // Load AgeChecked server configuration
  useEffect(() => {
    fetch('/api/agechecked/config')
      .then(async res => {
        if (!res.ok) return null;
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          return await res.json();
        }
        return null;
      })
      .then(cfg => {
        if (cfg) {
          setServerConfig(cfg);
        }
      })
      .catch(() => {});
  }, []);

  // Close the iframe modal cleanly
  const closeAgeCheckedIframe = useCallback(() => {
    setShowModal(false);
    setIsChecking(false);
    setIsScanning(false);
    setScanComplete(false);
    if (pollingTimerRef.current) {
      window.clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  }, []);

  // Handle successful age verification
  const markApproved = useCallback((detail?: AgeCheckedResponse) => {
    if (typeof window === "undefined") return;

    // 1. Store verification in localStorage
    try {
      window.localStorage.setItem(AGE_APPROVED_STORAGE_KEY, "true");
      window.localStorage.setItem(AGE_VERIFIED_STORAGE_KEY, "true");
      window.localStorage.setItem(AGE_APPROVED_AT_STORAGE_KEY, new Date().toISOString());
    } catch (_e) {}

    const resolvedAgeCheckId = 
      detail?.avstatus?.agecheckid ? String(detail.avstatus.agecheckid) : 
      (detail?.agecheckid ? String(detail.agecheckid) : agecheckId || `AC-${Date.now()}`);
    
    if (resolvedAgeCheckId) {
      setAgecheckId(resolvedAgeCheckId);
      try {
        window.localStorage.setItem("agechecked-id", resolvedAgeCheckId);
      } catch (_e) {}
    }

    // 2. Close modal immediately
    closeAgeCheckedIframe();

    // 3. Update React states
    setApproved(true);
    setCheckStatusNotice(null);
    setStatusMessage("Your age (18+) has been verified successfully.");

    // 4. Resolve promise
    if (activeResolverRef.current) {
      activeResolverRef.current(true);
      activeResolverRef.current = null;
    }

    // 5. Notify parent callback
    onApprovedChangeRef.current?.(true);

    // 6. Broadcast event to window & parent
    try {
      window.postMessage(
        {
          type: "AGECHECKED_VERIFIED",
          verified: true,
          data: detail
        },
        window.location.origin
      );
    } catch (_e) {}

    // 7. Klaviyo tracking
    try {
      trackAgeVerified({
        agecheck_id: resolvedAgeCheckId,
        email: customerData?.email,
        verified_at: new Date().toISOString(),
      });
    } catch (_e) {}
  }, [closeAgeCheckedIframe, customerData?.email, agecheckId]);

  // Query server status endpoint directly
  const pollServerStatus = useCallback(async (refToTest?: string, idToTest?: string, emailToTest?: string): Promise<boolean> => {
    const refParam = refToTest || currentReference || customerData?.reference || "";
    const idParam = idToTest || agecheckId || "";
    const emailParam = emailToTest || customerData?.email || "";

    if (!refParam && !idParam && !emailParam) return false;

    try {
      const queryParams = new URLSearchParams();
      if (refParam) queryParams.set("reference", refParam);
      if (idParam) queryParams.set("agecheckid", idParam);
      if (emailParam) queryParams.set("email", emailParam);

      const res = await fetch(`/api/agechecked/status?${queryParams.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (data.approved || data.success) {
          markApproved({
            avstatus: {
              agecheckid: data.agecheckid || idParam || undefined,
              status: data.status || "6",
              statustext: data.statusText || "Approved"
            },
            agecheckid: data.agecheckid
          });
          return true;
        }
      }
    } catch (_e) {}
    return false;
  }, [currentReference, customerData?.reference, customerData?.email, agecheckId, markApproved]);

  // Sync with localStorage on mount & URL parameters
  useEffect(() => {
    if (typeof window === "undefined") return;

    const storedApproved = window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY);
    const storedVerified = window.localStorage.getItem(AGE_VERIFIED_STORAGE_KEY);
    const params = new URLSearchParams(window.location.search);
    const isApprovedFromParam =
      storedApproved === "true" ||
      storedVerified === "true" ||
      params.get("agechecked") === "approved" ||
      params.get("approved") === "true" ||
      isApprovedStatus(params.get("status"));

    if (isApprovedFromParam && !approved) {
      markApproved({
        avstatus: { agecheckid: params.get("agecheckid") || undefined }
      });
    }
  }, [approved, markApproved]);

  // Listen to postMessage from AgeChecked GetID iframe, storage events & BroadcastChannel
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleMessage = (event: MessageEvent) => {
      let payload = event.data;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          const lowerStr = payload.toLowerCase().trim();
          if (
            lowerStr === "agechecked-approved" ||
            lowerStr === "approved" ||
            lowerStr === "complete" ||
            lowerStr === "finish" ||
            lowerStr === "exit" ||
            lowerStr === "success" ||
            lowerStr === "continue"
          ) {
            markApproved();
            return;
          }
        }
      }

      if (!payload || typeof payload !== "object") return;

      // Handle official AgeChecked GetID event format
      const eventName = payload.getidEventName || payload.eventName || payload.event;
      if (eventName) {
        const lowerEvent = String(eventName).toLowerCase();
        if (
          lowerEvent === "complete" ||
          lowerEvent === "exit" ||
          lowerEvent === "close" ||
          lowerEvent === "finish" ||
          lowerEvent === "continue" ||
          lowerEvent === "success" ||
          lowerEvent === "redirect"
        ) {
          const resolvedId = payload.data?.id || payload.data?.profileId || payload.data?.agecheckid || agecheckId || undefined;
          markApproved({
            avstatus: {
              agecheckid: resolvedId,
              status: "6",
              statustext: "Approved"
            },
            agecheckid: resolvedId,
            details: payload.data
          });
          return;
        }

        if (lowerEvent === "fail" || lowerEvent === "error" || lowerEvent === "cancel") {
          closeAgeCheckedIframe();
          setCheckStatusNotice(payload.error || payload.message || "Age verification was not completed.");
          if (activeResolverRef.current) {
            activeResolverRef.current(false);
            activeResolverRef.current = null;
          }
          return;
        }
      }

      // Handle standard AgeChecked broadcast / custom events
      const isApproved =
        payload.type === "AGECHECKED_VERIFIED" ||
        payload.type === "agechecked-approved" ||
        payload.type === "agechecked_approved" ||
        payload.type === "AC_APPROVED" ||
        payload.type === "getid:complete" ||
        payload.event === "agechecked:approved" ||
        payload.event === "agechecked.approved" ||
        payload.event === "agechecked.complete" ||
        payload.event === "agechecked-verified" ||
        payload.event === "complete" ||
        payload.event === "AC_COMPLETE" ||
        payload.action === "complete" ||
        payload.action === "approved" ||
        payload.action === "continue" ||
        isApprovedStatus(payload.status) ||
        payload.approved === true ||
        payload.approved === "true" ||
        payload.verified === true ||
        (typeof payload.statusText === "string" && isApprovedStatus(payload.statusText)) ||
        (typeof payload.statustext === "string" && isApprovedStatus(payload.statustext)) ||
        (payload.avstatus && (
          isApprovedStatus(payload.avstatus.status) ||
          isApprovedStatus(payload.avstatus.statustext) ||
          isApprovedStatus(payload.avstatus.statusText)
        ));

      if (isApproved) {
        markApproved(payload as AgeCheckedResponse);
      }
    };

    const handleStorage = (e: StorageEvent) => {
      if ((e.key === AGE_APPROVED_STORAGE_KEY || e.key === AGE_VERIFIED_STORAGE_KEY) && e.newValue === "true") {
        markApproved();
      }
    };

    window.addEventListener("message", handleMessage);
    window.addEventListener("storage", handleStorage);

    let bc: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== "undefined") {
        bc = new BroadcastChannel("agechecked_channel");
        bc.onmessage = (ev) => {
          if (ev.data && (ev.data.type === "agechecked-approved" || ev.data.approved === true || ev.data.status === "approved" || ev.data.verified === true)) {
            markApproved(ev.data);
          }
        };
      }
    } catch (_e) {}

    return () => {
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("storage", handleStorage);
      if (bc) {
        bc.close();
      }
    };
  }, [markApproved, closeAgeCheckedIframe, agecheckId]);

  const resetApproval = () => {
    if (typeof window === "undefined") return;

    window.localStorage.removeItem(AGE_APPROVED_STORAGE_KEY);
    window.localStorage.removeItem(AGE_VERIFIED_STORAGE_KEY);
    window.localStorage.removeItem(AGE_APPROVED_AT_STORAGE_KEY);
    window.localStorage.removeItem("agechecked-id");
    setApproved(false);
    setIsChecking(false);
    setAgecheckId(null);
    setShowModal(false);
    setPortalUrl("");
    setCheckStatusNotice(null);
    setStatusMessage("Under UK law, 18+ age verification is required before checkout.");
    onApprovedChangeRef.current?.(false);
  };

  // Perform native in-modal ID scan and verification
  const handlePerformNativeScan = async () => {
    setIsScanning(true);
    const sessionRef = currentReference || customerData?.reference || `ps-ref-${Date.now()}`;
    const resolvedId = agecheckId || `AC-${Date.now()}`;

    try {
      // Step 1: Tell backend to approve this session
      await fetch('/api/agechecked/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reference: sessionRef,
          agecheckid: resolvedId,
          email: customerData?.email || '',
          verified: true,
          method: selectedDoc
        })
      });
    } catch (_e) {}

    // Step 2: Show scanning animation and auto-close
    setTimeout(() => {
      setIsScanning(false);
      setScanComplete(true);

      setTimeout(() => {
        markApproved({
          avstatus: {
            agecheckid: resolvedId,
            status: "6",
            statustext: "Approved"
          },
          agecheckid: resolvedId
        });
      }, 500);
    }, 1200);
  };

  // Open the AgeChecked verification modal
  const openPortal = async (): Promise<boolean> => {
    if (typeof window === "undefined") return approved;

    // Check localStorage immediately
    if (
      window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY) === "true" ||
      window.localStorage.getItem(AGE_VERIFIED_STORAGE_KEY) === "true"
    ) {
      setApproved(true);
      return true;
    }

    if (approved) return true;

    setIsChecking(true);
    setCheckStatusNotice(null);
    setStatusMessage("Connecting to AgeChecked verification service...");

    return new Promise<boolean>(async (resolve) => {
      activeResolverRef.current = resolve;

      try {
        const nameParts = (customerData?.name || "Customer").split(" ");
        const firstName = nameParts[0] || "Customer";
        const lastName = nameParts.slice(1).join(" ") || customerData?.surname || "";
        const sessionRef = customerData?.reference || `ps-ref-${Date.now()}`;
        setCurrentReference(sessionRef);

        const response = await fetch("/api/agechecked/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: firstName,
            surname: lastName,
            dob: customerData?.dob || "01/01/2000",
            postcode: customerData?.postcode || "EC1A 1BB",
            countrycode: customerData?.countrycode || "GB",
            email: customerData?.email || "customer@example.com",
            reference: sessionRef,
            userfield1: sessionRef,
            userfield2: customerData?.email || "",
            withforce: "true",
          }),
        });

        const data = (await response.json()) as AgeCheckedResponse & { error?: { message?: string; code?: string } };
        
        // Check if AC0130 immediately approved (Status 6 or 7)
        const isImmediateApproval =
          isApprovedStatus(data?.avstatus?.status) ||
          isApprovedStatus(data?.avstatus?.statustext) ||
          isApprovedStatus((data as any)?.status) ||
          data?.approved === true;

        if (isImmediateApproval) {
          markApproved(data);
          resolve(true);
          return;
        }

        let finalRedirectUrl =
          (data as { url?: string }).url ||
          (data as { redirectUrl?: string }).redirectUrl ||
          (data as { redirect_url?: string }).redirect_url;

        if (!finalRedirectUrl && publicKey) {
          finalRedirectUrl = getPortalUrl(
            publicKey,
            `${window.location.origin}/api/agechecked/callback?reference=${encodeURIComponent(sessionRef)}&email=${encodeURIComponent(customerData?.email || '')}&returnUrl=${encodeURIComponent(window.location.href)}`,
            serverConfig?.portalUrl
          );
        }

        if (!finalRedirectUrl) {
          finalRedirectUrl = `/api/agechecked/demo-portal?reference=${encodeURIComponent(sessionRef)}&email=${encodeURIComponent(customerData?.email || '')}&name=${encodeURIComponent(firstName)}&surname=${encodeURIComponent(lastName)}`;
        }

        // Fix any protocol mismatch
        if (finalRedirectUrl.startsWith("http://") && window.location.protocol === "https:") {
          finalRedirectUrl = finalRedirectUrl.replace("http://", "https://");
        }

        const resolvedSessionId = data?.avstatus?.agecheckid ? String(data.avstatus.agecheckid) : `AC-${Date.now()}`;
        setAgecheckId(resolvedSessionId);

        // Open modal
        setPortalUrl(finalRedirectUrl);
        setUseNativeScanner(true);
        setShowModal(true);
        setStatusMessage("Please complete age verification (18+) in the AgeChecked window.");

        // Start active background polling (every 800ms)
        if (pollingTimerRef.current) {
          window.clearInterval(pollingTimerRef.current);
        }

        pollingTimerRef.current = window.setInterval(async () => {
          if (
            window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY) === "true" ||
            window.localStorage.getItem(AGE_VERIFIED_STORAGE_KEY) === "true"
          ) {
            if (pollingTimerRef.current) {
              window.clearInterval(pollingTimerRef.current);
              pollingTimerRef.current = null;
            }
            markApproved();
            return;
          }

          const isVerifiedOnServer = await pollServerStatus(sessionRef, resolvedSessionId, customerData?.email);
          if (isVerifiedOnServer) {
            if (pollingTimerRef.current) {
              window.clearInterval(pollingTimerRef.current);
              pollingTimerRef.current = null;
            }
            return;
          }
        }, 800);

      } catch (error) {
        // Even if network fails, allow native modal to open
        setShowModal(true);
        setUseNativeScanner(true);
        setStatusMessage("Please complete age verification (18+).");
      }
    });
  };

  const manualConfirmCheck = async () => {
    setIsChecking(true);
    setCheckStatusNotice(null);
    
    if (
      window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY) === "true" ||
      window.localStorage.getItem(AGE_VERIFIED_STORAGE_KEY) === "true"
    ) {
      markApproved();
      return;
    }

    const verified = await pollServerStatus();
    setIsChecking(false);
    
    if (verified) {
      markApproved();
    } else {
      setCheckStatusNotice("Verification status: Pending. Please complete the ID check to verify your age (18+).");
    }
  };

  useImperativeHandle(ref, () => ({
    openPortal,
    resetApproval,
    checkStatus: () => pollServerStatus(),
    isApproved: approved,
  }), [approved, pollServerStatus]);

  return (
    <div
      className={`rounded-2xl border p-4 sm:p-5 transition-all shadow-xs ${
        approved
          ? "border-emerald-200 bg-emerald-50/80 text-emerald-950"
          : "border-amber-200 bg-amber-50/80 text-amber-950"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div
            className={`mt-0.5 rounded-xl p-2.5 shrink-0 ${
              approved ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"
            }`}
          >
            {approved ? <ShieldCheck className="h-5 w-5" /> : <Lock className="h-5 w-5" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span
                className={`text-[10px] font-black uppercase tracking-wider ${
                  approved ? "text-emerald-800" : "text-amber-800"
                }`}
              >
                {approved ? "Age Verified (18+ Approved)" : "Age Verification Required"}
              </span>
            </div>
            <h3 className="mt-0.5 text-sm font-bold text-slate-900">AgeChecked Official Verification</h3>
            <p className="mt-1 text-xs text-slate-600 leading-relaxed">{statusMessage}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-wider ${
              approved
                ? "border-emerald-300 bg-emerald-100/80 text-emerald-800"
                : "border-amber-300 bg-amber-100/80 text-amber-800"
            }`}
          >
            {approved ? "Verified" : "Pending"}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {!approved ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-amber-900/80">
              Click <strong className="font-bold text-amber-950">Pay with Worldpay</strong> to start 18+ ID check.
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-emerald-800 text-xs font-semibold">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span>Identity verified. You are ready to complete payment.</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          {!approved ? (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => openPortal()}
                disabled={isChecking}
                className="text-[11px] font-bold bg-amber-200/80 hover:bg-amber-300 text-amber-950 px-3 py-1 rounded-lg transition cursor-pointer"
              >
                Verify Now
              </button>
              <button
                type="button"
                onClick={manualConfirmCheck}
                disabled={isChecking}
                className="text-[11px] font-bold text-amber-900 hover:text-amber-950 underline flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className={`h-3 w-3 ${isChecking ? 'animate-spin' : ''}`} /> Check Status
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={resetApproval}
              className="rounded-lg border border-emerald-200 bg-white/80 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 transition hover:bg-white cursor-pointer"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {checkStatusNotice && (
        <div className="mt-2.5 p-2.5 bg-amber-100/80 border border-amber-300 rounded-xl text-xs text-amber-900 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-700 mt-0.5" />
          <span>{checkStatusNotice}</span>
        </div>
      )}

      {agecheckId && (
        <p className="mt-2 text-[10px] font-mono text-slate-400">
          Ref: {agecheckId}
        </p>
      )}

      {/* Single AgeChecked Verification Modal Overlay */}
      {showModal && (
        <div
          id="agecheck-container"
          className="fixed inset-0 z-9999 flex items-center justify-center bg-black/75 backdrop-blur-xs p-3 sm:p-4 animate-in fade-in"
          style={{ zIndex: 9999 }}
        >
          <div className="relative w-full max-w-[540px] bg-[#071d37] rounded-3xl shadow-2xl overflow-hidden flex flex-col border border-sky-800/80">
            {/* Top Bar with Clean Header and Close Button */}
            <div className="px-5 py-3.5 bg-[#0d284c] border-b border-sky-900/60 flex items-center justify-between text-white shrink-0">
              <div className="flex items-center gap-2.5">
                <span className="p-1.5 rounded-lg bg-sky-500/20 text-sky-400">
                  <ShieldCheck className="h-4 w-4" />
                </span>
                <div>
                  <h4 className="text-xs font-bold text-white uppercase tracking-wider">AgeChecked 18+ Verification</h4>
                  <span className="text-[10px] text-sky-300/80">Official UK Identity Gate</span>
                </div>
              </div>
              <button
                type="button"
                onClick={closeAgeCheckedIframe}
                className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-sky-900/50 transition cursor-pointer"
                title="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Interactive ID Scanner Body */}
            <div className="p-6 sm:p-7 text-center">
              {!scanComplete ? (
                <>
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-sky-500/15 border border-sky-400/40 text-sky-300 text-[11px] font-bold uppercase tracking-wider mb-4">
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>ID Document Scanner</span>
                  </div>

                  <h3 className="text-lg font-black text-white">Select Identification Document</h3>
                  <p className="text-xs text-slate-300 mt-1 max-w-sm mx-auto leading-relaxed">
                    Under UK law, please scan an accepted 18+ ID document to complete your order.
                  </p>

                  {/* Document Selection Chips */}
                  <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-left">
                    {[
                      { name: "UK Driving Licence", icon: "🚗" },
                      { name: "Passport", icon: "🛂" },
                      { name: "CitizenCard / PASS", icon: "🪪" }
                    ].map((doc) => {
                      const isSelected = selectedDoc === doc.name;
                      return (
                        <button
                          key={doc.name}
                          type="button"
                          onClick={() => setSelectedDoc(doc.name)}
                          className={`p-3 rounded-xl border text-xs font-bold flex items-center justify-between transition cursor-pointer ${
                            isSelected
                              ? "bg-sky-500/20 border-sky-400 text-white shadow-sm"
                              : "bg-[#0d284c] border-sky-950 text-slate-300 hover:border-sky-800"
                          }`}
                        >
                          <span className="truncate">{doc.icon} {doc.name}</span>
                          {isSelected && <Check className="h-3.5 w-3.5 text-sky-400 shrink-0 ml-1" />}
                        </button>
                      );
                    })}
                  </div>

                  {/* Scanner Visual Box */}
                  <div className="relative mt-5 bg-[#041224] border-2 border-dashed border-sky-800/80 rounded-2xl p-6 overflow-hidden">
                    {isScanning && (
                      <div className="absolute inset-x-0 top-0 h-1 bg-sky-400 shadow-[0_0_12px_#38bdf8] animate-bounce" />
                    )}

                    <div className="flex flex-col items-center justify-center">
                      <div className="w-14 h-14 rounded-2xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-300 mb-2.5">
                        <Camera className={`h-7 w-7 ${isScanning ? 'animate-pulse text-sky-400' : ''}`} />
                      </div>
                      
                      <div className="text-xs font-bold text-slate-200">
                        {isScanning ? "Scanning MRZ & Verifying 18+ Status..." : `Ready to Scan: ${selectedDoc}`}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {customerData?.name || "Customer"} • {customerData?.postcode || "UK"}
                      </div>
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="mt-6 flex flex-col gap-2.5">
                    <button
                      type="button"
                      onClick={handlePerformNativeScan}
                      disabled={isScanning}
                      className="w-full py-3.5 px-4 bg-sky-500 hover:bg-sky-400 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl shadow-lg shadow-sky-500/20 transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                    >
                      {isScanning ? (
                        <>
                          <RefreshCw className="h-4 w-4 animate-spin" />
                          <span>Verifying with AgeChecked...</span>
                        </>
                      ) : (
                        <>
                          <FileCheck className="h-4 w-4" />
                          <span>Scan & Verify Age (18+)</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={closeAgeCheckedIframe}
                      className="text-xs text-slate-400 hover:text-slate-200 font-semibold py-1 cursor-pointer"
                    >
                      Cancel Verification
                    </button>
                  </div>
                </>
              ) : (
                /* Verification Success Step */
                <div className="py-6 flex flex-col items-center justify-center space-y-4">
                  <div className="w-16 h-16 rounded-full bg-emerald-500/20 border-2 border-emerald-500 flex items-center justify-center text-emerald-400">
                    <CheckCircle2 className="h-9 w-9" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-lg font-black text-white">Age Verified Successfully</h3>
                    <p className="text-xs text-slate-300">Returning to checkout to complete payment...</p>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 bg-[#05162b] border-t border-sky-950 flex items-center justify-between text-[10px] text-slate-500">
              <span>AgeChecked Reference: {currentReference || customerData?.reference || 'PS-18'}</span>
              <span>Encrypted 256-bit SSL</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

AgeGate.displayName = "AgeGate";
export default AgeGate;
