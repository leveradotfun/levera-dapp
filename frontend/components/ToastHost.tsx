"use client";

import { useEffect, useState } from "react";
import { ToastItem, dismissToast, subscribeToasts } from "@/lib/toast";

const KIND_STYLES: Record<ToastItem["kind"], string> = {
  success: "border-green/40 bg-green/10 text-green",
  error: "border-red/40 bg-red/10 text-red",
  info: "border-accent/40 bg-accent/10 text-accent",
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
          className={`pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-lg border bg-surface px-3 py-2.5 text-sm shadow-lg ${KIND_STYLES[item.kind]}`}
        >
          <span className="mt-0.5 shrink-0 font-mono">{KIND_ICON[item.kind]}</span>
          <span className="flex-1 text-foreground">{item.message}</span>
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
