"use client";

import TextAlongPath from "@/components/fancy/text/text-along-path";

const WAVE_PATH =
  "M1 80C180 80 220 40 400 40C580 40 620 80 800 80C980 80 1020 40 1200 40C1380 40 1420 80 1599 80";

const TEXT =
  "\u00B7 YOUR API  PAYMENT-ENABLED FOR THE AGENT ECONOMY \u00B7 ";

export default function HeroHowItWorksSeparator() {
  return (
    <div
      className="relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen overflow-hidden py-4 md:py-8"
      aria-hidden
    >
      <section className="relative w-full h-20 md:h-28 text-foreground">
        <TextAlongPath
          path={WAVE_PATH}
          pathId="separator-wave"
          viewBox="0 0 1600 120"
          text={TEXT}
          textClassName="text-[30px] font-semibold tracking-wider"
          animationType="auto"
          duration={10}
          repeatCount="indefinite"
          textAnchor="start"
          preserveAspectRatio="xMidYMid meet"
          svgClassName="w-full h-full"
        />
      </section>
    </div>
  );
}
