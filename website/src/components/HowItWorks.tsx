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

function DiscoveryAnimation() {
  return (
    <svg
      viewBox="0 0 800 500"
      className="w-full h-full object-contain"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <path id="discovery-arc-path" d="M 200 300 Q 400 150 600 300" />
      </defs>
      <ellipse cx="200" cy="355" rx="40" ry="15" fill="rgba(0,0,0,0.06)" />
      <ellipse cx="600" cy="355" rx="50" ry="15" fill="rgba(0,0,0,0.06)" />
      <use
        href="#discovery-arc-path"
        fill="none"
        stroke="#1a1a1a"
        strokeWidth="2"
        strokeDasharray="6 6"
        opacity="0.5"
      />
      <text
        x="400"
        y="140"
        textAnchor="middle"
        fontFamily="sans-serif"
        fontSize="18"
        fontWeight="bold"
        fill="#1a1a1a"
        opacity="0"
      >
        /.well-known/agent.json
        <animate
          attributeName="opacity"
          dur="3.7s"
          repeatCount="indefinite"
          keyTimes="0; 0.3243; 0.3783; 0.95; 1"
          values="0; 0; 1; 1; 0"
        />
      </text>
      <text
        x="200"
        y="410"
        textAnchor="middle"
        fontFamily="sans-serif"
        fontSize="14"
        fontWeight="bold"
        fill="#4a4a4a"
        letterSpacing="2"
      >
        AGENT
      </text>
      <text
        x="600"
        y="410"
        textAnchor="middle"
        fontFamily="sans-serif"
        fontSize="14"
        fontWeight="bold"
        fill="#4a4a4a"
        letterSpacing="2"
      >
        SERVER
      </text>
      <g transform="translate(160, 290)">
        <path d="M 40 0 L 80 20 L 40 40 L 0 20 Z" fill="#e8e8e8" />
        <path d="M 0 20 L 40 40 L 40 70 L 0 50 Z" fill="#a0a0a0" />
        <path d="M 40 40 L 80 20 L 80 50 L 40 70 Z" fill="#808080" />
      </g>
      <g transform="translate(555, 240)">
        <path d="M 45 0 L 90 25 L 45 50 L 0 25 Z" fill="#e8e8e8" />
        <path d="M 0 25 L 45 50 L 45 110 L 0 85 Z" fill="#a0a0a0" />
        <path d="M 45 50 L 90 25 L 90 85 L 45 110 Z" fill="#808080" />
      </g>
      <g opacity="1">
        <rect x="-12" y="-12" width="24" height="24" rx="3" fill="#1a1a1a" />
        <line x1="-6" y1="-4" x2="6" y2="-4" stroke="#f0f0f0" strokeWidth="2" />
        <line x1="-6" y1="1" x2="6" y2="1" stroke="#f0f0f0" strokeWidth="2" />
        <line x1="-6" y1="6" x2="2" y2="6" stroke="#f0f0f0" strokeWidth="2" />
        <animateMotion
          dur="3.7s"
          repeatCount="indefinite"
          calcMode="spline"
          keyTimes="0; 0.3243; 1"
          keyPoints="0; 1; 1"
          keySplines="0.45 0 0.55 1; 0 0 1 1"
        >
          <mpath href="#discovery-arc-path" />
        </animateMotion>
        <animate
          attributeName="opacity"
          dur="3.7s"
          repeatCount="indefinite"
          calcMode="discrete"
          keyTimes="0; 0.3242; 0.3243; 1"
          values="1; 1; 0; 0"
        />
      </g>
      <g opacity="0">
        <rect x="-14" y="-18" width="28" height="36" rx="4" fill="#1a1a1a" />
        <circle cx="0" cy="-6" r="4" fill="#f0f0f0" />
        <line x1="-7" y1="4" x2="7" y2="4" stroke="#f0f0f0" strokeWidth="2" />
        <line x1="-7" y1="9" x2="3" y2="9" stroke="#f0f0f0" strokeWidth="2" />
        <animateMotion
          dur="3.7s"
          repeatCount="indefinite"
          calcMode="spline"
          keyTimes="0; 0.4054; 0.7297; 1"
          keyPoints="1; 1; 0; 0"
          keySplines="0 0 1 1; 0.45 0 0.55 1; 0 0 1 1"
        >
          <mpath href="#discovery-arc-path" />
        </animateMotion>
        <animate
          attributeName="opacity"
          dur="3.7s"
          repeatCount="indefinite"
          calcMode="discrete"
          keyTimes="0; 0.4053; 0.4054; 0.999; 1"
          values="0; 0; 1; 1; 0"
        />
      </g>
    </svg>
  );
}

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
          {/* Single section: header full width, then two columns (code | animation) */}
          <div className="rounded-card bg-surface shadow-neu-inset-deep p-6 md:p-8 flex flex-col min-h-0 h-[424px] md:h-[484px]">
            {/* Step header — full width above columns */}
            <div className="flex items-center gap-3 mb-4 shrink-0">
              <div className="w-10 h-10 rounded-inner bg-surface shadow-neu-sm flex items-center justify-center shrink-0">
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

            {/* Two columns: code left, animation right — one block, gutter between */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6 flex-1 min-h-0">
              <pre className="overflow-auto rounded-inner bg-surface shadow-neu-inset p-4 md:p-5 font-mono text-xs md:text-sm leading-relaxed text-foreground whitespace-pre-wrap min-h-0">
                {tabs[active].code}
              </pre>
              <div className="flex items-center justify-center min-h-[160px] lg:min-h-0 overflow-hidden">
                {active === 0 ? (
                  <DiscoveryAnimation />
                ) : (
                  <span className="font-body text-sm text-muted">
                    Animation (step {active + 1})
                  </span>
                )}
              </div>
            </div>
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
