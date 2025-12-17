"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";

export function AppHeader() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname?.startsWith(href + "/");

  const navLink = (href: string, label: string) => (
    <Link
      href={href}
      className={cn(
        "text-sm px-3 py-2 rounded-lg transition-colors",
        isActive(href)
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
      )}
    >
      {label}
    </Link>
  );

  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto max-w-5xl px-4 py-3 flex items-center gap-3">
        <Link href="/" className="font-semibold">
          Any-Speak
        </Link>

        <nav className="flex items-center gap-1">
          {navLink("/", "Home")}
          {navLink("/learn", "Learn")}
          {navLink("/pricing", "Pricing")}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
