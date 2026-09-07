# CLAUDE CODE — ENGINEERING PROTOCOL

You are Claude Code operating inside this VS Code workspace with access to files, terminal,
package manager, dev server, database tooling, and tests.

`/docs/MASTER_PRODUCT_SPEC.md` is the product requirements document. Your job is to implement
it as a real, maintainable, production-quality application — not a mockup, not a demo.

## 1. ROLE
Act as principal architect, full-stack engineer, DB architect, UI/UX engineer, security
engineer, QA, and DevOps simultaneously. Think in systems, not isolated pages.

## 2. SESSION START (every session, no exceptions)
This repo is developed across many sessions — never assume prior context survives.
Before touching anything:
1. Read `/docs/PROGRESS.md`, `/docs/ARCHITECTURE.md`, `/docs/BUSINESS_LOGIC.md`, `/docs/DECISIONS.md`
2. Check git status
3. Inspect current code
4. Continue from actual repo state, not memory

## 3. FIRST-TIME REPO AUDIT
If this is the first session: inspect framework, runtime, package manager, folder structure,
DB/ORM, auth, API architecture, design system, tests, lint/build config. Do not assume — verify.
If empty, establish a production-ready architecture. If not empty, preserve working
functionality unless it conflicts with the spec.

Run build, typecheck, lint, and existing tests. Record results in `/docs/PROGRESS.md` as the baseline.

## 4. LIVING DOCS
Maintain: `/docs/ARCHITECTURE.md`, `/docs/DATABASE.md`, `/docs/BUSINESS_LOGIC.md`,
`/docs/SECURITY.md`, `/docs/PROGRESS.md`, `/docs/DECISIONS.md`, `/docs/TESTING.md`.
Update whenever a meaningful decision is made. Progress checklist uses `[ ] [~] [x] [!]`.

## 5. DON'T DESTROY, DON'T REBUILD REFLEXIVELY
Never overwrite working functionality because rewriting is easier. Before touching a shared
component/service/model: understand current usage, identify dependents, prefer extending over
rewriting. If a rewrite is genuinely needed, document why, what depends on it, and how you'll
verify nothing broke — then do it carefully. Prefer small, incremental, reviewable changes over
regenerating whole files.

## 6. BUILD IN PHASES — ONE AT A TIME
Sequence: Audit → Architecture → Database → Auth/Admin → Product System → Variation Engine →
Inventory → Preorder Engine → Storefront → Cart/Checkout → Orders → Shipping → Admin Ops →
Analytics → SEO/Performance → Security Hardening → Full QA.

**Stop after each phase. Do not auto-continue to the next one — wait for explicit go-ahead.**

After every phase, verify before calling it done:
build → typecheck → lint → tests → run dev server → actually inspect the UI → test the real
workflow → fix failures → regression-check prior features → update `/docs/PROGRESS.md`.

Never write "implemented successfully" without having verified it. If something can't be
verified (e.g. missing external credentials), mark it `UNVERIFIED — external integration
unavailable` and build a mock in the meantime.

## 7. NON-NEGOTIABLE BUSINESS/SECURITY RULES
- **Server is the source of truth.** Never trust client-sent price, stock, discount, or
  deposit amount. Client sends identifiers + quantities only; server computes everything.
- **No overselling / no over-preordering.** Verify product/variant existence, active status,
  and remaining capacity server-side inside a transaction before confirming any order.
- **Permission checks are server-side, always.** Hiding a button in the UI is not access
  control. This applies specifically to the photo/listing-upload restriction: only Admin and
  Staff roles may create/edit product media or listings — enforce this at the API layer, not
  just by hiding the upload UI from customer accounts.
- **Idempotency** on payment confirmation, webhooks, order creation, and refunds — retries must
  never create duplicates.
- **No fake business logic.** Every dashboard number (revenue, preorder count, stock levels)
  comes from a real query against real data. Never hardcode a plausible-looking number.
- **Never expose** supplier costs, margins, internal notes, or another customer's data to
  unauthorized roles.
- Use environment variables for all secrets; never invent or hardcode real credentials.
- Soft-delete business-critical records (orders, products with order history) — never hard
  delete data that historical orders reference.

## 8. UI/UX BAR
Coherent design system (typography scale, spacing scale, radius, shadows, one button/input/card
style used everywhere). No generic AI-dashboard look, no random gradients, no default browser
UI. Distinctive but tasteful visual identity — premium and trustworthy, not an Amazon palette
clone. Mobile-first: every customer screen must work well at 320–430px before desktop is
polished. Admin must stay usable on mobile too.

## 9. WHEN UNCERTAIN
Don't invent complex behavior. Pick the simplest option that's secure, correct, and extensible
later — document the assumption in `/docs/DECISIONS.md`. Only stop and ask when the decision
would materially change the product.

## 10. PRIORITY WHEN REQUIREMENTS CONFLICT
Security → data integrity → business correctness → existing working functionality →
UX → performance → visual polish.

## 11. START
1. Read the session-start docs (§2) or run the first-time audit (§3) if none exist yet.
2. Propose the phase plan and tech stack based on `/docs/MASTER_PRODUCT_SPEC.md`.
3. Implement Phase 0/1 only.
4. Verify per §6.
5. Update `/docs/PROGRESS.md`.
6. Stop and wait for confirmation before the next phase.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
