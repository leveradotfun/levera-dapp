"use client";

import { XIdentity } from "@/lib/xHandles";

function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/// A trader labelled by their connected X identity -- avatar + @handle -- falling back to the
/// truncated wallet address when they never connected Twitter. `linkHandle` points the handle at
/// x.com (read-only tables); rows that navigate on click themselves (leaderboards) pass false so
/// the row keeps the click. `isMe` marks the connected viewer's own rows with a "(Me)" tag, so
/// their own address/handle is recognisable in a list of strangers.
export default function TraderIdentity({
  address,
  identity,
  linkHandle = false,
  size = 16,
  className = "text-secondary",
  isMe = false,
}: {
  address: string;
  identity?: XIdentity;
  linkHandle?: boolean;
  size?: number;
  className?: string;
  isMe?: boolean;
}) {
  const meTag = isMe ? (
    <span className="shrink-0 font-sans font-semibold text-accent" title="This is you">
      (Me)
    </span>
  ) : null;
  if (!identity) {
    return (
      <span className={`inline-flex items-center gap-1 font-mono ${className}`} title={address}>
        {meTag}
        {shortAddress(address)}
      </span>
    );
  }
  const label = <span className="font-medium">@{identity.username}</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} title={address}>
      {meTag}
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
