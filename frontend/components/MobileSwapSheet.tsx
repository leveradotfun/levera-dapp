"use client";

import { useEffect, useState } from "react";

/// Mobile presentation for the trading card: a fixed call-to-action bar sits at the bottom of the
/// viewport (above the mobile nav), and tapping it slides the swap card up from the bottom edge
/// as a bottom sheet. Desktop pages render the same card inline instead -- the parent gates on
/// useIsDesktop() so the card exists exactly once, and this component renders nothing there.
export default function MobileSwapSheet({
  triggerLabel,
  title,
  children,
}: {
  triggerLabel: string;
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  // Freeze the page behind the sheet: a touch drag inside the sheet would otherwise scroll the
  // coin list under the overlay once the sheet's own content runs out of scroll.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <div
        className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 border-t border-border bg-bg/95 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur-md md:hidden"
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-center rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90"
        >
          {triggerLabel}
        </button>
      </div>

      {open ? (
        <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col overflow-hidden rounded-t-2xl border-x border-t border-border bg-bg shadow-2xl animate-sheet-up">
            <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
              <div className="mx-auto h-1 w-10 rounded-full bg-border md:hidden" />
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 pb-3">
              <div className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface text-muted transition-colors hover:bg-hover hover:text-foreground"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              {children}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
