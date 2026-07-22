# Qumak — Validation Playbook (100 Paying SMEs Gate)

> **Owner:** Founders
> **Audience:** Founding team, growth hire, board observers
> **Status:** Active — gate for re-approaching seed investors
> **Companion to:** `PIVOT_WEDGE.md`

---

## 0. The gate

Before raising on the pivot, hit **all three** of these in the same calendar month:

| Metric | Target | Why |
|---|---|---|
| Paying customers (UAE/KSA SMEs) | **≥ 100** | Proves repeatable acquisition, not friend-and-family. |
| Avg revenue per paying account | **≥ AED 99/mo** (≈ USD 27) | Proves they value the output enough to give up coffee money for it. |
| Monthly logo churn | **< 5 %** | Proves the product is sticky, not a one-time toy. |

Anything weaker than this and the seed conversation collapses on the first cohort retention slide. **Do not take meetings until all three are green for two consecutive months.**

---

## 1. Why these numbers (don't negotiate them down)

- **100 paying SMEs at AED 99+** = ~AED 10k MRR ≈ USD 33k ARR. Small in absolute terms, but it's the smallest signal that breaks the "your mom is your only customer" objection at seed.
- **<5 % monthly churn** is the GCC SaaS-for-SMB benchmark. Higher than that and your CAC payback never converges no matter how cheap the channel.
- **Two consecutive green months** kills the "lucky launch week" narrative.

If you can't hit these in 6 months on the wedge, the wedge is wrong — go back to `PIVOT_WEDGE.md` § "Validation gates" and pivot the wedge, not the metrics.

---

## 2. Acquisition plan (how you actually get the 100)

The wedge has two acquisition motions. Run **both** in parallel, attribute every signup, kill the loser by month 3.

### Motion A — IG handle demo as the top of funnel
1. Single landing page: "Paste your Instagram → get 10 ads in 60 seconds." No signup wall.
2. Public demo runs `POST /api/v1/studio/demo`. Watermarked output, 1 free run per IP per hour (already enforced by `demoLimiter`).
3. After delivery, the WhatsApp message ends with "Reply UPGRADE for unwatermarked + 50 more this month — AED 99."
4. Manual reply or short Twilio bot closes the deal.

### Motion B — Apollo-driven cold outreach to UAE/KSA SMB owners
1. Apollo client (`services/apolloClient.js`) is already centralized. Pull lists by:
   - Country: `AE`, `SA`
   - Headcount: 1–25
   - Title: Owner / Founder / GM / Marketing Manager
   - Industries: F&B, beauty, retail, real estate, fitness
2. Send a **3-touch sequence** (already supported by `services/outreachService.js`):
   - Touch 1: short video of their own brand's IG handle turned into a Qumak ad (yes, generate it ahead of time).
   - Touch 2 (+3 days): "Did you see the ad we made for [brand]?"
   - Touch 3 (+5 days): "Final note — here's the link to launch it on Snap with one click for AED 99."
3. Goal: **0.5 % cold → paid** is the floor. Below that, kill the channel.

---

## 3. Instrumentation — what to measure, where it lives

Every metric below must be on a single dashboard before you start outreach. Don't run a single ad until this is wired.

| Metric | Source of truth | How |
|---|---|---|
| Demo started | `DemoSession` collection, `createdAt` | `db.demosessions.count({ createdAt: { $gte: ... } })` |
| Demo completed (≥1 job done) | `StudioJob.status='completed'` joined to `DemoSession.jobs.jobId` | aggregate, group by demoId |
| WhatsApp delivered | `DemoSession.deliveryStatus='sent'` | filter by date |
| Sign up → paid conversion | `User` + Stripe `subscription.created` webhook | join on `customerId` |
| MRR | Stripe subscriptions | Stripe dashboard or pulled into `DailyStat` |
| Logo churn | Stripe `subscription.deleted` events ÷ active subs at start of month | weekly cron writing to `DailyStat` |
| CAC by channel | UTM on landing page → `User.acquisition.utm_*` (add this field if missing) | join with ad spend CSV monthly |

