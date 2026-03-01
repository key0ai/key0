# Key2A Website — Implementation Checklist

What’s needed to get the site from design brief → live.

---

## 1. Decisions (need your input or defaults)

| Item | Status | Notes |
|------|--------|--------|
| **Tech stack** | TBD | Suggest: **Next.js** (React) + **Tailwind** for design tokens and SSR, or **Astro** for a content-heavy marketing page. |
| **Docs URL** | TBD | Where do “Read the Docs” / “Explore Docs” link? (e.g. `https://docs.key2a.com` or `/docs`) |
| **GitHub repo URL** | TBD | For header CTA. Star count: static for now, or GitHub API later. |
| **FAQs** | TBD | In-page anchor (`#faqs`) or separate page? |

---

## 2. Assets

| Asset | Status | Notes |
|------|--------|--------|
| **Key2A logo / wordmark** | Missing | Can ship with **text wordmark** “Key2A” using Plus Jakarta Sans; replace with logo asset when ready. |
| **Hero video** | Placeholder | Brief says placeholder OK. Use a neutral gray neumorphic frame + “Video coming soon” or silent placeholder. |
| **Value prop icons** | TBD | Use icon set (e.g. Lucide, Heroicons) in monochrome; or you provide SVGs. |
| **How it Works tab visuals** | TBD | Per-tab content: Discover (agent card), Request (challenge), Pay (USDC), Access (JWT). Can be code snippets + simple diagrams or illustrations. |

---

## 3. Copy (can use placeholders)

| Section | Status | Notes |
|--------|--------|--------|
| **Value Props (4 cards)** | TBD in brief | Need: icon + heading + one sentence each. Can use placeholder copy from product overview. |
| **Footer one-liner** | TBD in brief | e.g. “Payment-gated APIs for the agent economy.” |
| **Footer social links** | TBD | Twitter/X, LinkedIn, etc. — or omit until you provide. |
| **Coming Soon layout** | TBD | Mastercard, Visa, UPI mentioned; layout TBD. Simple logo row + “Coming soon” is enough to ship. |

---

## 4. Interactive demo (“Try it now”)

- **Brief:** Primary CTA scrolls to “interactive demo” on the page.
- **Options:**  
  - **A)** Step-through of the 4 steps (Discover → Request → Pay → Access) with short copy + optional code snippets.  
  - **B)** Embedded iframe to a live demo (e.g. StackBlitz) — needs URL.  
  - **C)** Simple animated diagram of the flow, no real API calls.
- **Recommendation:** Start with **A** (step-through + snippets from INTERACTION_BREAKDOWN) so the page is self-contained; no backend required.

---

## 5. Build steps (once the above are decided)

1. **Scaffold** — Create app in `website/` (e.g. Next.js + Tailwind).
2. **Design tokens** — CSS variables or Tailwind theme from design-brief.md (grayscale, shadows, radius, typography).
3. **Components** — Header, Hero, How it Works (tabs + animation area), Value Props, Coming Soon, Footer; buttons and cards per brief.
4. **Content** — Drop in copy (final or placeholder), link Docs/GitHub/FAQs.
5. **Responsive** — Mobile-first, hamburger nav, breakpoints per brief.
6. **Polish** — Focus states, smooth scroll, optional motion (e.g. tab progress, card hover).

---

## 6. What you can say to unblock

- **“Use placeholders for everything TBD”** → We can ship with placeholder copy, “Key2A” text logo, gray video box, and generic value prop text.
- **“Docs at [URL], GitHub at [URL]”** → Links go in.
- **“Tech: Next.js”** (or Astro / Vite) → Scaffold and tokens follow.
- **“Interactive demo = step-through of 4 steps”** → We implement option A.

Once these are set (or defaulted), the site can be implemented section by section from the design brief.

---

## Text Along Path (Fancy Component)

A **Text Along Path** separator (from [Fancy Components](https://www.fancycomponents.dev/docs/components/text/text-along-path)) is used between the Hero and How it Works sections.

- **Location:** `src/components/HeroHowItWorksSeparator.tsx` (uses `src/components/fancy/text/text-along-path.tsx`).
- **Dependency:** `motion` (framer-motion).
- **Behaviour:** Auto-playing text along a gentle wave path; text: "Discover · Request · Pay · Access" repeated. To switch to scroll-driven animation, use `animationType="scroll"` and pass `scrollContainer` (ref to scrollable element) and optionally `scrollOffset` / `scrollTransformValues`.
