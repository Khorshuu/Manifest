# Decisions

Architecture decision log. One entry per meaningful choice, newest first. Each entry states the decision, the alternatives considered, and why the decision won — so a later session can revisit it without re-deriving the reasoning from scratch.

---

## D-016: The header's treatment over a hero is measured in the browser, with a manual override

**Decision:** The floating header picks navy or pale lettering from the average relative luminance of the current hero image, computed client-side by drawing the image into a 32×32 canvas (`lib/hero-tone.ts`). A per-slug map, `HERO_TONE_OVERRIDES`, overrides the measurement where it is wrong. The first server render assumes a light background, and a correction after measurement crossfades over 500ms rather than snapping.

**Why:** The alternatives were each worse in a specific way. Storing a tone on the product record would make whoever uploads a photograph answer a question about the *home page* while editing a *product*, and it would go stale the moment the photograph is replaced. Computing it on the server would mean rasterising SVG and decoding images inside a request, for a decision that changes nothing anyone can act on. A fixed dark scrim over the whole photograph would make the header readable by making every hero image darker, which is the one thing the brief ruled out. Measuring in the browser costs a 32×32 `getImageData` per slide, once, and degrades to a readable default whenever the pixels cannot be read — a tainted canvas throws, and the header simply keeps the treatment it had. The override exists because an average is wrong in a predictable case: an image that is mostly dark with a bright sky exactly where the navigation sits.

## D-015: Refunds are recorded, not charged

**Decision:** The refund control records a refund that staff have already paid by hand. It does not call the payment gateway. Staff enter the amount, the reason, and the reference of the transfer they made; the system writes a refund payment row against the charge it reverses. The product owner set this: "refund will be done manually as per our terms and that will be set later but refund will be manual."

**Alternatives considered:** calling `provider.refund` so the gateway returns the money automatically, which is what the code did until now.

**Why:** The refund terms themselves are not written yet, and an automatic refund makes a decision the business has not made. Paying by hand also matches how the money actually moves for a shop this size — bKash and bank transfers reconciled by a person — and it removes a failure mode that is genuinely nasty: a gateway call that fails halfway leaves a customer's money somewhere this system cannot see.

The system's job is therefore bookkeeping, and it does that strictly. A refund is always a payment row, never a silent adjustment to a figure on the order (docs/SECURITY.md), and each row points at the charge it reverses so a second part-refund can tell how much of that charge is left.

`provider.refund` stays in the payment interface. When a real gateway arrives it may be worth automating, and the interface should not have to be re-invented to do it.

**What it costs:** nothing stops staff recording a refund they did not actually pay. That is a bookkeeping risk rather than a technical one, and the audit row naming who recorded it is the control.

---

## D-014: A shopper's cancellation is a request; staff make the decision

**Decision:** The customer's control asks us to cancel. It records a request and changes nothing else: the order keeps its status, keeps moving, and keeps its capacity. Requests appear in their own category in the admin order pipeline, with the customer's reason in their own words, and staff approve or decline from the order page. Approving runs the ordinary cancellation, which is what returns the places. The product owner set this: "I will do the final cancel after the client cancels ... we will recheck the thing, client feedback and then cancel from the admin site."

**Alternatives considered:** what this used to do — the shopper cancelling outright while the order had not been sourced, with capacity returned immediately.

**Why:** This is a business that buys goods abroad in batches. Whether a cancellation is straightforward depends on where the batch has got to, on what the customer actually wants, and on terms the owner has not written yet. A button that made that decision on its own would be making it wrongly some of the time and irreversibly every time.

Three consequences, all deliberate:

**Capacity is held until the decision.** It used to come back the moment the shopper pressed the button. Releasing it early would sell their place to somebody else while they were still waiting to hear from us, which is the opposite of what a request means.

**Requests are allowed after sourcing.** The old rule refused a shopper outright once the item had been bought. That is exactly the case where somebody needs to talk to us, so a request is allowed at any stage before delivered, cancelled or refunded, and staff decline the ones that cannot be honoured.

**Asking twice is not an error.** A second request returns the first one rather than failing, because somebody pressing again is somebody wondering whether it registered.

