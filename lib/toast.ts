// Lightweight toast emitter. Decoupled from React's context system so any
// module can fire a notification without first walking up the tree to grab
// a hook — including non-component code paths like the React Query global
// onError, window error listeners, or library helpers in lib/* that don't
// have a hook in scope.
//
// Components subscribe via the `useToasts` hook below.

export type ToastKind = "error" | "info";

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  // Wall-clock time after which the runtime can drop the toast. We don't
  // schedule timers here — the renderer does — but storing the deadline
  // lets the renderer survive HMR + tab visibility changes.
  expiresAt: number;
}

type Listener = (toasts: readonly Toast[]) => void;

const listeners = new Set<Listener>();
let toasts: Toast[] = [];
let nextId = 1;

const DEFAULT_TTL_MS = 5000;
// Stop the same message from queueing up four times when, say, four
// in-flight queries all 502 at once. The renderer treats new toasts
// arriving within 1.5s of an identical one as duplicates and drops them.
const DEDUPE_WINDOW_MS = 1500;
// Keep at most this many toasts on screen — newest wins, oldest gets
// evicted. Stacks deeper than ~5 are unreadable anyway.
const MAX_TOASTS = 5;

function snapshot(): readonly Toast[] {
  return toasts;
}

function notify() {
  for (const l of listeners) l(toasts);
}

function push(kind: ToastKind, message: string, ttlMs: number) {
  const trimmed = (message ?? "").toString().trim();
  if (!trimmed) return;

  const now = Date.now();
  // Drop a duplicate fired within the dedupe window.
  for (const t of toasts) {
    if (
      t.kind === kind &&
      t.message === trimmed &&
      now < t.expiresAt &&
      now - (t.expiresAt - ttlMs) < DEDUPE_WINDOW_MS
    ) {
      return;
    }
  }

  const id = nextId++;
  const toast: Toast = {
    id,
    message: trimmed,
    kind,
    expiresAt: now + ttlMs,
  };
  toasts = [...toasts, toast];
  if (toasts.length > MAX_TOASTS) {
    toasts = toasts.slice(toasts.length - MAX_TOASTS);
  }
  notify();
}

export function showError(message: string, opts?: { ttlMs?: number }) {
  push("error", message, opts?.ttlMs ?? DEFAULT_TTL_MS);
}

export function showInfo(message: string, opts?: { ttlMs?: number }) {
  push("info", message, opts?.ttlMs ?? DEFAULT_TTL_MS);
}

export function dismissToast(id: number) {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  notify();
}

export function clearToasts() {
  if (toasts.length === 0) return;
  toasts = [];
  notify();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  // Sync the listener to the current state so subscribers don't wait for
  // the next event to render the initial snapshot.
  listener(snapshot());
  return () => {
    listeners.delete(listener);
  };
}

// React hook is in components/Toaster.tsx — keeping this module
// dependency-free so it can be imported from anywhere (including server
// code that wouldn't otherwise pull in React).
