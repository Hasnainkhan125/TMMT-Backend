# Qumak — Pivot Wedge & Seed-Stage Roadmap

> **Owner:** Founders
> **Audience:** Seed investors, founding team, advisors
> **Status:** Active — replaces all prior "AI infrastructure for 2026 businesses" framing
> **One-line:** Qumak is the **Arabic-first AI ad agency for GCC SMEs**.

---

## 1. The wedge (what we are *now*)

Paste your Instagram handle → get **10 Arabic + English ads** in 60 seconds → push to **Meta / Snap / TikTok MENA** in one click → **previews delivered on WhatsApp** for sign-off.

Pricing: **AED 99 / 199 / 399 per month**, billed via Stripe + Tabby + Tamara.

That is the entire seed-stage product. Everything below is parked.

### Why this wedge

| Wedge requirement | Qumak fit |
|---|---|
| Painful, frequent, paid problem | UAE/KSA SMEs spend AED 1k–50k/mo on agencies that take weeks to deliver mediocre Arabic creative. |
| Narrow ICP | UAE/KSA F&B, retail, gyms, salons, real estate — owner-operated, 1–25 staff, already on Snap/Meta. |
| Existing infra | Studio (image+video gen) + WhatsApp shim + Stripe + Apollo lead engine all live in this repo today. |
| Defensible | TopView/Creatify/Higgsfield/Omneky are English-first. Arabic dialect prompts + RTL creative + WhatsApp delivery + Tabby/Tamara billing is a moat no English-first vendor will replicate cheaply. |
| Channel-fit | Snap MENA, TikTok MENA, Meta MENA reps actively want SME tooling — distribution doors are open. |

### Why **not** the original pitch

The original pitch ("AI infrastructure for 2026 businesses: ads + ecommerce + events + suppliers + Hapag-Lloyd + payments + business marketplace") fails the Shark Tank smell test for three reasons:

1. **Non-buyer.** No CFO at any company line-items "AI infrastructure for 2026." They line-item *ad spend, agency retainers, payment fees.*
2. **Surface area > team capacity.** A seed team cannot ship trade-license filing, customs brokerage, supplier networks, and a business-buying marketplace and beat focused competitors in any of them.
3. **No moat per surface.** Each surface has a $50M+ funded incumbent (Marketplace = Flippa; Suppliers = Alibaba; Payments = Stripe/Tabby; Trade license = government portals; Ads = Creatify/Omneky). Zero of those incumbents have an Arabic-first ad gen product. *That* is where we win.

---

## 2. Descope list (parked behind feature flags)

The following remain in the codebase but are **not** in the seed roadmap, **not** in the pitch deck, and **not** part of any GTM motion until the wedge hits the milestones in §6:

- Visa / immigration
- Trade license filing
- Business marketplace (`/api/v1/marketplace/*`) — keep as a roadmap teaser only
- Business-buying / acquisitions
- Supplier sourcing (Hapag-Lloyd / Chinese supplier connections)
- Ecommerce store builder + product catalog
- Payment collection from end-customers (we collect *from SMEs*, not for them)

These are the punchline of the deck's "platform vision" slide — **not** the demo, **not** the MVP, **not** the metric we report.

---

## 3. Competitive positioning (one slide)

| Vendor | Geo | Language | Ad delivery | Billing | Notes |
|---|---|---|---|---|---|
| Higgsfield | Global | EN | None (creative only) | USD | Cinematic gen, no media-buying loop |
| Creatify | US | EN | Meta/TikTok | USD | English-first, weak on RTL |
| TopView | US | EN | Meta/TikTok | USD | UGC-style, no MENA presence |
| Omneky | US | EN | Meta/Google | USD | Enterprise, US/EU only |
| TryHolo | US | EN | None | USD | Creative tool |
| Nas.io | Global | EN | N/A (community) | USD | Different category |
| **Qumak** | **GCC** | **AR + EN** | **Meta + Snap + TikTok MENA + WhatsApp delivery** | **AED via Stripe + Tabby + Tamara** | Arabic dialect prompts, RTL creative, Gulf-native pricing |

We are not "another Creatify." We are **the only Arabic-first one**.

---

## 4. ICP (kill all others until the wedge converts)

