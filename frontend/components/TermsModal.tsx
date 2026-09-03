"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";

interface TermsModalProps {
  open: boolean;
  onAccept: () => void;
  onClose: () => void;
}

export default function TermsModal({ open, onAccept, onClose }: TermsModalProps) {
  const { isConnected } = useAccount();
  const [checked1, setChecked1] = useState(false);
  const [checked2, setChecked2] = useState(false);

  useEffect(() => {
    if (!isConnected) {
      setChecked1(false);
      setChecked2(false);
    }
  }, [isConnected]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-2xl w-full max-w-md p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-xl font-bold text-foreground mb-2 text-center">
          Review the terms before trading on Levera
        </h2>

        <p className="text-sm text-muted mb-6 text-center leading-relaxed">
          Welcome to the first memecoin trading platform with built-in leverage. You agree to our{" "}
          <span className="text-accent cursor-pointer hover:underline">Terms of Use</span> and acknowledge
          that you have read our{" "}
          <span className="text-accent cursor-pointer hover:underline">Privacy Policy</span>.
        </p>

        <div className="space-y-3 mb-6">
          <label className="flex items-start gap-3 cursor-pointer group">
            <div className="relative mt-0.5">
              <input
                type="checkbox"
                checked={checked1}
                onChange={(e) => setChecked1(e.target.checked)}
                className="sr-only"
              />
              <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                checked1 ? "bg-accent border-accent" : "border-border group-hover:border-muted"
              }`}>
                {checked1 && (
                  <svg className="w-3 h-3 text-accent-ink" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
            </div>
            <span className="text-sm text-secondary leading-snug">
              I have read and agree to the{" "}
              <span className="text-foreground font-medium">Terms of Use</span> and{" "}
              <span className="text-foreground font-medium">Privacy Policy</span>
            </span>
          </label>

          <label className="flex items-start gap-3 cursor-pointer group">
            <div className="relative mt-0.5">
              <input
                type="checkbox"
                checked={checked2}
                onChange={(e) => setChecked2(e.target.checked)}
                className="sr-only"
              />
              <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                checked2 ? "bg-accent border-accent" : "border-border group-hover:border-muted"
              }`}>
                {checked2 && (
                  <svg className="w-3 h-3 text-accent-ink" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
            </div>
            <span className="text-sm text-secondary leading-snug">
              I confirm that I am not a US person and I am not accessing this site from a restricted jurisdiction
            </span>
          </label>
        </div>

        <button
          onClick={onAccept}
          disabled={!checked1 || !checked2}
          className={`w-full py-3 rounded-xl font-bold text-sm transition-all ${
            checked1 && checked2
              ? "bg-accent text-accent-ink hover:brightness-110 cursor-pointer"
              : "bg-surface text-muted cursor-not-allowed"
          }`}
        >
          Accept and continue
        </button>
      </div>
    </div>
  );
}
