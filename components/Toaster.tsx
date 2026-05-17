"use client";

import { useEffect, useRef, useState } from "react";
import { IconButton } from "@radix-ui/themes";
import { Cross1Icon, ExclamationTriangleIcon } from "@radix-ui/react-icons";
import {
  dismissToast,
  showError,
  subscribeToasts,
  type Toast,
} from "@/lib/toast";

// Single mount point for the global toast stack. Renders the live list
// from lib/toast and also installs window-level error listeners that route
// uncaught exceptions / unhandled promise rejections through the same
// surface — anything that escapes to the browser becomes a red toast.

export function Toaster() {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);

  // Subscribe to the global emitter. The cleanup runs on HMR too, so each
  // hot reload re-subscribes cleanly.
  useEffect(() => subscribeToasts(setToasts), []);

  // Schedule per-toast dismissal once. We compare the set of seen IDs to
  // avoid stacking timers when the list re-renders for unrelated reasons.
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  useEffect(() => {
    const seen = new Set(toasts.map((t) => t.id));
    // Schedule new ones.
    for (const t of toasts) {
      if (timersRef.current.has(t.id)) continue;
      const remaining = Math.max(0, t.expiresAt - Date.now());
      const handle = setTimeout(() => {
        dismissToast(t.id);
        timersRef.current.delete(t.id);
      }, remaining);
      timersRef.current.set(t.id, handle);
    }
    // Garbage collect timers for toasts that were dismissed manually.
    for (const [id, handle] of timersRef.current) {
      if (!seen.has(id)) {
        clearTimeout(handle);
        timersRef.current.delete(id);
      }
    }
  }, [toasts]);

  // Catch anything that bubbles up to the window and route it through
  // showError. ResizeObserver loop notices are filtered — they're harmless
  // browser-internal warnings, not errors anyone needs a toast for.
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      const msg = e.message ?? "";
      if (msg.includes("ResizeObserver loop")) return;
      showError(msg || "Something went wrong");
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason as unknown;
      if (reason instanceof Error) {
        showError(reason.message || "Something went wrong");
      } else if (typeof reason === "string") {
        showError(reason);
      } else if (reason && typeof reason === "object" && "message" in reason) {
        showError(String((reason as { message?: unknown }).message ?? "Something went wrong"));
      } else {
        showError("Something went wrong");
      }
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="toast"
          data-kind={t.kind}
          role={t.kind === "error" ? "alert" : "status"}
        >
          <div className="toast-icon" aria-hidden>
            <ExclamationTriangleIcon />
          </div>
          <div className="toast-message">{t.message}</div>
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss notification"
            className="toast-dismiss"
          >
            <Cross1Icon />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