- **Primary:** UAE F&B owner, 2–10 locations, AED 5k–25k/mo Meta+Snap spend, currently using a Dubai agency or doing it themselves.
- **Secondary:** KSA fashion/perfume e-tailer, AED 10k–50k/mo Meta spend, runs Ramadan / White Friday / National Day campaigns.
- **Tertiary:** UAE/KSA salon, gym, real estate brokerage with the same spend profile.

If a lead does not match one of those three, decline politely. Do not chase enterprise. Do not chase US/EU. Do not chase non-GCC Arabic markets (Egypt, Levant) until UAE+KSA hits the milestones.

---

## 5. The seed-stage product (only ship these six)

In strict order — do not start (n+1) until (n) is in production for ≥7 days:

1. **Arabic prompt blueprints.** `i18nPrompts.ar` populated for the 10 highest-traffic templates in `GenerationTemplate`. Includes Khaleeji + MSA variants.
2. **WhatsApp delivery.** Finished `StudioAsset` → Twilio WhatsApp message with preview to the SME's number. Built on top of the existing `utills/whatsAppMessage.js` shim.
3. **Snap + Meta MENA one-click publish.** From a finished asset, push to a Meta or Snap ad set. Re-use the existing `routes/facebook.js` OAuth flow.
4. **AED billing tiers.** AED 99 / 199 / 399 per month via Stripe (already wired) plus Tabby + Tamara checkout. Tax: VAT-compliant invoices auto-generated.
5. **Idempotency keys** on `/api/v1/studio/generate/*` so a double-click never double-charges.
6. **The 60-second demo.** Single end-to-end flow: paste IG handle → 10 Arabic+English ads → WhatsApp send. Public demo URL. Always works. No "try the dashboard" detour.

Anything not on this list is a distraction. Politely refuse customer requests for ecommerce builders, marketplaces, suppliers, etc. — track them as "post-Series-A" and move on.

---

## 6. Validation gate (the only metric that matters)

We do **not** raise a seed round until:

- **100 paying UAE/KSA SMEs** at AED 99+/mo (= ~AED 9.9k MRR floor, ~AED 30k MRR realistic mix)
- **< 5% monthly logo churn**, sustained over 8 weeks
- **NPS ≥ 40** from those 100 customers
- **At least 30 customers using the Snap/Meta one-click publisher weekly** (proof we own the loop, not just creative)

If we cannot hit those numbers on the wedge, "AI infrastructure for 2026 businesses" was never going to work. Pivot again or wind down — do not raise on a vision deck.

---

## 7. Roadmap (post-validation, *not* before)

| Phase | Trigger | What unlocks |
|---|---|---|
| **Wedge** (now) | — | The six items in §5. |
| **Expand creative** | 100 paying SMEs | Localized video for KSA + UAE (Khaleeji VO), influencer template library |
| **Expand channels** | 200 paying SMEs | TikTok MENA shop, Snap Stars partnerships, programmatic |
| **Expand markets** | 500 paying SMEs | Egypt, KSA tier-2 cities, Kuwait, Qatar |
| **Adjacent product** | AED 5M ARR | Storefront builder *for Qumak ad customers only* (not a marketplace) |
| **Marketplace / acquisitions** | Series A closed | Optional adjacency, only if the data shows demand |

We talk about the marketplace and the "AI infrastructure for 2026" vision as a **future roadmap teaser** in the pitch — never as a current product, never as something we are building this year.

---

## 8. What this means for the codebase

- New work funnels into `controllers/studio/`, `services/falService.js`, `services/processingService.js`, `routes/templates.js`, `routes/facebook.js`, `utills/whatsAppMessage.js`, and the credit/billing flow in `controllers/brandProject/brandProjectController.js`.
- Marketplace, supplier, trade-license, and acquisition controllers stay in the repo but get **no new features** until the validation gate is hit. Add a `// PARKED — see docs/PIVOT_WEDGE.md` header comment when you next touch any of those files.
- The pitch deck, landing page, ad copy, and onboarding flow all describe the wedge in §1. No exceptions.

---

## 9. The investor one-liner

> "Creatify works in English. Tabby works for payments. Snap MENA wants SME tooling. Qumak is the only product that does **Arabic-first AI ads, AED billing, and WhatsApp delivery** for the 1.2M SMEs in the GCC. We charge AED 99–399/month and we already have N paying customers."

When N hits 100, we raise.