The customer is only told their order is cancelled when it actually is — on approval, through the same message as any other cancellation. Nothing is sent when the request is filed, because "we have your request" is a promise the outbox cannot yet keep with no email provider connected; the order page shows the request instead.

---

## D-013: Customer records are kept indefinitely; nothing is deleted on age

**Decision:** There is no retention period and no scheduled sweep. A customer's name, address and contact details stay until somebody asks for them to be removed. The product owner decided this directly: "information will always stay."

**Alternatives considered:** anonymising personal fields automatically once an order passed some age — a few years, matching whatever Bangladeshi tax law requires records to be kept for.

**Why:** SECURITY.md carried "the data retention period under Bangladeshi law" as an open question, because a sweep needs an age to sweep at and guessing that number wrong is the kind of mistake that matters in both directions — deleting something the tax authority wanted, or keeping something a person was entitled to have removed. The owner's answer removes the question rather than answering it: nothing expires, so no age is needed.

**What this does not change.** `anonymiseCustomer` stays exactly as it is. It exists for a customer who asks to be forgotten, and a shop with no way to comply with such a request has a legal exposure rather than a retention policy. The decision here is about *automatic* deletion, not about refusing a request.

**What it costs.** The longer personal data is held, the more there is to lose in a breach. That is a real trade and the owner has made it knowingly. It raises the value of the controls already in place — the session hashing, the argon2id passwords, the role gates, the audit log — and it means an encrypted-at-rest database matters more than it otherwise would when this is deployed for real.

If a retention period is ever set, the sweep is small: `anonymiseCustomer` already does the work, and a scheduled job would only have to choose which accounts to call it for. The maintenance route at `/api/cron/maintenance` is where it would go.

---

## D-012: The balance on a deposit order is taken by staff, not charged automatically

**Decision:** When an order was placed with a deposit, the remaining balance is collected when a member of staff presses a button on the admin order page. It is not charged automatically on any event — not when the window closes, not when the goods are sourced, not when they land. The amount is computed on the server from the order's own payment rows; the request carries no figure. The customer is told by email once it is taken, and sees what is outstanding on their order page in the meantime.

**Alternatives considered:** charging the balance automatically at a fixed point in the pipeline, most plausibly when the order reaches `shipped_from_us`.

**Why:** DATABASE.md recorded this as an open question and the product owner answered it directly: staff-triggered. That is also the safer default. An automatic charge fires on a schedule nobody is watching, against a card or wallet the customer authorised weeks earlier for a smaller amount, and the first a person hears of it is their bank. A batch that goes wrong — a supplier shortfall, a price change, a customer who has asked to cancel — becomes a set of charges to unwind rather than charges never made. Staff pressing a button is one person deciding one order is ready to settle, which is what the money actually depends on.

The cost is that a balance can be forgotten. That is visible rather than silent: the admin order page states what is outstanding, and the figure is computed from payments rather than from `amount_due_now_bdt`, which records what was asked for at placement and would otherwise drift as refunds and captures accumulate.

Idempotency has three layers, because a duplicate here costs a real person real money: a captured balance row short-circuits before the provider is called, an *initiated* row is resumed rather than replaced, and the provider is handed a key derived from the order id.

If the business later wants this automatic, the same function is what a scheduler would call; only the trigger changes.

---

## D-011: The waitlist is notified when places open, and no place is held

**Decision:** When capacity is returned to a full preorder variant — an order cancelled, or staff raising the ceiling — everyone at the front of that variant's waitlist is sent a message saying places are available, oldest entry first, up to the number of places that actually opened. No place is reserved for them: the first person to order takes it. Each entry is marked `notified_at` so nobody is told twice, and the message says plainly that nothing is being held.

**Alternatives considered:** reserving the freed place for the next person in the queue for some window — a few hours, say — before releasing it to everyone.

**Why:** DATABASE.md recorded this as an open question, automatic re-offer versus manual, and the product owner asked for the work to continue rather than wait on the answer. So this is the simplest option that is defensible and cheap to change. A held place is a second kind of reservation: it needs its own expiry, its own scheduler to release it, its own display on the storefront ("held for someone else"), and its own interaction with the transaction that prevents overselling. MASTER_PRODUCT_SPEC.md does not ask for any of that, and CLAUDE.md §9 says to pick the simplest option that is secure and correct rather than invent complex behaviour.

