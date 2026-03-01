import { Play } from "lucide-react";
import { FlickeringGrid } from "@/components/ui/flickering-grid";

export default function Hero() {
  return (
    <section className="relative pt-32 pb-20 md:pt-40 md:pb-32 overflow-hidden">
      <FlickeringGrid
        className="absolute inset-0 z-0"
        squareSize={4}
        gridGap={6}
        color="#737373"
        maxOpacity={0.1}
        flickerChance={0.1}
      />
      <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Copy */}
          <div className="max-w-xl">
            <h1 className="font-display text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tight text-foreground leading-[1.08]">
              Let AI agents pay for your API and get to work
              <span className="text-muted"> — instantly</span>
            </h1>

            <p className="mt-6 font-body text-lg md:text-xl text-muted leading-relaxed">
              Add a USDC paywall to any API. Agents discover your pricing, pay
              on-chain, and call your endpoints — no smart contracts, no
              platform in every request.
            </p>

            <div className="mt-10 flex flex-wrap gap-4">
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

          {/* Video placeholder */}
          <div className="relative w-full aspect-video rounded-card bg-surface shadow-neu-inset-deep flex flex-col items-center justify-center gap-4">
            <div className="w-16 h-16 rounded-full bg-surface shadow-neu flex items-center justify-center">
              <Play size={24} className="text-muted ml-0.5" strokeWidth={2} />
            </div>
            <p className="font-body text-sm text-muted">
              Explainer video coming soon
            </p>

            {/* Floating key icon */}
            <img
              src="/Key.svg"
              alt=""
              aria-hidden="true"
              className="absolute -bottom-8 -right-6 md:-bottom-12 md:-right-10 w-24 h-auto md:w-[7.5rem] opacity-80 animate-float pointer-events-none select-none"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
