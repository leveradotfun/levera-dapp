"use client";

/// Waiting-for-data text with the Transitions.dev shimmer sweep (see globals.css). The visible
/// string is duplicated into data-text so the ::before layer masks the gradient onto the same
/// glyphs — children and the attribute stay in sync by construction.
export default function ShimmerText({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <span className={`t-shimmer ${className ?? ""}`} data-text={children}>
      {children}
    </span>
  );
}