Add a thin admin route at `/api/v1/admin/validation-dashboard` that returns these as JSON. Two days of work. Do it before week 2.

---

## 4. Pricing tactics for the first 100

- **Lead with AED 99/mo, not AED 199.** Get the logo, then upsell. The 100 number matters more than ARPU at this stage.
- **Annual upfront with 2 months free** for anyone who hesitates on monthly. Cash + retention.
- **No free tier.** Free demo, paid product. Free tiers ruin SMB churn data.
- **Tabby/Tamara split into 4 payments** of AED 25 ≈ "less than a shisha." Use this in copy.
- **Founder-call upgrade** for any signup over AED 199/mo. Turns onboarding into a sales call without it feeling like one.

---

## 5. Retention tactics (defending the <5 % churn number)

Churn for AI tools at this price point is brutal. Default behaviors:

1. **Day-1 send:** WhatsApp the 10 generated ads within 60s of signup. (Already wired — `videoWorker.js` `maybeDeliverDemoToWhatsApp`.)
2. **Day-3 nudge:** WhatsApp "Did you publish any of these? Reply 1 to launch on Snap, 2 to launch on Meta." Triggers `/api/v1/snap/launch-campaign` or `/api/v1/facebook/launch-campaign`.
3. **Day-14 check-in:** WhatsApp from a real human (you, the founder, until customer 200). "What's not working? Reply with anything."
4. **Day-25 save offer:** Anyone with <2 generations in their cycle gets "Want me to make 5 more for free for next month?" Auto-extends subscription one cycle.
5. **Cancel flow:** Already built (`churn-prevention` skill exists in this repo). Wire it before customer 50.

Track every one of these as an event. Anyone who skips all four nudges is your true churn signal — flag them at day 20.

---

## 6. The week-by-week plan (12 weeks to gate)

| Week | Deliverable | Owner |
|---|---|---|
| 1 | Validation dashboard live; UTM tracking on landing page; 200 Apollo leads in queue | Eng + Founder |
| 2 | Landing page A/B (Arabic-first vs English-first hero); first 50 outbound emails sent | Founder |
| 3 | First 10 paying customers; manual onboarding call with each | Founder |
| 4 | Day-3 + Day-14 WhatsApp nudges automated; first cohort retention numbers visible | Eng |
| 5–8 | Scale outbound to 200 emails/week; turn on Meta retargeting on demo visitors who didn't convert | Founder + Eng |
| 6 | First customer interview round (5 churned, 5 retained). Update wedge doc. | Founder |
| 9–12 | Scale or kill. If MRR trajectory misses 100 customers by week 12, run the post-mortem in § 7 before raising money. | All |

---

## 7. Post-mortem template (use if the gate is missed)

If at week 12 you're below 50 paying customers OR above 8 % churn, **do not raise**. Run this exact post-mortem instead:

1. Of the demos that finished, what % asked "how much?" — if <30 %, the value isn't obvious. Fix the demo output, not the funnel.
2. Of paid signups, what % were active in week 2 — if <50 %, the *output quality* is the problem. Re-seed templates, not the price.
3. Of churned customers, what was the modal reason — if it's "the ads didn't perform on Meta/Snap," you have a creative quality problem, not a churn problem.
4. Compare CAC by motion. If outbound CAC is >2× demo CAC, kill outbound. If demo CAC is >2× outbound, kill the demo and lean on cold.

Then update `PIVOT_WEDGE.md` and rerun this playbook. Do **not** start a fundraise on a missed gate — the dilution will be worse than another quarter of bootstrapping.

---

## 8. What this playbook does NOT cover (intentionally)

- Hiring. Don't hire anyone until customer 100. The founder runs sales until then.
- Multi-channel ads (Google, LinkedIn). The wedge is Snap/Meta MENA. Stay there.
- The marketplace, supplier connections, e-commerce store builder. All parked per `PIVOT_WEDGE.md` § "Descoped".
- Investor narrative. Built the gate first. The deck writes itself once 100/AED 99/<5 % is real.
