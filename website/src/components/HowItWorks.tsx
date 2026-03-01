"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Search, MessageSquareText, CircleDollarSign, KeyRound } from "lucide-react";

const INTERVAL_MS = 5000;

const tabs = [
  {
    label: "Discover",
    icon: Search,
    heading: "Fetch the agent card",
    code: `GET /.well-known/agent.json

{
  "name": "Photo API",
  "skills": [{
    "id": "request-access",
    "pricing": [
      { "tier": "single", "amount": "$0.10", "asset": "USDC" },
      { "tier": "album",  "amount": "$1.00", "asset": "USDC" }
    ]
  }]
}`,
  },
  {
    label: "Request",
    icon: MessageSquareText,
    heading: "Request access to a resource",
    code: `POST /agent  →  AccessRequest
{
  "resourceId": "photo-1",
  "tierId": "single"
}

← X402Challenge
{
  "amount": "$0.10",
  "asset": "USDC",
  "destination": "0x1a2b…3c4d",
  "expiresAt": "2026-03-01T12:05:00Z"
}`,
  },
  {
    label: "Pay",
    icon: CircleDollarSign,
    heading: "Send USDC on Base",
    code: `USDC Transfer on Base

From:   0xBuyerWallet
To:     0xSellerWallet
Amount: 0.10 USDC

✓  Confirmed
   txHash: 0xabc…def`,
  },
  {
    label: "Access",
    icon: KeyRound,
    heading: "Get a token and call the API",
    code: `POST /agent  →  PaymentProof
{ "txHash": "0xabc…def" }

← AccessGrant
{ "accessToken": "eyJhbG…",
  "resourceEndpoint": "/api/photos/photo-1" }

GET /api/photos/photo-1
Authorization: Bearer eyJhbG…

← { "id": "photo-1", "url": "…", "title": "Sunset" }`,
  },
];

export default function HowItWorks() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [progressKey, setProgressKey] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const advance = useCallback(() => {
    setActive((prev) => (prev + 1) % tabs.length);
    setProgressKey((k) => k + 1);
  }, []);

  const goTo = useCallback((idx: number) => {
    setActive(idx);
    setProgressKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(advance, INTERVAL_MS);
    return () => clearInterval(id);
  }, [paused, advance]);

  const Icon = tabs[active].icon;

  return (
    <section id="how-it-works" className="py-20 md:py-32">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <h2 className="font-display text-3xl md:text-4xl lg:text-5xl font-extrabold tracking-tight text-foreground text-center">
          How it works
        </h2>
        <p className="mt-4 font-body text-lg text-muted text-center max-w-2xl mx-auto">
          Four steps from discovery to API access — fully automated for AI
          agents.
        </p>

        {/* Animation + Tabs container */}
        <div
          ref={containerRef}
          className="mt-14"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          {/* Animation area */}
          <div className="rounded-card bg-surface shadow-neu-inset-deep p-6 md:p-8 h-[320px] md:h-[380px] flex flex-col">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-inner bg-surface shadow-neu-sm flex items-center justify-center">
                <Icon size={18} className="text-foreground" strokeWidth={2} />
              </div>
              <div>
                <span className="font-body text-xs font-medium text-muted uppercase tracking-wider">
                  Step {active + 1}
                </span>
                <h3 className="font-display text-base font-bold text-foreground leading-snug">
                  {tabs[active].heading}
                </h3>
              </div>
            </div>
            <pre className="flex-1 overflow-auto rounded-inner bg-surface shadow-neu-inset p-4 md:p-5 font-mono text-xs md:text-sm leading-relaxed text-foreground whitespace-pre-wrap">
              {tabs[active].code}
            </pre>
          </div>

          {/* Tabs */}
          <div className="mt-6 w-[60%] mx-auto grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
            {tabs.map((tab, i) => {
              const TabIcon = tab.icon;
              const isActive = active === i;

              return (
                <button
                  key={tab.label}
                  onClick={() => goTo(i)}
                  className={`relative flex flex-col items-start gap-2 rounded-button p-4 font-body text-sm font-medium transition-all duration-300 ease-out text-left min-h-[44px] ${
                    isActive
                      ? "bg-surface shadow-neu-inset text-foreground"
                      : "bg-surface shadow-neu text-muted hover:-translate-y-px hover:shadow-neu-hover hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <TabIcon size={16} strokeWidth={2} />
                    <span>
                      {i + 1}. {tab.label}
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div className="w-full h-1 rounded-full bg-surface shadow-neu-inset overflow-hidden">
                    {isActive && (
                      <div
                        key={progressKey}
                        className={`h-full rounded-full bg-foreground progress-bar-active ${
                          paused ? "progress-bar-paused" : ""
                        }`}
                      />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Closing line + CTA */}
        <div className="mt-14 text-center">
          <p className="font-display text-xl md:text-2xl font-bold text-foreground">
            Your existing API, now accessible to the entire agent web.
          </p>
          <div className="mt-6">
            <a
              href="#"
              className="inline-flex items-center justify-center rounded-button bg-foreground px-6 py-3.5 font-body text-sm font-medium text-white shadow-neu transition-all duration-300 ease-out hover:-translate-y-px hover:shadow-neu-hover active:translate-y-[0.5px] active:shadow-neu-inset min-h-[44px]"
            >
              Explore Docs
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
