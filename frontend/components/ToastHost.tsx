"use client";

import { useEffect, useState } from "react";
import { ToastItem, dismissToast, subscribeToasts } from "@/lib/toast";

// Success uses the brand accent, not a generic green -- this app has one accent color and a toast
// confirming a mint/swap/redeem is exactly the kind of moment it should show up in. Error stays
// semantically red; a failed tx is not an on-brand moment.
const KIND_BORDER: Record<ToastItem["kind"], string> = {
  success: "border-border",
  error: "border-red/30",
  info: "border-border",
};

const KIND_BADGE: Record<ToastItem["kind"], string> = {
  success: "bg-accent text-accent-ink",
  error: "bg-red/15 text-red",
  info: "bg-accent/15 text-accent",
};

const KIND_ICON: Record<ToastItem["kind"], string> = {
  success: "✓",
  error: "✕",
  info: "ℹ",
};

export default function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToasts(setItems), []);

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end sm:right-4 sm:left-auto">
      {items.map((item) => (
        <div
          key={item.id}
          className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-card px-4 py-3 shadow-lg ${KIND_BORDER[item.kind]}`}
        >
          <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${KIND_BADGE[item.kind]}`}>
            {KIND_ICON[item.kind]}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-semibold text-foreground">{item.message}</span>
            {item.detail ? <span className="mt-0.5 block text-xs text-muted break-words">{item.detail}</span> : null}
          </span>
          <button
            onClick={() => dismissToast(item.id)}
            className="shrink-0 text-muted hover:text-foreground"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
