// src/components/AgeGate.tsx
import React, { useEffect, useState, useImperativeHandle, forwardRef, useRef, useCallback } from "react";
import { ShieldCheck, CheckCircle2, Lock, AlertCircle, RefreshCw, ExternalLink, X, Maximize2 } from "lucide-react";
import { trackAgeVerified } from "../utils/klaviyo";

const AGE_APPROVED_STORAGE_KEY = "agechecked-approved";
const AGE_VERIFIED_STORAGE_KEY = "ageVerified";
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
  error?: {
    code?: string;
    message?: string;
    details?: string;
  };
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
  const [isOpenInWindow, setIsOpenInWindow] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [iframeUrl, setIframeUrl] = useState<string>("");
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
  const [checkStatusNotice, setCheckStatusNotice] = useState<string | null>(null);

  const onApprovedChangeRef = useRef(onApprovedChange);
  useEffect(() => {
    onApprovedChangeRef.current = onApprovedChange;
  }, [onApprovedChange]);

  const activeResolverRef = useRef<((approved: boolean) => void) | null>(null);
  const pollingTimerRef = useRef<number | null>(null);
  const windowRef = useRef<Window | null>(null);

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

  // Handle successful age verification
  const markApproved = useCallback((detail?: AgeCheckedResponse) => {
    if (typeof window === "undefined") return;

    // 1. Immediately store verification in localStorage
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

    // 2. Stop polling & close popup / modal if open
    if (pollingTimerRef.current) {
      window.clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
    if (windowRef.current && !windowRef.current.closed) {
      try {
        windowRef.current.close();
      } catch (_e) {}
    }

    // 3. Update React states
    setApproved(true);
    setIsChecking(false);
    setIsModalOpen(false);
    setIsOpenInWindow(false);
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
          approved: true,
          data: detail
        },
        window.location.origin
      );
    } catch (_e) {}

    // Broadcast across tabs/windows
    try {
      if (typeof BroadcastChannel !== "undefined") {
        const bc = new BroadcastChannel("agechecked_channel");
        bc.postMessage({
          type: "agechecked-approved",
          status: "approved",
          approved: true,
          verified: true,
          agecheckid: resolvedAgeCheckId,
          email: customerData?.email
        });
        bc.close();
      }
    } catch (_e) {}

    // Persist to server backend database
    if (customerData?.email || currentReference || resolvedAgeCheckId) {
      fetch("/api/agechecked/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference: currentReference || customerData?.reference,
          email: customerData?.email,
          agecheckid: resolvedAgeCheckId,
          verified: true
        })
      }).catch(() => {});
    }

    // 7. Klaviyo tracking
    try {
      trackAgeVerified({
        email: customerData?.email || "customer@example.com",
        verified_at: new Date().toISOString(),
      });
    } catch (_e) {}
  }, [customerData?.email, customerData?.reference, currentReference, agecheckId]);

  // Query server status endpoint directly
  const pollServerStatus = useCallback(async (refToTest?: string, idToTest?: string, emailToTest?: string): Promise<boolean> => {
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY);
      const storedVerified = window.localStorage.getItem(AGE_VERIFIED_STORAGE_KEY);
      if (stored === "true" || storedVerified === "true") {
        markApproved();
        return true;
      }
    }

    const refParam = refToTest || currentReference || customerData?.reference || "";
    const idParam = idToTest || agecheckId || "";
    const emailParam = emailToTest || customerData?.email || "";

    if (!refParam && !idParam && !emailParam) {
      return false;
    }

    try {
      const queryParams = new URLSearchParams();
      if (refParam) queryParams.set("reference", refParam);
      if (idParam) queryParams.set("agecheckid", idParam);
      if (emailParam) queryParams.set("email", emailParam);

      const res = await fetch(`/api/agechecked/status?${queryParams.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (data.approved === true || data.status === "6" || data.status === "7" || data.success === true) {
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

  // Sync with localStorage & server on mount & when email/reference becomes available
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
      isApprovedStatus(params.get("status")) ||
      params.get("status") === "6" ||
      params.get("status") === "7";

    if (isApprovedFromParam && !approved) {
      markApproved({
        avstatus: { agecheckid: params.get("agecheckid") || undefined }
      });
      return;
    }

    if (!approved && (customerData?.email || customerData?.reference || agecheckId)) {
      pollServerStatus();
    }
  }, [approved, customerData?.email, customerData?.reference, agecheckId, markApproved, pollServerStatus]);

  // Continuous background synchronization & window focus/visibility listeners
  useEffect(() => {
    if (typeof window === "undefined" || approved) return;

    const handleVisibilityOrFocus = () => {
      const stored = window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY);
      const storedVerified = window.localStorage.getItem(AGE_VERIFIED_STORAGE_KEY);
      if (stored === "true" || storedVerified === "true") {
        markApproved();
        return;
      }
      pollServerStatus();
    };

    window.addEventListener("focus", handleVisibilityOrFocus);
    window.addEventListener("pageshow", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);

    const intervalMs = isOpenInWindow || isModalOpen || isChecking ? 600 : 1200;
    const intervalId = window.setInterval(async () => {
      const stored = window.localStorage.getItem(AGE_APPROVED_STORAGE_KEY);
      const storedVerified = window.localStorage.getItem(AGE_VERIFIED_STORAGE_KEY);
      if (stored === "true" || storedVerified === "true") {
        markApproved();
        return;
      }
      if (customerData?.email || currentReference || agecheckId || isOpenInWindow || isModalOpen) {
        await pollServerStatus();
      }
    }, intervalMs);

    return () => {
      window.removeEventListener("focus", handleVisibilityOrFocus);
      window.removeEventListener("pageshow", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
      window.clearInterval(intervalId);
    };
  }, [approved, isOpenInWindow, isModalOpen, isChecking, customerData?.email, currentReference, agecheckId, markApproved, pollServerStatus]);

  // Official AgeChecked AC0130 postMessage listener (Section 5 sample code)
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

      // 1. Exact official AgeChecked GetID postMessage implementation:
      // When getidEventName === "complete", ID capture finished successfully
      if ("getidEventName" in payload) {
        if (payload.getidEventName === "complete") {
          console.log("AgeChecked application completed successfully: ", payload.data);
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

        if (payload.getidEventName === "fail") {
          console.log("AgeChecked application failed: ", payload.error);
          setIsChecking(false);
          setIsModalOpen(false);
          setIsOpenInWindow(false);
          const errorDetail = payload.error?.message || payload.error?.details || (typeof payload.error === "string" ? payload.error : "Age verification attempt was not successful. Please try again.");
          setCheckStatusNotice(errorDetail);
          if (activeResolverRef.current) {
            activeResolverRef.current(false);
            activeResolverRef.current = null;
          }
          return;
        }
      }

      // 2. Custom AgeChecked event aliases
      const eventName = payload.eventName || payload.event || payload.action;
      if (eventName) {
        const lowerEvent = String(eventName).toLowerCase();
        if (
          lowerEvent === "complete" ||
          lowerEvent === "exit" ||
          lowerEvent === "close" ||
          lowerEvent === "finish" ||
          lowerEvent === "continue" ||
          lowerEvent === "success" ||
          lowerEvent === "redirect" ||
          lowerEvent === "approved"
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
      }

      // 3. Fallback verification messages
      const isApproved =
        payload.type === "AGECHECKED_VERIFIED" ||
        payload.type === "agechecked-approved" ||
        payload.type === "agechecked_approved" ||
        payload.type === "AC_APPROVED" ||
        payload.type === "getid:complete" ||
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
  }, [markApproved, agecheckId]);

  const resetApproval = () => {
    if (typeof window === "undefined") return;

    window.localStorage.removeItem(AGE_APPROVED_STORAGE_KEY);
    window.localStorage.removeItem(AGE_VERIFIED_STORAGE_KEY);
    window.localStorage.removeItem(AGE_APPROVED_AT_STORAGE_KEY);
    window.localStorage.removeItem("agechecked-id");
    setApproved(false);
    setIsChecking(false);
    setIsModalOpen(false);
    setIsOpenInWindow(false);
    setAgecheckId(null);
    setCheckStatusNotice(null);
    setStatusMessage("Under UK law, 18+ age verification is required before checkout.");
    onApprovedChangeRef.current?.(false);
  };

  // Start AgeChecked AC0130 verification (opens embedded iframe modal or window)
  const openPortal = async (preferNewWindow: boolean = false): Promise<boolean> => {
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
    setStatusMessage("Initializing AgeChecked 18+ ID verification...");

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

        const data = (await response.json()) as AgeCheckedResponse;
        
        // Handle Error codes from AgeChecked AC0130 documentation (e.g. 1039 Invalid Merchant Key, 1008 Required fields)
        if (data.error && !data.url && !data.redirectUrl) {
          const errCode = data.error.code ? `[Code ${data.error.code}] ` : "";
          const errText = `${errCode}${data.error.message || "AgeChecked initialization error"}${data.error.details ? ` (${data.error.details})` : ""}`;
          setCheckStatusNotice(errText);
          setStatusMessage(errText);
          setIsChecking(false);
          resolve(false);
          return;
        }

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

        let rawRedirectUrl =
          (data as { url?: string }).url ||
          (data as { redirectUrl?: string }).redirectUrl ||
          (data as { redirect_url?: string }).redirect_url;

        if (!rawRedirectUrl && publicKey) {
          rawRedirectUrl = getPortalUrl(
            publicKey,
            `${window.location.origin}/api/agechecked/callback?reference=${encodeURIComponent(sessionRef)}&email=${encodeURIComponent(customerData?.email || '')}&returnUrl=${encodeURIComponent(window.location.href)}`,
            serverConfig?.portalUrl
          );
        }

        if (!rawRedirectUrl) {
          rawRedirectUrl = `/api/agechecked/demo-portal?reference=${encodeURIComponent(sessionRef)}&email=${encodeURIComponent(customerData?.email || '')}&name=${encodeURIComponent(firstName)}&surname=${encodeURIComponent(lastName)}&postcode=${encodeURIComponent(customerData?.postcode || 'EC1A 1BB')}`;
        }

        // As specified in the AgeChecked AC0130 Iframe Integration documentation:
        // Append &embedded=true so the ID capture service knows it is embedded in an iframe/modal
        const urlSeparator = rawRedirectUrl.includes("?") ? "&" : "?";
        const finalRedirectUrl = rawRedirectUrl.includes("embedded=true") 
          ? rawRedirectUrl 
          : `${rawRedirectUrl}${urlSeparator}embedded=true`;

        const resolvedSessionId = data?.avstatus?.agecheckid ? String(data.avstatus.agecheckid) : `AC-${Date.now()}`;
        setAgecheckId(resolvedSessionId);
        setIframeUrl(finalRedirectUrl);

        if (preferNewWindow) {
          // Open in a new window
          setIsOpenInWindow(true);
          const width = 800;
          const height = 740;
          const left = Math.max(0, Math.round((window.screen.width - width) / 2));
          const top = Math.max(0, Math.round((window.screen.height - height) / 2));
          const windowFeatures = `width=${width},height=${height},top=${top},left=${left},status=yes,scrollbars=yes,resizable=yes`;

          const newWin = window.open(finalRedirectUrl, "AgeCheckedPortal", windowFeatures);
          if (newWin) {
            windowRef.current = newWin;
            newWin.focus();
          } else {
            window.open(finalRedirectUrl, "_blank");
          }
          setStatusMessage("AgeChecked window opened. Please complete 18+ ID scan in the popup.");
        } else {
          // Open in interactive embedded Iframe modal dialog
          setIsModalOpen(true);
          setStatusMessage("AgeChecked 18+ ID verification active. Please follow the instructions below.");
        }

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
        setStatusMessage(error instanceof Error ? error.message : "Age verification connection failed.");
        setIsChecking(false);
        setIsModalOpen(false);
        setIsOpenInWindow(false);
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
      setCheckStatusNotice("Verification status: Pending. Please complete the ID capture in the AgeChecked frame.");
    }
  };

  useImperativeHandle(ref, () => ({
    openPortal: () => openPortal(false),
    resetApproval,
    checkStatus: () => pollServerStatus(),
    isApproved: approved,
  }), [approved, pollServerStatus]);

  return (
    <>
      <div
        className={`rounded-2xl border p-4 sm:p-5 transition-all shadow-xs ${
          approved
            ? "border-emerald-200 bg-emerald-50/80 text-emerald-950"
            : isModalOpen || isOpenInWindow
            ? "border-sky-300 bg-sky-50/90 text-sky-950"
            : "border-amber-200 bg-amber-50/80 text-amber-950"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={`mt-0.5 rounded-xl p-2.5 shrink-0 ${
                approved
                  ? "bg-emerald-100 text-emerald-700"
                  : isModalOpen || isOpenInWindow
                  ? "bg-sky-100 text-sky-700"
                  : "bg-amber-100 text-amber-800"
              }`}
            >
              {approved ? (
                <ShieldCheck className="h-5 w-5" />
              ) : isModalOpen || isOpenInWindow ? (
                <RefreshCw className="h-5 w-5 animate-spin text-sky-700" />
              ) : (
                <Lock className="h-5 w-5" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span
                  className={`text-[10px] font-black uppercase tracking-wider ${
                    approved
                      ? "text-emerald-800"
                      : isModalOpen || isOpenInWindow
                      ? "text-sky-800"
                      : "text-amber-800"
                  }`}
                >
                  {approved
                    ? "Age Verified (18+ Approved)"
                    : isModalOpen
                    ? "Verification Modal Active"
                    : isOpenInWindow
                    ? "Verification Window Active"
                    : "Age Verification Required"}
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
                  : isModalOpen || isOpenInWindow
                  ? "border-sky-300 bg-sky-100 text-sky-800"
                  : "border-amber-300 bg-amber-100/80 text-amber-800"
              }`}
            >
              {approved ? "Verified" : isModalOpen || isOpenInWindow ? "In Progress" : "Pending"}
            </span>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          {!approved ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-amber-900/80">
                {isModalOpen
                  ? "Complete the photo ID document check in the frame below or click open window."
                  : isOpenInWindow
                  ? "Complete the ID check in the popup window, then this page will update automatically."
                  : "Click 'Verify with AgeChecked' to scan your ID (18+) directly on this page."}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-emerald-800 text-xs font-semibold">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <span>Identity verified. You are ready to complete checkout.</span>
            </div>
          )}

          <div className="flex items-center gap-2">
            {!approved ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => openPortal(false)}
                  disabled={isChecking && isModalOpen}
                  className="text-[11px] font-bold bg-sky-600 hover:bg-sky-700 text-white px-3.5 py-1.5 rounded-lg transition cursor-pointer flex items-center gap-1.5 shadow-xs"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span>{isModalOpen ? "Verification Active" : "Verify with AgeChecked"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => openPortal(true)}
                  disabled={isChecking && isOpenInWindow}
                  className="text-[11px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-lg transition cursor-pointer flex items-center gap-1.5 border border-slate-300"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>Open in Window</span>
                </button>
                <button
                  type="button"
                  onClick={manualConfirmCheck}
                  disabled={isChecking}
                  className="text-[11px] font-bold text-slate-700 hover:text-slate-900 underline flex items-center gap-1 cursor-pointer"
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
      </div>

      {/* Embedded AgeChecked Iframe Modal (AC0130 ID Scan integration) */}
      {isModalOpen && iframeUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/75 backdrop-blur-xs transition-opacity animate-fade-in">
          <div className="relative w-full max-w-3xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-slate-850 border-b border-slate-700 text-white">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-sky-500/20 text-sky-400 flex items-center justify-center font-bold">
                  <ShieldCheck className="h-4 w-4" />
                </div>
                <div>
                  <h4 className="text-xs font-black uppercase tracking-wider text-slate-100">
                    AgeChecked Official 18+ ID Verification
                  </h4>
                  <p className="text-[10px] text-slate-400">
                    AC0130 ID Scan • Camera enabled
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const newWin = window.open(iframeUrl, "AgeCheckedPortal", "width=800,height=740,resizable=yes,scrollbars=yes");
                    if (newWin) {
                      windowRef.current = newWin;
                      newWin.focus();
                    }
                  }}
                  className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-750 transition text-[11px] font-bold flex items-center gap-1 cursor-pointer"
                  title="Open in new window"
                >
                  <Maximize2 className="h-4 w-4" />
                  <span className="hidden sm:inline">Pop out</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsModalOpen(false);
                    setIsChecking(false);
                  }}
                  className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-750 transition cursor-pointer"
                  title="Close modal"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Embedded Iframe matching Section 5 AgeChecked sample code */}
            <div className="relative w-full flex-1 min-h-[520px] sm:min-h-[620px] bg-slate-950 flex flex-col">
              <iframe
                id="agecheck"
                src={iframeUrl}
                frameBorder="0"
                allow="camera; microphone; geolocation"
                className="w-full flex-1 min-h-[520px] sm:min-h-[620px] border-0"
                title="AgeChecked Verification"
              />
            </div>

            {/* Modal Footer */}
            <div className="px-4 py-2.5 bg-slate-850 border-t border-slate-700 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1 text-emerald-400 font-bold">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> 256-bit Encrypted
                </span>
                <span>Camera will activate for ID capture</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={manualConfirmCheck}
                  className="text-sky-400 hover:text-sky-300 font-bold underline cursor-pointer"
                >
                  Check Verification Status
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
});

AgeGate.displayName = "AgeGate";
export default AgeGate;
