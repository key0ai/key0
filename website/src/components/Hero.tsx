"use client";

import dynamic from "next/dynamic";

const AgentScene = dynamic(() => import("@/components/AgentScene"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        width: "100%",
        maxWidth: "1280px",
        aspectRatio: "1280 / 550",
        background: "#E8E8E8",
      }}
    />
  ),
});

export default function Hero() {
  return (
    <section className="relative pt-0 pb-20 md:pt-0 overflow-hidden">
      <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
        <div className="flex justify-center w-full pt-0 md:pt-6 mt-[72px] md:mt-0">
          <div className="w-full max-w-[1280px]">
            <AgentScene />
          </div>
        </div>
      </div>

      <div
        className="mt-0 md:mt-12 pt-6 md:pt-0"
        style={{
          backgroundImage:
            "linear-gradient(to bottom, rgba(232,232,232,1) 0%, rgba(232,232,232,0.5) 100%), url('/grid.png')",
          backgroundSize: "cover, cover",
          backgroundRepeat: "no-repeat, no-repeat",
          backgroundPosition: "center bottom, center bottom",
        }}
      >
        <div className="mx-auto max-w-7xl px-6 lg:px-8 py-12">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-10 lg:gap-16 items-stretch">
            <div className="flex flex-col justify-center">
              <h1 className="text-[3rem] font-semibold tracking-tight text-foreground leading-[1.08] [font-family:var(--font-inter),sans-serif] text-center lg:text-left">
                Let AI agents automatically pay and access your APIs
                <span className="text-muted"> - instantly</span>
              </h1>
            </div>

            <div className="flex flex-col text-left">
              <ul className="text-lg text-muted leading-relaxed font-normal [font-family:var(--font-inter),sans-serif] space-y-2 list-none pl-0">
                <li><span className="font-bold text-foreground">Every Agent, Every Protocol</span> HTTP, MCP, and A2A - out of the box</li>
                <li><span className="font-bold text-foreground">Your Stack, Your Rules</span> Open source, non-proxied. Plug into what you already have</li>
                <li><span className="font-bold text-foreground">Any Payment Rail</span> USDC today. Visa, Mastercard, and UPI coming</li>
              </ul>
              <div className="mt-6 flex flex-wrap gap-4 justify-start">
                <a
                  href="#how-it-works"
                  className="inline-flex items-center justify-center rounded-button bg-[#1a1a1a] px-6 py-3.5 font-body text-sm font-medium text-white shadow-neu transition-all duration-300 ease-out hover:-translate-y-px hover:shadow-neu-hover active:translate-y-[0.5px] active:shadow-neu-inset min-h-[44px]"
                >
                  Try it now
                </a>
                <a
                  href="#"
                  className="inline-flex items-center justify-center rounded-button bg-surface px-6 py-3.5 font-body text-sm font-medium text-foreground shadow-neu transition-all duration-300 ease-out hover:-translate-y-px hover:shadow-neu-hover active:translate-y-[0.5px] active:shadow-neu-inset min-h-[44px]"
                >
                  Read the Docs
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
