import type { Metadata } from "next";
import Link from "next/link";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { getSetting } from "@/lib/admin/settings";

export const metadata: Metadata = {
  title: "Help, shipping and refunds",
  description:
    "How preordering works, what the price includes, delivery times, cancellations and refunds, and how to reach us.",
  alternates: { canonical: "/help" },
};

/*
 * Every answer here restates a rule the system already enforces
 * (docs/BUSINESS_LOGIC.md). Nothing is promised on this page that the code
 * does not do; the one policy the business has not written yet — returns of
 * delivered goods — is described as a case-by-case review, not invented.
 */
const SECTIONS = [
  {
    id: "preorders",
    title: "How preordering works",
    items: [
      {
        q: "What is a preorder window?",
        a: "Each product is bought in the US in batches. A window is open until its closing date or until its places run out, whichever comes first. When it closes, we place the US order for everyone in it.",
      },
      {
        q: "Can a preorder fill up while it is in my cart?",
        a: "Yes. A cart does not hold a place — your place is confirmed only when your order is placed. If a batch fills or closes first, your cart says so on that line, and you can join the waitlist for the next batch.",
      },
      {
        q: "What does “deposit” mean?",
        a: "Some preorders take a deposit when you order and the rest once the item has been bought in the US. The product page, cart and checkout all show how much is due now and how much later.",
      },
    ],
  },
  {
    id: "shipping",
    title: "Prices, shipping and delivery",
    items: [
      {
        q: "Are shipping and customs duty extra?",
        a: "No. Every price already includes freight to Bangladesh and customs duty. The amount at checkout is the amount you pay, and the courier asks for nothing at the door.",
      },
      {
        q: "When will my order arrive?",
        a: "Each product shows an expected arrival window. It is an estimate: customs clearance is the one step nobody can promise to the day. Your order page shows every stage as it happens — sourcing, shipped from the US, customs, out for delivery.",
      },
      {
        q: "Can I pay cash on delivery?",
        a: "For items in stock, yes. Not for preorders, because we buy those in the US on your behalf before they ship.",
      },
    ],
  },
  {
    id: "refunds",
    title: "Cancellations, refunds and returns",
    items: [
      {
        q: "Can I cancel?",
        a: "Yes, until we have bought the item in the US. Ask from your order page; staff confirm it and you receive a full refund of what you paid.",
      },
      {
        q: "What if I cancel after it has been bought?",
        a: "Once the US purchase is made the item is yours and on its way, so a cancellation can no longer be accepted automatically. Write to us and we will look at it.",
      },
      {
        q: "Something arrived damaged or wrong.",
        a: "Write to us with your order number and a photo. Each case is reviewed by a person and put right.",
      },
    ],
  },
] as const;

export default async function HelpPage() {
  const contactEmail = await getSetting("store.contact_email");

  return (
    <div className="mx-auto w-full max-w-[960px] px-4 py-10 md:px-6 md:py-12">
      <PageHeading
        eyebrow="Help"
        title="Help, shipping and refunds"
        summary="The questions people ask before and after a preorder, answered the way the shop actually works."
      />

      <nav aria-label="On this page" className="mt-6 flex flex-wrap gap-2">
        {[...SECTIONS.map(({ id, title }) => ({ id, title })), { id: "contact", title: "Contact us" }].map(
          (section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="inline-flex min-h-11 items-center rounded-control border border-blue-300 px-3 text-meta text-ink transition-colors hover:border-blue-500 hover:bg-blue-50"
            >
              {section.title}
            </a>
          ),
        )}
      </nav>

      {SECTIONS.map((section) => (
        <section key={section.id} id={section.id} className="mt-12 scroll-mt-28">
          <h2 className="font-display text-h2 text-ink">{section.title}</h2>
          <div className="mt-4 flex flex-col gap-3">
            {section.items.map((item) => (
              <details
                key={item.q}
                className="group rounded-card border border-blue-300 bg-paper shadow-[var(--shadow-raise)]"
              >
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-medium text-ink">
                  {item.q}
                  <span aria-hidden="true" className="text-blue-500 transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="max-w-[70ch] px-5 pb-5 text-body text-ink/80">{item.a}</p>
              </details>
            ))}
          </div>
        </section>
      ))}

      <section id="contact" className="mt-12 scroll-mt-28">
        <h2 className="font-display text-h2 text-ink">Contact us</h2>
        <Panel depth="raised" className="mt-4 p-5 sm:p-6">
          <p className="text-body text-ink/80">
            Email{" "}
            <a href={`mailto:${contactEmail}`} className="font-medium text-blue-600 underline-offset-4 hover:underline">
              {contactEmail}
            </a>{" "}
            and include your order number if you have one.
          </p>
          <p className="mt-3 text-meta text-ink/70">
            Looking for an order?{" "}
            <Link href="/orders/lookup" className="text-blue-600 underline-offset-4 hover:underline">
              Track it with your order number and email
            </Link>
            .
          </p>
        </Panel>
      </section>
    </div>
  );
}
