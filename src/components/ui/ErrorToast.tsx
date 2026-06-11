import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Button } from "./Button";

export interface ToastSpec {
  id: number;
  message: string;
  onRetry?: () => void;
}

interface ToastContextValue {
  showError: (message: string, onRetry?: () => void) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// App-wide error surface. Every failed async/IPC op routes here so errors are
// never silently swallowed (blocklist #16). Mounted once at the app root.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastSpec[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showError = useCallback((message: string, onRetry?: () => void) => {
    setToasts((prev) => [...prev, { id: Date.now() + prev.length, message, onRetry }]);
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

export function ErrorToast({ toast, onDismiss }: ErrorToastProps) {
  return (
    <div
      role="alert"
      className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-lg border border-danger/40 bg-surface-raised p-3 shadow-lg"
    >
      <span aria-hidden="true" className="mt-0.5 font-semibold text-danger">
        !
      </span>
      <p className="flex-1 text-sm text-text">{toast.message}</p>
      {toast.onRetry && (
        <Button
          variant="secondary"
          className="px-3 py-1 text-xs"
          onClick={() => {
            toast.onRetry?.();
            onDismiss();
          }}
        >
          Retry
        </Button>
      )}
      <Button
        variant="ghost"
        className="px-2 py-1 text-xs"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        ✕
      </Button>
    </div>
  );
}
