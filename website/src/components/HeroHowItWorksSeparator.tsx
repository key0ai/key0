"use client";

const TEXT =
  "\u00B7 YOUR API  PAYMENT-ENABLED FOR THE AGENT ECONOMY \u00B7 ";

export default function HeroHowItWorksSeparator() {
  return (
    <div
      className="relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen overflow-hidden py-4 md:py-8"
      aria-hidden
    >
      <section className="relative w-full bg-[#101010] text-white py-4 md:py-6">
        <div className="flex items-center justify-center">
          <p className="text-center text-[24px] md:text-[30px] font-semibold tracking-wider">
            {TEXT}
          </p>
        </div>
      </section>
    </div>
  );
}
