// src/components/AgeGate.tsx
import React, { useEffect, useState, useImperativeHandle, forwardRef } from "react";
import { ShieldCheck, ShieldAlert, CheckCircle2, Lock, AlertCircle, RefreshCw, ExternalLink } from "lucide-react";
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
  return normalized === "approved" || normalized === "true" || normalized === "6" || normalized === "7" || normalized === "pass" || normalized === "verified";
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
  const [serverConfig, setServerConfig] = useState<{ portalUrl?: string; publicKey?: string } | null>(null);

  const onApprovedChangeRef = React.useRef(onApprovedChange);
  useEffect(() => {
    onApprovedChangeRef.current = onApprovedChange;
  }, [onApprovedChange]);

  const activeResolverRef = React.useRef<((approved: boolean) => void) | null>(null);

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

  // Listen to postMessage, storage events & BroadcastChannel
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleMessage = (event: MessageEvent) => {
      let payload = event.data;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          if (payload === "agechecked-approved" || payload === "approved") {
            markApproved();
            return;
          }
        }
      }

      if (!payload || typeof payload !== "object") return;

      const isApproved =
        payload.type === "agechecked-approved" ||
        payload.event === "agechecked:approved" ||
        payload.event === "agechecked-verified" ||
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
            reference: customerData?.reference || `ref-${Date.now()}`,
            withforce: "true",
          }),
        });

        const data = (await response.json()) as AgeCheckedResponse & { error?: { message?: string; code?: string } };
        let finalRedirectUrl =
          (data as { url?: string }).url ||
          (data as { redirectUrl?: string }).redirectUrl ||
          (data as { redirect_url?: string }).redirect_url;
        const providerMessage =
          data?.error?.message || data?.message || data?.avstatus?.statusText || data?.avstatus?.statustext;

        if (!finalRedirectUrl && publicKey) {
          finalRedirectUrl = getPortalUrl(
            publicKey,
            `${window.location.origin}/api/agechecked/callback?returnUrl=${encodeURIComponent(window.location.href)}`,
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

        if (data?.avstatus?.agecheckid) {
          setAgecheckId(String(data.avstatus.agecheckid));
        }
        setStatusMessage("Please complete age verification in the popup window.");

        // Open popup with window.opener intact (no noopener/noreferrer)
        const width = 500;
        const height = 720;
        const left = Math.max(0, (window.screen.width - width) / 2);
        const top = Math.max(0, (window.screen.height - height) / 2);
        const windowFeatures = `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes`;
        
        const popup = window.open(finalRedirectUrl, "agechecked_popup", windowFeatures);
        if (!popup) {
          setStatusMessage("Popup was blocked by your browser. Please allow popups and click Verify Age again.");
          setIsChecking(false);
          activeResolverRef.current = null;
          resolve(false);
          return;
        }

        const checkPopup = window.setInterval(() => {
          // Check if approved in localStorage while popup is open
          if (window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY) === "true") {
            window.clearInterval(checkPopup);
            markApproved();
            try {
              if (!popup.closed) popup.close();
            } catch (_e) {}
            return;
          }

          if (popup.closed) {
            window.clearInterval(checkPopup);
            setIsChecking(false);
            const isApprovedNow = window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY) === "true";
            if (isApprovedNow) {
              markApproved();
            } else {
              setStatusMessage("Verification window closed. If you completed verification, please click Verify Age again.");
              if (activeResolverRef.current) {
                activeResolverRef.current(false);
                activeResolverRef.current = null;
              }
            }
          }
        }, 400);

      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : "Age verification failed.");
        setIsChecking(false);
        if (activeResolverRef.current) {
          activeResolverRef.current(false);
          activeResolverRef.current = null;
        }
      }
    });
  };

  useImperativeHandle(ref, () => ({
    openPortal,
    resetApproval,
    isApproved: approved,
  }), [approved]);

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
    </div>
  );
});

AgeGate.displayName = "AgeGate";
export default AgeGate;
