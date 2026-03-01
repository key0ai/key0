# Key2A — Landing Page Design Brief

_Working document. Updated section by section as decisions are finalized._

---

## 1. Header

- **Left:** Key2A logo / wordmark
- **Centre nav:** How it Works · Docs · FAQs
- **Right CTA:** GitHub button with live star count
- **Behaviour:** Sticky — stays fixed at top of viewport on scroll
- **No** user account, login, or pricing links

---

## 2. Hero

- **Layout:** Two column — copy on the left, video on the right
- **Tagline:** "Let AI agents pay for your API and get to work — instantly"
- **Right side:** Explainer video (placeholder for now, to be produced separately)
- **Primary CTA:** "Try it now" → scrolls to interactive demo on the page
- **Secondary CTA:** "Read the Docs" → links to documentation

---

## 3. How it Works

- **Layout:** 80% width, centered on page
- **Top:** Animation area — synced to whichever tab is active below
- **Bottom:** 4 auto-playing tabs — 1. Discover · 2. Request · 3. Pay · 4. Access
- **Tab behaviour:** Auto-advances between tabs. Pauses on hover or manual click. Subtle progress bar fills on each tab before advancing.
- **Animation sync:** Animation content changes in sync with the active tab (e.g. USDC transfer shown on Pay tab, JWT shown on Access tab)
- **Below tabs:** Closing line + CTA
- **Closing line:** "Your existing API, now accessible to the entire agent web."
- **CTA:** "Explore Docs"

---

## 4. Value Props

- **Layout:** Row of 4 cards — icon + bold heading + one sentence each
- **Cards:** TBD (to be finalised later)

---

## 5. Coming Soon

- **Purpose:** Signal upcoming payment rails and integrations to reduce "crypto only" concern
- **Potential integrations to show:** Mastercard, Visa, UPI
- **Layout:** TBD

---

## 6. Footer

- **One-liner:** TBD
- **Links:** How it Works · Docs · FAQs · GitHub
- **Social links:** TBD
- **Layout:** Minimal

---

## 7. Design Language & Visual Style

**Color scheme:** Monochrome only — black, white, and grayscale. No hue; no colored accents.

### Design System: Neumorphism (Soft UI)

**Philosophy:** Elements appear to extrude from or be pressed into a single continuous surface. The effect mimics soft, pillowed physical objects with realistic lighting — tactile, calm, and physically grounded. Every element feels molded from the same material, never flat.

**Vibe:** Matte charcoal and light gray. Restrained, modern, editorial. Satisfying and tangible.

---

### Color Tokens (Grayscale Only)

| Token | Value | Usage |
|---|---|---|
| Background | `#E8E8E8` | Base surface — everything molded from this |
| Foreground | `#1a1a1a` | Primary text (≈12:1 contrast on background) |
| Muted | `#737373` | Secondary text (WCAG AA, ~4.6:1) |
| Accent | `#1a1a1a` | CTAs, focus states — dark/black |
| Accent Light | `#404040` | Hover states (slightly lighter dark) |
| Accent Secondary | `#525252` | Success states, positive indicators (mid-dark gray) |
| Border | `transparent` | Never use borders — shadows define all edges |

**Shadow colors (RGBA only — grayscale):**
- Light shadow: `rgba(255, 255, 255, 0.55–0.65)` — top-left light source
- Dark shadow: `rgba(0, 0, 0, 0.12–0.18)` — bottom-right dark shadow

---

### Typography

| Role | Font | Weight |
|---|---|---|
| Display / Headlines | Plus Jakarta Sans | 500, 600, 700, 800 |
| Body / UI | DM Sans | 400, 500, 700 |

- Display headings: `font-extrabold` (800), `tracking-tight`
- Body: `font-normal` to `font-medium`
- Scale: `text-sm` (14px) up to `text-7xl` (72px) for hero

---

### Radius

| Context | Value |
|---|---|
| Container / Card | `32px` |
| Button / Base | `16px` |
| Inner elements | `12px` or `9999px` (full) |

---

### Shadow System (The Physics) — Grayscale

**Extruded (default resting):**
```css
box-shadow: 9px 9px 16px rgba(0,0,0,0.14), -9px -9px 16px rgba(255,255,255,0.6);
```

**Extruded Hover (lifted):**
```css
box-shadow: 12px 12px 20px rgba(0,0,0,0.18), -12px -12px 20px rgba(255,255,255,0.65);
```

**Inset (pressed / shallow well):**
```css
box-shadow: inset 6px 6px 10px rgba(0,0,0,0.14), inset -6px -6px 10px rgba(255,255,255,0.55);
```

**Inset Deep (inputs, active wells):**
```css
box-shadow: inset 10px 10px 20px rgba(0,0,0,0.18), inset -10px -10px 20px rgba(255,255,255,0.6);
```

---

### Component Rules

**Buttons**
- Shape: `rounded-2xl`
- Default: Extruded shadow
- Hover: `translateY(-1px)` + Extruded Hover shadow
- Active: `translateY(0.5px)` + Inset shadow
- Primary: Accent background `#1a1a1a`, text white
- Secondary: Background matches page `#E8E8E8`, text `#1a1a1a`

**Cards**
- Shape: `rounded-[32px]`
- Background: `#E8E8E8`
- Hover: `translateY(-2px)` + Extruded Hover shadow
- Nested depth: Card (Extruded) → Icon well (Inset Deep) → Icon

**Inputs**
- Shape: `rounded-2xl`
- Default: Inset shadow
- Focus: Inset Deep shadow + ring in `#1a1a1a` (accent)

---

### Animation & Micro-interactions

- Duration: `300ms` UI elements, `500ms` nested/decorative
- Easing: `ease-out`
- Hover: Cards lift `-1px`, buttons lift `-1px` then press `+0.5px` on active
- Floating animation: `3s ease-in-out infinite` for ambient decorative motion
- Smooth scroll: `scroll-behavior: smooth`

---

### Layout Principles

- Spacing: Open and airy — `py-32` for hero sections
- Container: `max-w-7xl`
- Background: `#E8E8E8` globally — no gradients on root background; grayscale only

---

### Responsive

- Mobile-first
- Breakpoints: `md:` (768px), `lg:` (1024px)
- Touch targets: minimum 44×44px
- Mobile nav: Hamburger menu with open/close states
- Grids collapse: 3-col → 1-col on mobile
- Hero font: `text-7xl` → `text-5xl` on mobile

---

### Anti-Patterns (Do Not)

- No hard hex shadows — always use `rgba`
- No `bg-white` on cards — must match `#E8E8E8`
- No flat buttons — always add shadow depth
- No sharp corners — minimum `rounded-2xl`
- No low-contrast text — use `#737373` or darker
- No missing focus states on interactive elements
- No color — no hue; black, white, and grayscale only

---
