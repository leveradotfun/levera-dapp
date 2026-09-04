"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "@/components/SideRail";

/// Phone-only bottom navigation -- the vertical SideRail is hidden below md, so this bar carries
/// the same destinations (plus the launch action) in the thumb zone instead. Fixed to the bottom
/// edge with safe-area padding; page content clears it via the layout's bottom padding.
export default function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/95 backdrop-blur-md md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex h-16 items-stretch">
        {NAV_ITEMS.slice(0, 2).map((item) => (
          <NavLink key={item.href} href={item.href} label={item.label} icon={item.icon} active={pathname === item.href} />
        ))}

        <Link
          href="/create"
          aria-label="Launch a coin"
          className="flex flex-1 items-center justify-center"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-accent-ink">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
              <path strokeLinecap="round" d="M12 5v14M5 12h14" />
            </svg>
          </span>
        </Link>

        {NAV_ITEMS.slice(2).map((item) => (
          <NavLink key={item.href} href={item.href} label={item.label} icon={item.icon} active={pathname === item.href} />
        ))}
      </div>
    </nav>
  );
}

function NavLink({
  href,
  label,
  icon,
  active,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className={`flex flex-1 flex-col items-center justify-center gap-0.5 ${
        active ? "text-accent" : "text-muted"
      }`}
    >
      <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5">{icon}</span>
      <span className="whitespace-nowrap text-[10px] font-medium leading-none">{label}</span>
    </Link>
  );
}
