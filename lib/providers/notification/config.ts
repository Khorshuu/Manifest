import { z } from "zod";

/**
 * Settings for real email delivery (D-132), read apart from lib/env.ts like
 * the other optional services, so a shop on the mock provider needs none of
 * them and a mistake here cannot stop the site from starting.
 *
 * SMTP on purpose: every transactional email service speaks it, so choosing
 * or changing the service is a change of these values and not of any code.
 * Port 587 upgrades to TLS before anything is sent (STARTTLS is required, not
 * merely tried); port 465 is TLS from the first byte. There is no setting
 * that sends a password or a message in the clear.
 */

const flag = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .optional()
  .transform((value) => value === "true" || value === "1" || value === "yes");

/** One address, nothing that could start a second header. */
const address = z
  .string()
  .max(254)
  .regex(/^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]+$/, "must be one email address");

const schema = z.object({
  SMTP_HOST: z
    .string()
    .regex(/^[A-Za-z0-9.-]+$/, "must be a host name")
    .optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  /** TLS from the first byte (port 465). Unset: true on 465, STARTTLS otherwise. */
  SMTP_SECURE: flag,
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  /** The address customers see, e.g. orders@example.com. */
  EMAIL_FROM: address.optional(),
  /** The name shown beside it. */
  EMAIL_FROM_NAME: z
    .string()
    .max(80)
    .regex(/^[^\r\n<>"]+$/, "must be plain text")
    .optional(),
  EMAIL_REPLY_TO: address.optional(),
  /**
   * When set, only these recipients are written to: whole addresses, or
   * `@domain` for everyone at one. Staging sets it so a test order placed
   * with a real customer's address can never reach that customer. Unset
   * means no restriction, which is what production wants.
   */
  NOTIFICATION_RECIPIENT_ALLOWLIST: z.string().optional(),
  /** How long one delivery may take before it counts as failed. */
  SMTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
});

export type EmailConfig = z.infer<typeof schema>;

export type EmailConfigResult = { ok: true; config: EmailConfig } | { ok: false; problems: string[] };

/** The settings, or what is wrong with them — names only, never a value. */
export function readEmailConfig(source: Record<string, string | undefined> = process.env): EmailConfigResult {
  const values = Object.fromEntries(Object.keys(schema.shape).map((key) => [key, source[key]?.trim() || undefined]));
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`) };
  }
  const config = parsed.data;
  const problems: string[] = [];
  if (!config.SMTP_HOST) problems.push("SMTP_HOST is not set");
  if (!config.EMAIL_FROM) problems.push("EMAIL_FROM is not set");
  // Half a login is a mistake, and sending without one is almost always refused.
  if (Boolean(config.SMTP_USER) !== Boolean(config.SMTP_PASSWORD)) problems.push("SMTP_USER and SMTP_PASSWORD must be set together");
  return problems.length ? { ok: false, problems } : { ok: true, config };
}

/** A syntactically valid single recipient. Anything else is refused before the provider sees it. */
export function isDeliverableAddress(value: string): boolean {
  return address.safeParse(value).success;
}

/** Whether this environment may write to `recipient` at all. */
export function recipientAllowed(recipient: string, allowlist: string | undefined): boolean {
  const entries = (allowlist ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return true;
  const wanted = recipient.trim().toLowerCase();
  return entries.some((entry) => (entry.startsWith("@") ? wanted.endsWith(entry) : wanted === entry));
}
