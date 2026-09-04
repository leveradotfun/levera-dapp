"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const COLLAPSE_KEY = "launchpad-frontend:rail-collapsed";

type Item = { href: string; label: string; icon: React.ReactNode };

const ICON = "h-[22px] w-[22px]";

// Shared with MobileNav, which renders the same destinations as a phone-only bottom bar.
export const NAV_ITEMS: Item[] = [
  {
    href: "/",
    label: "Explore",
    icon: (
      <svg className={ICON} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 10.5 12 3l9 7.5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
      </svg>
    ),
  },
  {
    href: "/earn",
    label: "Earn",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-[18px] w-[18px]">
        <path d="M12 3v18" strokeLinecap="round" />
        <path d="M7.5 7.5h6a3 3 0 0 1 0 6h-6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M7.5 16.5h9" strokeLinecap="round" />
      </svg>
    ),
  },
{
    href: "/analytics",
    label: "Analytics",
    icon: (
      <svg className={ICON} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h3l2.5 6 4-14 3 10 2-3h3.5" />
      </svg>
    ),
  },
  {
    href: "/profile",
    label: "Portfolio",
    icon: (
      <svg className={ICON} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M10 3h4l-1 3h-2l-1-3Z" />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M11 6h2c3.5 1.6 6 4.9 6 8.6A6.4 6.4 0 0 1 12 21a6.4 6.4 0 0 1-7-6.4C5 10.9 7.5 7.6 11 6Z"
        />
      </svg>
    ),
  },
];

/// The persistent left rail. Collapsed by default to an icon strip and expandable to show labels,
/// with the choice remembered per browser -- navigation shouldn't cost horizontal room on a page
/// that is mostly a wide table. Phones replace this rail entirely with the MobileNav bottom bar.
export default function SideRail() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(true);

  // Read after mount, not in a lazy initializer: localStorage doesn't exist during server
  // rendering, and seeding state from it directly would desync the first client render.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) !== "false");
    } catch {
      // private mode / storage blocked -- the default stands
    }
  }, []);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, String(next));
      } catch {
        // not worth failing the interaction over
      }
      return next;
    });
  }

  return (
    <aside
      className={`sticky top-0 z-50 hidden h-screen shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200 md:flex ${
        collapsed ? "w-[60px]" : "w-[188px]"
      }`}
    >
      <Link href="/" className="flex h-14 items-center gap-2 px-[18px]" title="levera">
        <img src="/logo.svg" alt="" className="h-6 w-6 shrink-0 rounded-md" />
        {!collapsed ? <img src="/wordmark.svg" alt="levera" className="h-5" /> : null}
      </Link>

      <nav className="flex flex-1 flex-col gap-1 px-2 pt-2">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={`flex h-11 items-center gap-3 rounded-xl px-[10px] transition-colors ${
                active ? "bg-surface text-accent" : "text-muted hover:bg-surface hover:text-foreground"
              }`}
            >
              <span className="shrink-0">{item.icon}</span>
              {!collapsed ? <span className="truncate text-sm font-medium">{item.label}</span> : null}
            </Link>
          );
        })}

        <Link
          href="/create"
          title={collapsed ? "Launch a coin" : undefined}
          className="mt-2 flex h-11 items-center gap-3 rounded-xl bg-accent px-[10px] text-accent-ink transition-opacity hover:opacity-90"
        >
          <svg className={`${ICON} shrink-0`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
            <path strokeLinecap="round" d="M12 5v14M5 12h14" />
          </svg>
          {!collapsed ? <span className="truncate text-sm font-semibold">Launch</span> : null}
        </Link>
      </nav>

      <button
        onClick={toggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand" : "Collapse"}
        className="m-2 flex h-9 items-center justify-center gap-2 rounded-xl text-muted transition-colors hover:bg-surface hover:text-foreground"
      >
        <svg
          className={`h-4 w-4 transition-transform ${collapsed ? "" : "rotate-180"}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m9 5 7 7-7 7" />
        </svg>
        {!collapsed ? <span className="text-xs">Collapse</span> : null}
      </button>
    </aside>
  );
}
