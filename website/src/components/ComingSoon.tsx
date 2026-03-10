const rails = [
  { label: "Mastercard", src: "/MC.png" },
  { label: "Visa", src: "/visa.png" },
  { label: "UPI", src: "/upi.png" },
];

export default function ComingSoon() {
  return (
    <section className="py-20 md:py-32">
      <div className="mx-auto max-w-3xl px-6 lg:px-8 text-center">
        <span className="inline-block font-body text-xs font-medium uppercase tracking-widest text-muted mb-4">
          Coming soon
        </span>
        <h2 className="font-display text-3xl md:text-4xl font-extrabold tracking-tight text-foreground">
          More payment rails on the way
        </h2>
        <p className="mt-4 font-body text-base text-muted max-w-xl mx-auto leading-relaxed">
          USDC on Base is just the start. We&apos;re adding traditional payment
          methods so every buyer can pay however they prefer.
        </p>

        <div className="mt-12 flex flex-wrap justify-center gap-4 md:gap-6">
          {rails.map((rail) => (
            <div
              key={rail.label}
              className="flex items-center gap-3 rounded-button bg-surface shadow-neu px-5 py-3.5 transition-all duration-300 ease-out hover:-translate-y-px hover:shadow-neu-hover"
            >
              <div className="w-9 h-9 rounded-inner bg-surface shadow-neu-inset flex items-center justify-center overflow-hidden">
                <img
                  src={rail.src}
                  alt={rail.label}
                  className="h-5 w-auto object-contain"
                />
              </div>
              <span className="font-body text-sm font-medium text-foreground">
                {rail.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