Nothing about this forecloses the other choice. The queue order is recorded, `notified_at` distinguishes told from untold, and adding a hold later means adding an expiry to the waitlist row — no data is lost or reinterpreted in the meantime.

The honesty of the message is part of the decision. "A place is available" reads as "a place is yours" unless it says otherwise, and someone who drops what they are doing only to find the batch full again is worse served than someone who was never written to. So the message states that the place is not held.

---

## D-010: The landed price is split for the books, never added to at checkout

**Decision:** A variant's price is the landed price — goods, freight and customs duty already inside it. At order placement that price is decomposed into `subtotal_bdt` (goods), `shipping_fee_bdt` and `duty_bdt`, which always add back to exactly `total_bdt`. The rates live in `site_settings` (`landed.shipping_per_kg_bdt`, `landed.duty_percent`, `landed.assumed_weight_grams`).

**Alternatives considered:** the conventional model — goods at the top, freight and duty added as lines at checkout. It is simpler, it is what every other importer does, and it is exactly the surprise this shop exists to avoid (MASTER_PRODUCT_SPEC.md §5). The other alternative was leaving `shipping_fee_bdt` permanently zero, which is what the code did before: honest, but it left the business unable to see what a sale was made of.

**Why:** The promise to a shopper is one fixed number with nothing to pay at the door. Adding lines at checkout would break that promise even if the arithmetic matched. Deriving the split from the price keeps the promise exactly and still gives the shop a real freight and duty figure per order. Because the price is the input, changing the duty percentage cannot change what anyone is charged — a test asserts that directly.

**Cost:** The split is an estimate, not a customs declaration. Freight is priced by weight from a single rate, and duty by one percentage rather than by HS code. When real invoices arrive, the rates get better; the decomposition does not have to change.

## D-009: Notifications go through a transactional outbox, not a direct send

**Decision:** An order event writes a row to `notifications` inside the same transaction as the change that caused it. Delivery is a separate step (`deliverQueuedNotifications`) that reads queued rows and calls the provider. Each row carries a `dedupe_key` of `order:<order id>:<status>` under a unique constraint.

**Alternatives considered:** calling the email provider directly from `advanceOrder` and friends, which is simpler and was the obvious first move.

**Why:** A direct send sits inside the transaction or just outside it, and both are wrong in a way a customer notices. Inside, a slow or failing provider holds a row lock on an order — and on the preorder capacity it touches. Outside, a crash between commit and send loses the message with no record that it was owed. The outbox makes the message part of the same commit as the fact it describes, and leaves a queued row to retry when delivery fails. The dedupe key is what makes a replayed payment webhook stop at the database rather than at a customer's inbox, which is the idempotency rule in CLAUDE.md section 7 applied to messages rather than to money.

**Cost:** a message is not delivered by the act of queueing it. Something has to drain the outbox — today the request that queued it does so in the background, and staff can drain it by hand from `/admin/notifications`. A scheduled drain is the obvious next step once there is a real provider.

## D-008: PGlite used to verify migrations and seed data in tests

**Decision:** `tests/schema.test.ts` and `tests/seed.test.ts` apply the checked-in migration to PGlite (Postgres compiled to WASM, running in-process) and run the real seed against it.

**Why:** This machine has no PostgreSQL server, no Docker, and no psql, so `npm run db:migrate` cannot be run here. The alternative was to mark the migration unverified and hope it applies. PGlite is real Postgres, so the migration, every check constraint, and the seed are genuinely exercised on every `npm test` — including the capacity ceiling constraint, which is the schema-level half of the no-overselling rule. It is a test dependency only; development and production still use a real Postgres server through postgres-js.

## D-007: `paper` and `paper-raised` aliased to white and blue-50

**Decision:** `app/globals.css` defines `--color-paper: #ffffff` and `--color-paper-raised: #f2f7ff`.

**Why:** DESIGN_GUIDELINES.md refers to `paper` and `paper-raised` in its accessibility floor and in two signature-pattern descriptions, but its color table defines neither — the table names `white` and `blue-50` instead. Rather than leave the tokens undefined and let each component invent its own, they're aliased to the two values the surrounding prose clearly intends. This is a reading of an inconsistency in the guidelines, not a design decision, and should be confirmed with whoever owns the design system; if the intended `paper` is an off-white rather than pure white, only these two token values change and nothing else in the codebase does.

