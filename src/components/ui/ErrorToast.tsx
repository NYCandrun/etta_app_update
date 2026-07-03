import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Button } from "./Button";
import { LABELS } from "../../lib/labels";

export interface ToastSpec {
  id: number;
  message: string;
  onRetry?: () => void;
}

interface ToastContextValue {
  showError: (message: string, onRetry?: () => void) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// Monotonic id counter: Date.now()+length could collide after a dismissal
// (duplicate React keys, dismiss(id) removing two toasts at once).
let nextToastId = 1;

// At most 3 toasts on screen; a failing retry loop must not stack an unbounded
// column the user has to close one by one. Oldest is dropped first.
const MAX_TOASTS = 3;

const AUTO_DISMISS_MS = 6000;

// App-wide error surface. Every failed async/IPC op routes here so errors are
// never silently swallowed (blocklist #16). Mounted once at the app root.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastSpec[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showError = useCallback((message: string, onRetry?: () => void) => {
    setToasts((prev) =>
      [...prev, { id: nextToastId++, message, onRetry }].slice(-MAX_TOASTS),
    );
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ showError }), [showError]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4"
        aria-live="assertive"
        aria-atomic="true"
      >
        {toasts.map((t) => (
          <ErrorToast key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

export interface ErrorToastProps {
  toast: ToastSpec;
  onDismiss: () => void;
}

// Auto-dismisses after 6s. Hovering or focusing anything inside (e.g. the
// Retry button) pauses the timer; leaving restarts a fresh 6s window.
export function ErrorToast({ toast, onDismiss }: ErrorToastProps) {
  const [paused, setPaused] = useState(false);
  // Keep the latest callback out of the timer effect's deps so a parent
  // re-render (another toast arriving) does not reset the countdown.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismissRef.current(), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [paused]);

  return (
    <div
      role="alert"
      className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-lg border border-danger/40 bg-surface-raised p-3 shadow-lg"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span aria-hidden="true" className="mt-0.5 font-semibold text-danger">
        !
      </span>
      <p className="flex-1 text-sm text-text">{toast.message}</p>
      {toast.onRetry && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            toast.onRetry?.();
            onDismiss();
          }}
        >
          {LABELS.retry}
        </Button>
      )}
      <Button variant="ghost" size="sm" aria-label="Dismiss" onClick={onDismiss}>
        ✕
      </Button>
    </div>
  );
}
