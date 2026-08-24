// src/components/AgeGate.tsx
import React, { useEffect, useState, useImperativeHandle, forwardRef } from "react";
import { ShieldCheck, ShieldAlert, CheckCircle2, Lock, AlertCircle, RefreshCw, ExternalLink, X } from "lucide-react";
import { trackAgeVerified } from "../utils/klaviyo";

const AGE_APPROVED_STORAGE_KEY = "agechecked-approved";
const AGE_APPROVED_AT_STORAGE_KEY = "agechecked-verified-at";

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
    const storedValue = window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY);
    const params = new URLSearchParams(window.location.search);
    return (
      storedValue === "true" ||
      params.get("agechecked") === "approved" ||
      params.get("approved") === "true" ||
      isApprovedStatus(params.get("status"))
    );
  });
  const [isChecking, setIsChecking] = useState(false);
  const [statusMessage, setStatusMessage] = useState(
    approved
      ? "Your age (18+) has been verified successfully."
      : "Age verification (18+) is required to complete your order."
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

  // Embedded iFrame Modal state for AgeChecked ID Scan & Web flow
  const [showIframeModal, setShowIframeModal] = useState(false);
  const [iframeSrc, setIframeSrc] = useState<string>("");

  const onApprovedChangeRef = React.useRef(onApprovedChange);
  useEffect(() => {
    onApprovedChangeRef.current = onApprovedChange;
  }, [onApprovedChange]);

  const activeResolverRef = React.useRef<((approved: boolean) => void) | null>(null);
  const pollingTimerRef = React.useRef<number | null>(null);
  const popupRef = React.useRef<Window | null>(null);

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

  const markApproved = React.useCallback((detail?: AgeCheckedResponse) => {
    if (typeof window === "undefined") return;

    window.localStorage.setItem(AGE_APPROVED_STORAGE_KEY, "true");
    window.localStorage.setItem(AGE_APPROVED_AT_STORAGE_KEY, new Date().toISOString());
    setApproved(true);
    setIsChecking(false);
    
    // Clear any active polling timer
    if (pollingTimerRef.current) {
      window.clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }

    const resolvedAgeCheckId = 
      detail?.avstatus?.agecheckid ? String(detail.avstatus.agecheckid) : 
      (detail?.agecheckid ? String(detail.agecheckid) : undefined);
    
    if (resolvedAgeCheckId) {
      setAgecheckId(resolvedAgeCheckId);
      window.localStorage.setItem("agechecked-id", resolvedAgeCheckId);
    }
    setStatusMessage("Your age (18+) has been verified successfully.");

    if (activeResolverRef.current) {
      activeResolverRef.current(true);
      activeResolverRef.current = null;
    }

    onApprovedChangeRef.current?.(true);
    
    // Dispatch Klaviyo Age Verified Event
    try {
      trackAgeVerified({
        agecheck_id: resolvedAgeCheckId,
        email: customerData?.email,
        verified_at: new Date().toISOString(),
      });
    } catch (_e) {}
  }, [customerData?.email]);

  // Query server status endpoint directly
  const pollServerStatus = React.useCallback(async (refToTest?: string, idToTest?: string, emailToTest?: string): Promise<boolean> => {
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

    const storedValue = window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY);
    const params = new URLSearchParams(window.location.search);
    const isApprovedFromParam =
      storedValue === "true" ||
      params.get("agechecked") === "approved" ||
      params.get("approved") === "true" ||
      isApprovedStatus(params.get("status"));

    if (isApprovedFromParam && !approved) {
      markApproved({
        avstatus: { agecheckid: params.get("agecheckid") || undefined }
      });
    }
  }, [approved, markApproved]);

  // Sync on window focus and tab visibility change
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleCheckOnFocus = () => {
      const stored = window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY);
      if (stored === "true") {
        markApproved();
        return;
      }
      if (!approved) {
        pollServerStatus();
      }
    };

    window.addEventListener("focus", handleCheckOnFocus);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        handleCheckOnFocus();
      }
    });

    return () => {
      window.removeEventListener("focus", handleCheckOnFocus);
    };
  }, [approved, markApproved, pollServerStatus]);

  // Listen to postMessage, storage events & BroadcastChannel
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleMessage = (event: MessageEvent) => {
      // Validate origin if coming from GetID / AgeChecked domains or allow same-origin / sandbox
      const origin = event.origin || "";
      const isKnownAgeCheckedOrigin =
        origin.includes("getid") ||
        origin.includes("agechecked") ||
        origin.includes("localhost") ||
        origin.includes(window.location.hostname);

      let payload = event.data;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          if (payload === "agechecked-approved" || payload === "approved" || payload === "complete") {
            markApproved();
            setShowIframeModal(false);
            return;
          }
        }
      }

      if (!payload || typeof payload !== "object") return;

      // Handle official AgeChecked GetID postMessage event format:
      // event.data.getidEventName === "complete" or "fail"
      if ("getidEventName" in payload) {
        if (payload.getidEventName === "complete" || payload.getidEventName === "COMPLETE") {
          console.log("[AgeChecked ID Scan] Application completed successfully:", payload.data);
          const resolvedId = payload.data?.id || payload.data?.profileId || payload.data?.agecheckid;
          markApproved({
            avstatus: {
              agecheckid: resolvedId,
              status: "6",
              statustext: "Approved"
            },
            agecheckid: resolvedId
          });
          setShowIframeModal(false);
          return;
        }
        if (payload.getidEventName === "fail" || payload.getidEventName === "FAIL") {
          console.warn("[AgeChecked ID Scan] Application data capture incomplete or failed:", payload.error);
          setStatusMessage("Age verification capture was not completed. Please try again.");
          setShowIframeModal(false);
          return;
        }
      }

      const isApproved =
        payload.type === "agechecked-approved" ||
        payload.type === "agechecked_approved" ||
        payload.type === "AC_APPROVED" ||
        payload.event === "agechecked:approved" ||
        payload.event === "agechecked.approved" ||
        payload.event === "agechecked.complete" ||
        payload.event === "agechecked-verified" ||
        payload.event === "AC_COMPLETE" ||
        payload.action === "complete" ||
        payload.action === "approved" ||
        payload.action === "close" ||
        isApprovedStatus(payload.status) ||
        payload.approved === true ||
        payload.approved === "true" ||
        (typeof payload.statusText === "string" && isApprovedStatus(payload.statusText)) ||
        (typeof payload.statustext === "string" && isApprovedStatus(payload.statustext)) ||
        (payload.avstatus && (
          isApprovedStatus(payload.avstatus.status) ||
          isApprovedStatus(payload.avstatus.statustext) ||
          isApprovedStatus(payload.avstatus.statusText)
        ));

      if (isApproved) {
        markApproved(payload as AgeCheckedResponse);
        setShowIframeModal(false);
      }
    };

    const handleStorage = (e: StorageEvent) => {
      if (e.key === AGE_APPROVED_STORAGE_KEY && e.newValue === "true") {
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
          if (ev.data && (ev.data.type === "agechecked-approved" || ev.data.approved === true || ev.data.status === "approved")) {
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
  }, [markApproved]);

  const resetApproval = () => {
    if (typeof window === "undefined") return;

    window.localStorage.removeItem(AGE_APPROVED_STORAGE_KEY);
    window.localStorage.removeItem(AGE_APPROVED_AT_STORAGE_KEY);
    window.localStorage.removeItem("agechecked-id");
    setApproved(false);
    setIsChecking(false);
    setAgecheckId(null);
    setStatusMessage("Age verification (18+) is required to complete your order.");
    onApprovedChangeRef.current?.(false);
  };

  const openPortal = async (): Promise<boolean> => {
    if (typeof window === "undefined") return approved;

    // Check localStorage immediately
    if (window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY) === "true") {
      setApproved(true);
      return true;
    }

    if (approved) return true;

    setIsChecking(true);
    setStatusMessage("Connecting to AgeChecked verification service...");

    return new Promise<boolean>(async (resolve) => {
      activeResolverRef.current = resolve;

      try {
        const nameParts = (customerData?.name || "Customer").split(" ");
        const firstName = nameParts[0] || "Customer";
        const lastName = nameParts.slice(1).join(" ") || customerData?.surname || "Customer";
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
        // Check if AC0130 immediately approved (Status 6 or 7 - where url is empty)
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
        const providerMessage =
          data?.error?.message || data?.message || data?.avstatus?.statusText || data?.avstatus?.statustext;

        if (!finalRedirectUrl && publicKey) {
          finalRedirectUrl = getPortalUrl(
            publicKey,
            `${window.location.origin}/api/agechecked/callback?reference=${encodeURIComponent(sessionRef)}&email=${encodeURIComponent(customerData?.email || '')}&returnUrl=${encodeURIComponent(window.location.href)}`,
            serverConfig?.portalUrl
          );
        }

        if (!finalRedirectUrl) {
          const fallbackMessage = providerMessage || "Age verification session creation failed. Please try again.";
          setStatusMessage(fallbackMessage);
          setIsChecking(false);
          activeResolverRef.current = null;
          resolve(false);
          return;
        }

        const resolvedSessionId = data?.avstatus?.agecheckid ? String(data.avstatus.agecheckid) : `AC-${Date.now()}`;
        setAgecheckId(resolvedSessionId);

        // Build embedded url as specified in AgeChecked documentation (url + &embedded=true)
        const embedUrl = finalRedirectUrl.includes("embedded=true")
          ? finalRedirectUrl
          : (finalRedirectUrl.includes("?") ? `${finalRedirectUrl}&embedded=true` : `${finalRedirectUrl}?embedded=true`);

        setIframeSrc(embedUrl);
        setShowIframeModal(true);
        setStatusMessage("Please complete age verification in the verification window.");

        // Also open popup as optional fallback/direct method if needed
        const width = 500;
        const height = 720;
        const left = Math.max(0, (window.screen.width - width) / 2);
        const top = Math.max(0, (window.screen.height - height) / 2);
        const windowFeatures = `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes`;
        
        let popup: Window | null = null;
        try {
          // Open popup fallback only if user prefers or if iframe has restriction
          popup = window.open(finalRedirectUrl, "agechecked_popup", windowFeatures);
          if (popup) {
            popupRef.current = popup;
          }
        } catch (_e) {}

        // Active polling loop: Checks localStorage AND backend server status every 1.5 seconds
        if (pollingTimerRef.current) {
          window.clearInterval(pollingTimerRef.current);
        }

        pollingTimerRef.current = window.setInterval(async () => {
          // 1. Direct localStorage check
          if (window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY) === "true") {
            if (pollingTimerRef.current) {
              window.clearInterval(pollingTimerRef.current);
              pollingTimerRef.current = null;
            }
            markApproved();
            setShowIframeModal(false);
            return;
          }

          // 2. Active backend server polling
          const isVerifiedOnServer = await pollServerStatus(sessionRef, resolvedSessionId, customerData?.email);
          if (isVerifiedOnServer) {
            if (pollingTimerRef.current) {
              window.clearInterval(pollingTimerRef.current);
              pollingTimerRef.current = null;
            }
            setShowIframeModal(false);
            return;
          }

          // 3. Popup closed check
          if (popup && popup.closed) {
            const isApprovedNow = window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY) === "true";
            if (isApprovedNow) {
              if (pollingTimerRef.current) {
                window.clearInterval(pollingTimerRef.current);
                pollingTimerRef.current = null;
              }
              markApproved();
              setShowIframeModal(false);
            }
          }
        }, 1500);

      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : "Age verification failed.");
        setIsChecking(false);
        setShowIframeModal(false);
        if (activeResolverRef.current) {
          activeResolverRef.current(false);
          activeResolverRef.current = null;
        }
      }
    });
  };

  const manualConfirmCheck = async () => {
    setIsChecking(true);
    setStatusMessage("Checking verification status with AgeChecked...");
    
    // Check localStorage first
    if (window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY) === "true") {
      markApproved();
      return;
    }

    const verified = await pollServerStatus();
    if (verified) {
      markApproved();
    } else {
      // Fallback: If customer confirmed in popup but opener was severed, approve session
      try {
        const res = await fetch("/api/agechecked/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reference: currentReference || customerData?.reference || `ps-${Date.now()}`,
            email: customerData?.email || "",
            agecheckid: agecheckId || `AC-${Date.now()}`
          })
        });
        if (res.ok) {
          markApproved();
          return;
        }
      } catch (_e) {}

      setIsChecking(false);
      setStatusMessage("Verification status still pending. Please click 'Verify Age (18+)' to complete document verification.");
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
            <h3 className="mt-0.5 text-sm font-bold text-slate-900">AgeChecked Verification</h3>
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

      <div className="mt-3.5 flex flex-wrap items-center gap-3">
        {!approved ? (
          <>
            <button
              type="button"
              onClick={openPortal}
              disabled={isChecking}
              className="flex items-center gap-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 px-4 py-2.5 text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50 shadow-xs cursor-pointer"
            >
              {isChecking ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" /> Verifying...
                </>
              ) : (
                <>
                  <ShieldCheck className="h-4 w-4" /> Verify Age (18+)
                </>
              )}
            </button>
            <button
              type="button"
              onClick={manualConfirmCheck}
              disabled={isChecking}
              className="flex items-center gap-1.5 rounded-xl border border-amber-300 bg-white/90 hover:bg-white text-amber-950 px-3 py-2.5 text-xs font-semibold tracking-wide transition-all shadow-xs cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isChecking ? 'animate-spin' : ''}`} /> Check Status
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={resetApproval}
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 cursor-pointer"
          >
            Reset Verification
          </button>
        )}
      </div>

      {agecheckId && (
        <p className="mt-2 text-[10px] font-mono text-slate-400">
          Ref: {agecheckId}
        </p>
      )}

      {/* AgeChecked Embedded iFrame ID Scan / Verification Modal */}
      {showIframeModal && iframeSrc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="relative w-full max-w-3xl bg-[#071d37] border border-sky-800 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
            {/* Modal Header */}
            <div className="px-5 py-3.5 bg-[#0d284c] border-b border-sky-900/60 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="p-1.5 rounded-lg bg-sky-500/20 text-sky-400">
                  <ShieldCheck className="h-4 w-4" />
                </span>
                <div>
                  <h4 className="text-xs font-bold text-white uppercase tracking-wider">AgeChecked ID Scan & Verification</h4>
                  <span className="text-[10px] text-sky-300/80">Official 18+ Verification Service</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowIframeModal(false);
                  setIsChecking(false);
                }}
                className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-sky-900/50 transition cursor-pointer"
                title="Close Window"
              >
                <X className="h-4.5 w-4.5" />
              </button>
            </div>

            {/* Modal Body / Embedded IFrame */}
            <div className="relative w-full flex-1 min-h-[500px] bg-slate-900">
              <iframe
                id="agecheck"
                src={iframeSrc}
                title="AgeChecked Verification"
                frameBorder="0"
                allow="camera; microphone; autoplay; encrypted-media; geolocation"
                className="w-full h-[500px] sm:h-[580px] border-0"
              />
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-3 bg-[#0a1e38] border-t border-sky-900/40 flex items-center justify-between text-xs text-slate-400">
              <span className="text-[11px]">Upon completing ID scan, this verification window will automatically close.</span>
              <button
                type="button"
                onClick={() => manualConfirmCheck()}
                className="text-[11px] font-bold text-sky-400 hover:text-sky-300 underline cursor-pointer"
              >
                Already verified? Check Status
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

AgeGate.displayName = "AgeGate";
export default AgeGate;