## D-006: Attribute system uses EAV (entity-attribute-value), not fixed columns

**Decision:** Product variation is modeled as `attributes` / `attribute_values` / `variant_option_values`, not as fixed `size` and `color` columns on the variant table.

**Why:** MASTER_PRODUCT_SPEC.md §2 requires admins to define arbitrary attribute types (color, size, material, storage, edition, bundle, compatibility, ...) and generate combinations from them. Fixed columns cannot express an admin-defined attribute set. EAV costs query complexity (variant lookup by attribute needs joins) but that cost is paid once in `lib/catalog/` and is worth it against the alternative of a schema migration every time a new attribute type appears.

## D-005: Preorder capacity lives on the variant, not a separate cross-product batch entity

**Decision:** `preorder_capacity`, `preorder_reserved`, and `preorder_closes_at` are columns on `product_variants`. There is no shared "sourcing batch" entity spanning multiple products.

**Why:** MASTER_PRODUCT_SPEC.md §3 describes preorder as slots/capacity per listing, not a cross-product run. An earlier draft of this spec (superseded) modeled a shared batch entity; the current spec doesn't call for it, and inventing one would be exactly the kind of complexity §9 warns against. If a future requirement needs to group variants into a shared US purchase run, add a `sourcing_runs` table then, against a real need.

## D-004: Payments and shipping go behind a provider interface with a mock implementation

**Decision:** `lib/providers/payment` and `lib/providers/shipping` define an interface; a mock implementation satisfies it until SSLCommerz and a courier/tracking integration have real credentials.

**Why:** MASTER_PRODUCT_SPEC.md §6 and §7 require this explicitly, so the app is runnable and testable end to end before external accounts exist. SSLCommerz is the assumed primary gateway (aggregates card, bKash, Nagad, Rocket) because it's the standard Bangladesh payment aggregator; if the business instead integrates bKash/Nagad directly, only the provider implementation changes, not the call sites.

## D-003: PostgreSQL with Drizzle ORM, not Prisma

**Decision:** PostgreSQL, accessed through Drizzle with checked-in SQL migrations.

**Why:** The preorder capacity check (§7: "no overselling / no over-preordering") is the highest-risk piece of correctness in this system, and it must run as a `SELECT ... FOR UPDATE` or equivalent inside an explicit transaction. Drizzle stays close to SQL and makes that transaction visible and reviewable in the query itself. Postgres gives real transactions and constraints, which a capacity engine and a financial audit log both need.

## D-002: Session-based auth with a hand-rolled sessions table, not an auth-as-a-service library

**Decision:** Password hashing (argon2id) plus a `sessions` table referenced by a signed HTTP-only cookie. No NextAuth/Auth.js, no third-party auth provider.

**Why:** There are exactly three roles (`super_admin`, `staff_admin`, `customer`) with server-enforced, per-route authorization (§7), and admin actions must write to an audit log tied to the acting session. A general-purpose auth library adds an abstraction layer between the session and that authorization logic for no benefit at this scale. Revisit if social login or SSO becomes a real requirement.

## D-001: Next.js (App Router) with TypeScript, Tailwind, Vercel + Neon Postgres

**Decision:** Next.js App Router, TypeScript strict mode, Tailwind CSS driven by the DESIGN_GUIDELINES.md token set, deployed to Vercel with Neon for serverless Postgres, Cloudflare R2 for product imagery.

**Why:** MASTER_PRODUCT_SPEC.md §6 requires SEO (metadata, structured data, sitemap) and a fast mobile-first storefront, which favors server-rendered pages over a client-only SPA. The same app serves the customer storefront and the internal admin dashboard, which keeps deployment and auth code in one place. Neon's branching model gives each phase of work an isolated database without standing up separate Postgres instances by hand. Cloudflare R2 is chosen over storing images in Postgres or in the app's own filesystem because Vercel's serverless runtime has no persistent disk, and R2's egress pricing suits an image-heavy storefront.
