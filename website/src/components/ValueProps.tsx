import { FileCode2, Coins, Unplug, Bot } from "lucide-react";

const cards = [
  {
    icon: FileCode2,
    heading: "Zero Smart Contracts",
    body: "Add one router to your server. Configure your wallet. Your API is payment-gated — no Solidity required.",
  },
  {
    icon: Coins,
    heading: "Stablecoin Payments",
    body: "USDC on Base — fast, cheap, and denominated in dollars. No volatile tokens, no payment uncertainty.",
  },
  {
    icon: Unplug,
    heading: "Direct API Access",
    body: "After payment, buyers call your API directly with a signed token. No middleman on every request.",
  },
  {
    icon: Bot,
    heading: "Agent-Native",
    body: "Built for A2A. AI agents discover your pricing, pay, and access your endpoints — fully autonomous.",
  },
];

export default function ValueProps() {
  return (
    <section className="py-20 md:py-32">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {cards.map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.heading}
                className="rounded-card bg-surface shadow-neu p-6 md:p-8 transition-all duration-300 ease-out hover:-translate-y-0.5 hover:shadow-neu-hover"
              >
                {/* Icon well */}
                <div className="w-12 h-12 rounded-inner bg-surface shadow-neu-inset-deep flex items-center justify-center mb-5">
                  <Icon size={20} className="text-foreground" strokeWidth={2} />
                </div>

                <h3 className="font-display text-lg font-bold text-foreground leading-snug">
                  {card.heading}
                </h3>
                <p className="mt-2 font-body text-sm text-muted leading-relaxed">
                  {card.body}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
