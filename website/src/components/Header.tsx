"use client";

import { useState } from "react";
import { Menu, X, Github } from "lucide-react";

const navLinks = [
  { label: "How it Works", href: "#how-it-works" },
  { label: "Docs", href: "#" },
];

export default function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-surface/95 backdrop-blur-sm">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <a href="#" className="flex items-center shrink-0 bg-transparent" aria-label="Key2A home">
            <img
              src="/Logo-New.svg?v=2"
              alt="Key2A"
              className="h-10 w-auto md:h-11 block"
              width={158}
              height={50}
            />
          </a>

          {/* Desktop nav + GitHub (right-aligned) */}
          <div className="hidden md:flex items-center gap-6">
            <nav className="flex items-center gap-6" aria-label="Main">
              {navLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  className="font-body text-sm font-medium text-muted transition-colors duration-300 ease-out hover:text-foreground"
                >
                  {link.label}
                </a>
              ))}
            </nav>
            <a
              href="#"
              className="inline-flex items-center gap-2 rounded-button bg-surface px-4 py-2 font-body text-sm font-medium text-foreground shadow-neu transition-all duration-300 ease-out hover:-translate-y-px hover:shadow-neu-hover active:translate-y-[0.5px] active:shadow-neu-inset"
            >
              <Github size={16} strokeWidth={2} />
              <span>GitHub</span>
            </a>
          </div>

          {/* Mobile hamburger */}
          <button
            className="md:hidden flex items-center justify-center w-11 h-11 rounded-button bg-surface shadow-neu-sm transition-all duration-300 ease-out active:shadow-neu-inset"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? (
              <X size={20} strokeWidth={2} />
            ) : (
              <Menu size={20} strokeWidth={2} />
            )}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <nav
          className="md:hidden border-t border-transparent bg-surface px-6 pb-6 pt-4"
          aria-label="Mobile"
        >
          <div className="flex flex-col gap-4">
            {navLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className="font-body text-base font-medium text-muted transition-colors duration-300 ease-out hover:text-foreground py-2"
              >
                {link.label}
              </a>
            ))}
            <a
              href="#"
              className="inline-flex items-center gap-2 justify-center rounded-button bg-surface px-4 py-3 font-body text-sm font-medium text-foreground shadow-neu transition-all duration-300 ease-out active:shadow-neu-inset"
            >
              <Github size={16} strokeWidth={2} />
              <span>GitHub</span>
            </a>
          </div>
        </nav>
      )}
    </header>
  );
}
