"use client";

import { useState } from "react";

interface TopBarProps {
  onSearch: (q: string) => void;
}

export default function TopBar({ onSearch }: TopBarProps) {
  const [search, setSearch] = useState("");

  return (
    <div className="w-full">
      <div className="relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          type="text"
          placeholder="Search for coins and users..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); onSearch(e.target.value); }}
          className="w-full bg-surface border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent transition-colors"
        />
      </div>
    </div>
  );
}