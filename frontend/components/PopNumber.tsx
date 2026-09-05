"use client";

/// Headline numbers that pop in digit-by-digit (Transitions.dev number pop-in; see globals.css).
///
/// Usage: <PopNumber value={usdNum(profit)} className="text-4xl font-bold" />
///
/// Replay semantics: `value` doubles as the group's React key, so any change remounts the digit
/// spans and the animation plays again — the guide's "force a reflow, re-add .is-animating" done
/// the React way. Each digit's delay is its character index (capped), giving the left-to-right
/// cascade; prefers-reduced-motion disables it globally in CSS.
export default function PopNumber({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  // First paint animates too, which reads as the page coming alive; after that, only changes.
  return (
    <span key={value} className={`t-digit-group is-animating ${className ?? ""}`} aria-label={value} role="text">
      {Array.from(value).map((ch, i) => (
        <span
          key={`${i}-${ch}`}
          className="t-digit"
          style={{ "--stagger": Math.min(i, 8) } as React.CSSProperties}
          aria-hidden="true"
        >
          {ch}
        </span>
      ))}
    </span>
  );
}
