"use client";

import dynamic from "next/dynamic";

const AgentScene = dynamic(() => import("@/components/AgentScene"), {
  ssr: false,
  loading: () => (
    <div style={{ width: "1280px", height: "550px", background: "#E8E8E8" }} />
  ),
});

export default function Hero() {
  return (
    <section className="relative pt-0 pb-20 md:pt-0 md:pb-32 overflow-hidden">
      <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
        <div className="flex justify-center pt-6">
          <AgentScene />
        </div>
      </div>

      <div
        className="mt-12"
        style={{
          backgroundImage:
            "linear-gradient(to bottom, rgba(232,232,232,1) 0%, rgba(232,232,232,0.5) 100%), url('/grid.png')",
          backgroundSize: "cover, cover",
          backgroundRepeat: "no-repeat, no-repeat",
          backgroundPosition: "center bottom, center bottom",
        }}
      >
        <div className="mx-auto max-w-7xl px-6 lg:px-8 py-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-start">
            <h1 className="text-[3rem] font-semibold tracking-tight text-foreground leading-[1.08] [font-family:var(--font-inter),sans-serif] text-left">
              Let AI agents automatically pay and access your APIs
              <span className="text-muted"> - instantly</span>
            </h1>

            <div className="text-left lg:ml-auto max-w-md">
              <p className="text-lg md:text-xl text-muted leading-relaxed font-normal [font-family:var(--font-inter),sans-serif]">
                Add a USDC paywall to any API. Agents discover your pricing, pay
                on-chain, and call your endpoints — no smart contracts, no
                platform in every request
              </p>
              <div className="mt-6 flex flex-wrap gap-4 justify-start">
                <a
                  href="#how-it-works"
                  className="inline-flex items-center justify-center rounded-button bg-foreground px-6 py-3.5 font-body text-sm font-medium text-white shadow-neu transition-all duration-300 ease-out hover:-translate-y-px hover:shadow-neu-hover active:translate-y-[0.5px] active:shadow-neu-inset min-h-[44px]"
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
