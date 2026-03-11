"use client";

import { useRef, useEffect, useState } from "react";
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

const SNAP_POINTS = [0, 700, 1400];
const COOLDOWN_MS = 650;
const HERO_ZONE_END = SNAP_POINTS[SNAP_POINTS.length - 1];

export default function Hero() {
  const animating = useRef(false);
  const [scenePhase, setScenePhase] = useState(0);

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      const y = window.scrollY;
      if (y > HERO_ZONE_END + 60) return;
      if (animating.current) { e.preventDefault(); return; }

      let snap = 0;
      for (let i = SNAP_POINTS.length - 1; i >= 0; i--) {
        if (y >= SNAP_POINTS[i] - 25) { snap = i; break; }
      }

      const next = snap + (e.deltaY > 0 ? 1 : -1);
      if (next < 0 || next >= SNAP_POINTS.length) return;

      e.preventDefault();
      animating.current = true;
      setScenePhase(next === 1 ? 1 : 0);
      window.scrollTo({ top: SNAP_POINTS[next], behavior: "smooth" });
      setTimeout(() => { animating.current = false; }, COOLDOWN_MS);
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, []);

  return (
    <section className="relative" style={{ height: "calc(100vh + 1400px)" }}>
      <div className="sticky top-0 h-screen w-full overflow-hidden">

        {/* Canvas */}
        <div className="absolute inset-x-0 top-[72px] z-10 flex justify-center px-6 lg:px-8">
          <div className="w-full max-w-[1280px]">
            <AgentScene phase={scenePhase} />
          </div>
        </div>

        {/* Home info section */}
        <div
          className="absolute inset-x-0 bottom-0 z-30"
          style={{
            backgroundImage:
              "linear-gradient(to bottom, rgba(232,232,232,1) 0%, rgba(232,232,232,0.6) 100%), url('/grid.png')",
            backgroundSize: "cover, cover",
            backgroundRepeat: "no-repeat, no-repeat",
            backgroundPosition: "center bottom, center bottom",
            paddingBottom: "8px",
          }}
        >
          <div className="mx-auto max-w-7xl px-6 lg:px-8 py-12">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-10 lg:gap-16 items-stretch">
              <div className="flex flex-col justify-center">
                <h1 className="text-[3rem] font-semibold tracking-tight text-foreground leading-[1.08] [font-family:var(--font-inter),sans-serif] text-center lg:text-left">
                  Let AI agents automatically pay and access your APIs
                </h1>
                <div className="mt-6 flex flex-wrap gap-4 justify-center lg:justify-start">
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

              <div className="flex flex-col text-left">
                <ul className="text-lg text-muted leading-relaxed font-normal [font-family:var(--font-inter),sans-serif] space-y-5 list-none pl-0">
                  <li
                    className="flex items-center gap-6 origin-left transition-all duration-500 ease-out"
                    style={{
                      transform: scenePhase === 1 ? "scale(1.2)" : "scale(1)",
                      opacity: 1,
                    }}
                  >
                    <div className="mt-1 flex h-14 w-14 items-center justify-center rounded-full bg-surface shadow-neu-sm">
                      <img src="/agent.svg" alt="Agent icon" className="h-9 w-9" />
                    </div>
                    <div>
                      <span className="block text-xl font-bold text-foreground">Every Agent, Every Protocol</span>
                      <span>HTTP, MCP, and A2A - out of the box</span>
                    </div>
                  </li>
                  <li
                    className="flex items-center gap-6 transition-opacity duration-500 ease-out"
                    style={{ opacity: scenePhase === 1 ? 0.4 : 1 }}
                  >
                    <div className="mt-1 flex h-14 w-14 items-center justify-center rounded-full bg-surface shadow-neu-sm">
                      <img src="/opensource.svg" alt="Open source icon" className="h-9 w-9" />
                    </div>
                    <div>
                      <span className="block text-xl font-bold text-foreground">Open Source</span>
                      <span>Your stack, your rules, no proxies</span>
                    </div>
                  </li>
                  <li
                    className="flex items-center gap-6 transition-opacity duration-500 ease-out"
                    style={{ opacity: scenePhase === 1 ? 0.4 : 1 }}
                  >
                    <div className="mt-1 flex h-14 w-14 items-center justify-center rounded-full bg-surface shadow-neu-sm">
                      <img src="/payment.svg" alt="Payment icon" className="h-9 w-9" />
                    </div>
                    <div>
                      <span className="block text-xl font-bold text-foreground">Any Payment Rail</span>
                      <span>USDC today. Visa, Mastercard, and UPI coming soon</span>
                    </div>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
