const footerLinks = [
  { label: "How it Works", href: "#how-it-works" },
  { label: "Docs", href: "#" },
  { label: "FAQs", href: "#" },
  { label: "GitHub", href: "#" },
];

export default function Footer() {
  return (
    <footer className="py-12 md:py-16">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="rounded-card bg-surface shadow-neu p-8 md:p-12">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            {/* Brand + tagline */}
            <div>
              <img
                src="/Logo-New.svg?v=2"
                alt="Key2A"
                className="h-[2.1rem] w-auto"
                width={111}
                height={35}
              />
              <p className="mt-1 font-body text-sm text-muted">
                Your API, payment-enabled for the agent economy.
              </p>
            </div>

            {/* Links */}
            <nav
              className="flex flex-wrap items-center gap-6"
              aria-label="Footer"
            >
              {footerLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  className="font-body text-sm text-muted transition-colors duration-300 ease-out hover:text-foreground"
                >
                  {link.label}
                </a>
              ))}
            </nav>
          </div>

          <div className="mt-8 pt-6 border-t border-black/[0.06]">
            <p className="font-body text-xs text-muted text-center md:text-left">
              &copy; {new Date().getFullYear()} Key2A. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
