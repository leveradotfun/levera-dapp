"use client";

interface SidebarProps {
  activeView: "feed" | "detail";
  onHome: () => void;
}

export default function Sidebar({ activeView, onHome }: SidebarProps) {
  return (
    <nav className="fixed left-0 top-0 bottom-0 w-14 bg-card border-r border-border flex flex-col items-center py-3 z-50 gap-1">
      <div className="w-9 h-9 rounded-[10px] bg-accent flex items-center justify-center mb-3 shrink-0">
        <svg viewBox="0 0 100 100" fill="none" className="w-[22px] h-[22px]">
          <path
            d="M50 5C30 5 15 20 12 35C9 50 12 60 20 68L15 95C15 95 35 85 50 85C65 85 85 95 85 95L80 68C88 60 91 50 88 35C85 20 70 5 50 5Z"
            fill="#000"
          />
          <ellipse cx="36" cy="48" rx="10" ry="9" fill="#000" />
          <ellipse cx="64" cy="48" rx="10" ry="9" fill="#000" />
          <ellipse cx="36" cy="48" rx="7" ry="6.5" fill="#fff" />
          <ellipse cx="64" cy="48" rx="7" ry="6.5" fill="#fff" />
          <ellipse cx="37" cy="46.5" rx="3" ry="2.8" fill="#000" />
          <ellipse cx="65" cy="46.5" rx="3" ry="2.8" fill="#000" />
        </svg>
      </div>

      <button
        onClick={onHome}
        className="w-10 h-10 rounded-lg bg-surface hover:bg-hover flex items-center justify-center transition-colors group"
        title="Explore"
      >
        <svg className="w-5 h-5 text-muted group-hover:text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
      </button>

      <button className="w-10 h-10 rounded-lg flex items-center justify-center text-muted hover:text-foreground transition-colors" title="Forum">
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
        </svg>
      </button>

      <button className="w-10 h-10 rounded-lg flex items-center justify-center text-muted hover:text-foreground transition-colors" title="Analytics">
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
        </svg>
      </button>

      <div className="flex-1" />

      <button className="w-10 h-10 rounded-lg flex items-center justify-center text-muted hover:text-foreground transition-colors" title="Settings">
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
    </nav>
  );
}
