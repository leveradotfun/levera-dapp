"use client";

import { XIdentity } from "@/lib/xHandles";

function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/// A trader labelled by their connected X identity -- avatar + @handle -- falling back to the
/// truncated wallet address when they never connected Twitter. `linkHandle` points the handle at
/// x.com (read-only tables); rows that navigate on click themselves (leaderboards) pass false so
/// the row keeps the click.
export default function TraderIdentity({
  address,
  identity,
  linkHandle = false,
  size = 16,
  className = "text-secondary",
}: {
  address: string;
  identity?: XIdentity;
  linkHandle?: boolean;
  size?: number;
  className?: string;
}) {
  if (!identity) {
    return (
      <span className={`font-mono ${className}`} title={address}>
        {shortAddress(address)}
      </span>
    );
  }
  const label = <span className="font-medium">@{identity.username}</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} title={address}>
      {identity.avatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={identity.avatar}
          alt={`@${identity.username}`}
          width={size}
          height={size}
          className="shrink-0 rounded-full bg-surface object-cover"
          style={{ width: size, height: size }}
          onError={(e) => {
            // X CDN images can fail to load; degrade to handle-only rather than a broken image
            e.currentTarget.style.display = "none";
          }}
        />
      ) : null}
      {linkHandle ? (
        <a
          href={`https://x.com/${identity.username}`}
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-accent"
        >
          {label}
        </a>
      ) : (
        label
      )}
    </span>
  );
}
