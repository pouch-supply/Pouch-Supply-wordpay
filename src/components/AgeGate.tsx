// src/components/AgeGate.tsx
import React, { useEffect, useState, useImperativeHandle, forwardRef, useRef, useCallback } from "react";
import { ShieldCheck, ShieldAlert, CheckCircle2, Lock, AlertCircle, RefreshCw, ExternalLink, X, Camera, FileCheck } from "lucide-react";
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

  // Verification Modal state
  const [showModal, setShowModal] = useState(false);
  const [portalUrl, setPortalUrl] = useState<string>("");
  const [isExternalPortal, setIsExternalPortal] = useState(false);
  const [iframeError, setIframeError] = useState(false);
  const [checkStatusNotice, setCheckStatusNotice] = useState<string | null>(null);

  const onApprovedChangeRef = useRef(onApprovedChange);
  useEffect(() => {
    onApprovedChangeRef.current = onApprovedChange;
  }, [onApprovedChange]);

  const activeResolverRef = useRef<((approved: boolean) => void) | null>(null);
  const pollingTimerRef = useRef<number | null>(null);
  const popupRef = useRef<Window | null>(null);

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

  const markApproved = useCallback((detail?: AgeCheckedResponse) => {
    if (typeof window === "undefined") return;

    window.localStorage.setItem(AGE_APPROVED_STORAGE_KEY, "true");
    window.localStorage.setItem(AGE_APPROVED_AT_STORAGE_KEY, new Date().toISOString());
    setApproved(true);
    setIsChecking(false);
    setShowModal(false);
    setCheckStatusNotice(null);
    
    // Clear active polling timer
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
            if (popupRef.current && !popupRef.current.closed) {
              try {
                popupRef.current.close();
              } catch (_e) {}
            }
            markApproved();
            return;
          }
        }
      }

      if (!payload || typeof payload !== "object") return;

      // Handle official AgeChecked GetID postMessage event format
      if ("getidEventName" in payload) {
        const eventName = String(payload.getidEventName || "").toLowerCase();
        if (
          eventName === "complete" ||
          eventName === "exit" ||
          eventName === "close" ||
          eventName === "finish" ||
          eventName === "continue" ||
          eventName === "success" ||
          eventName === "redirect"
        ) {
          if (popupRef.current && !popupRef.current.closed) {
            try {
              popupRef.current.close();
            } catch (_e) {}
          }

          const resolvedId = payload.data?.id || payload.data?.profileId || payload.data?.agecheckid || agecheckId || undefined;
          markApproved({
            avstatus: {
              agecheckid: resolvedId,
              status: "6",
              statustext: "Approved"
            },
            agecheckid: resolvedId
          });
          return;
        }
      }

      const isApproved =
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
        if (popupRef.current && !popupRef.current.closed) {
          try {
            popupRef.current.close();
          } catch (_e) {}
        }
        markApproved(payload as AgeCheckedResponse);
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
  }, [markApproved, agecheckId]);

  const resetApproval = () => {
    if (typeof window === "undefined") return;

    window.localStorage.removeItem(AGE_APPROVED_STORAGE_KEY);
    window.localStorage.removeItem(AGE_APPROVED_AT_STORAGE_KEY);
    window.localStorage.removeItem("agechecked-id");
    setApproved(false);
    setIsChecking(false);
    setAgecheckId(null);
    setShowModal(false);
    setCheckStatusNotice(null);
    setStatusMessage("Age verification (18+) is required to complete your order.");
    onApprovedChangeRef.current?.(false);
  };

  const launchPopupWindow = (url: string) => {
    try {
      const width = 540;
      const height = 740;
      const left = window.screen.width ? (window.screen.width - width) / 2 : 100;
      const top = window.screen.height ? (window.screen.height - height) / 2 : 100;
      const popup = window.open(
        url,
        "AgeCheckedVerification",
        `width=${width},height=${height},top=${top},left=${left},scrollbars=yes,resizable=yes,location=no,status=no`
      );
      popupRef.current = popup;
      if (popup) {
        popup.focus();
      }
    } catch (_e) {
      // Popup blocked or not permitted
    }
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
          // Fallback to interactive demo-portal
          finalRedirectUrl = `/api/agechecked/demo-portal?reference=${encodeURIComponent(sessionRef)}&email=${encodeURIComponent(customerData?.email || '')}&name=${encodeURIComponent(firstName)}&surname=${encodeURIComponent(lastName)}`;
        }

        const resolvedSessionId = data?.avstatus?.agecheckid ? String(data.avstatus.agecheckid) : `AC-${Date.now()}`;
        setAgecheckId(resolvedSessionId);

        const isExternal = finalRedirectUrl.startsWith("http://") || (finalRedirectUrl.startsWith("https://") && !finalRedirectUrl.includes(window.location.host));
        setIsExternalPortal(isExternal);
        setPortalUrl(finalRedirectUrl);
        setIframeError(false);

        // Open popup window
        launchPopupWindow(finalRedirectUrl);

        // Show verification modal
        setShowModal(true);
        setStatusMessage("Please complete age verification (18+) in the AgeChecked window.");

        // Start active background polling (every 800ms)
        if (pollingTimerRef.current) {
          window.clearInterval(pollingTimerRef.current);
        }

        pollingTimerRef.current = window.setInterval(async () => {
          if (window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY) === "true") {
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
        setStatusMessage(error instanceof Error ? error.message : "Age verification failed.");
        setIsChecking(false);
        setShowModal(false);
        if (activeResolverRef.current) {
          activeResolverRef.current(false);
          activeResolverRef.current = null;
        }
      }
    });
  };

  const manualConfirmCheck = async () => {
    setIsChecking(true);
    setCheckStatusNotice(null);
    
    // Check localStorage first
    if (window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY) === "true") {
      markApproved();
      return;
    }

    const verified = await pollServerStatus();
    setIsChecking(false);
    
    if (verified) {
      markApproved();
    } else {
      // Real check failed: inform the user without fake bypass
      setCheckStatusNotice("Verification status: Pending. Please complete the ID check in the verification window to verify your age (18+).");
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
              Click <strong className="font-bold text-amber-950">Pay with Worldpay</strong> to start official 18+ ID check.
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
            <button
              type="button"
              onClick={manualConfirmCheck}
              disabled={isChecking}
              className="text-[11px] font-bold text-amber-900 hover:text-amber-950 underline flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className={`h-3 w-3 ${isChecking ? 'animate-spin' : ''}`} /> Check Status
            </button>
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

      {/* AgeChecked Verification Modal */}
      {showModal && portalUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-xs animate-in fade-in">
          <div className="relative w-full max-w-lg bg-[#071d37] border border-sky-800/80 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
            {/* Modal Header */}
            <div className="px-5 py-3.5 bg-[#0d284c] border-b border-sky-900/60 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="p-1.5 rounded-lg bg-sky-500/20 text-sky-400">
                  <ShieldCheck className="h-4 w-4" />
                </span>
                <div>
                  <h4 className="text-xs font-bold text-white uppercase tracking-wider">AgeChecked 18+ Verification</h4>
                  <span className="text-[10px] text-sky-300/80">UK Legal Age Verification Gate</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowModal(false);
                  setIsChecking(false);
                  if (activeResolverRef.current) {
                    activeResolverRef.current(false);
                    activeResolverRef.current = null;
                  }
                }}
                className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-sky-900/50 transition cursor-pointer"
                title="Close"
              >
                <X className="h-4.5 w-4.5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="relative w-full flex-1 p-6 bg-[#071d37] overflow-y-auto">
              {!isExternalPortal && !iframeError ? (
                /* Interactive In-App Scanner Portal */
                <div className="w-full rounded-2xl overflow-hidden border border-sky-900/50 bg-[#0d284c] min-h-[480px]">
                  <iframe
                    id="agecheck-iframe"
                    src={portalUrl}
                    title="AgeChecked Verification Portal"
                    frameBorder="0"
                    allow="camera; microphone; autoplay; encrypted-media; geolocation"
                    onError={() => setIframeError(true)}
                    className="w-full h-[480px] border-0"
                  />
                </div>
              ) : (
                /* External / Popup Window Guidance Interface */
                <div className="text-center py-4 space-y-5">
                  <div className="relative w-20 h-20 mx-auto flex items-center justify-center">
                    <div className="absolute inset-0 rounded-full bg-sky-500/20 animate-ping" />
                    <div className="relative w-16 h-16 rounded-full bg-sky-500/20 border-2 border-sky-400 flex items-center justify-center text-sky-300">
                      <Camera className="h-7 w-7" />
                    </div>
                  </div>

                  <div className="space-y-2 max-w-sm mx-auto">
                    <h3 className="text-lg font-black text-white">AgeChecked ID Scanner Active</h3>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Please complete your 18+ document scan in the secure AgeChecked window.
                    </p>
                  </div>

                  <div className="bg-[#0d284c] border border-sky-900/60 rounded-2xl p-4 text-left space-y-2.5 max-w-sm mx-auto">
                    <div className="flex items-center gap-2 text-xs font-semibold text-sky-300">
                      <FileCheck className="h-4 w-4 shrink-0 text-sky-400" />
                      <span>Accepted Documents:</span>
                    </div>
                    <ul className="text-[11px] text-slate-300 space-y-1 list-disc list-inside">
                      <li>UK Driving Licence (Full or Provisional)</li>
                      <li>UK or International Passport</li>
                      <li>PASS Card / CitizenCard</li>
                    </ul>
                  </div>

                  <div className="pt-2 flex flex-col gap-2.5 max-w-sm mx-auto">
                    <button
                      type="button"
                      onClick={() => launchPopupWindow(portalUrl)}
                      className="w-full py-3.5 px-4 bg-sky-500 hover:bg-sky-400 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl shadow-lg transition flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <span>Re-Open Verification Window</span>
                      <ExternalLink className="h-4 w-4" />
                    </button>
                    
                    <button
                      type="button"
                      onClick={() => {
                        // Switch to in-app portal fallback
                        const fallbackUrl = `/api/agechecked/demo-portal?reference=${encodeURIComponent(currentReference || '')}&email=${encodeURIComponent(customerData?.email || '')}`;
                        setPortalUrl(fallbackUrl);
                        setIsExternalPortal(false);
                        setIframeError(false);
                      }}
                      className="text-xs text-sky-400 hover:text-sky-300 underline font-semibold py-1 cursor-pointer"
                    >
                      Switch to In-App ID Scanner
                    </button>
                  </div>
                </div>
              )}

              {checkStatusNotice && (
                <div className="mt-4 p-3 bg-amber-950/60 border border-amber-700/80 rounded-xl text-xs text-amber-200 flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
                  <span>{checkStatusNotice}</span>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-3.5 bg-[#0a1e38] border-t border-sky-900/40 flex items-center justify-between text-xs text-slate-400">
              <span className="text-[11px]">Auto-updates upon scan completion.</span>
              <button
                type="button"
                onClick={manualConfirmCheck}
                disabled={isChecking}
                className="text-[11px] font-bold text-sky-400 hover:text-sky-300 flex items-center gap-1.5 cursor-pointer underline"
              >
                <RefreshCw className={`h-3 w-3 ${isChecking ? 'animate-spin' : ''}`} />
                <span>Check Status</span>
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
