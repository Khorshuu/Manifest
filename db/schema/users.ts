import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Fixed roles, held in a single column rather than a permissions table — see
 * docs/DATABASE.md. What each staff role may do is the table in
 * lib/auth/authorize.ts (DECISIONS.md D-034), checked at the point of use.
 */
export const USER_ROLES = [
  "super_admin",
  "staff_admin",
  "product_manager",
  "order_manager",
  "support",
  "marketing",
  "finance",
  "customer",
] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    phone: text("phone").unique(),
    passwordHash: text("password_hash").notNull(),
    /** What the header greets a signed-in shopper by. Optional: older accounts have none. */
    firstName: text("first_name"),
    lastName: text("last_name"),
    role: text("role").notNull().default("customer"),
    /** Staff only: when this account last read the admin inbox. */
    adminInboxSeenAt: timestamp("admin_inbox_seen_at", { withTimezone: true }),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    /** Base32 TOTP secret. Present while enrolling, live once confirmed. */
    totpSecret: text("totp_secret"),
    totpConfirmedAt: timestamp("totp_confirmed_at", { withTimezone: true }),
    /** The last 30-second step spent, so a seen code cannot be reused. */
    totpLastUsedStep: integer("totp_last_used_step"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "users_role_check",
      sql`${table.role} in ('super_admin', 'staff_admin', 'product_manager', 'order_manager', 'support', 'marketing', 'finance', 'customer')`,
    ),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    /**
     * The SHA-256 of the token held in the cookie, not a UUID — the database
     * never stores a value that could be replayed as a live session.
     */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * A session that has passed the password but not the second factor. It
     * authenticates nothing: `validateSessionToken` refuses it, so a pending
     * cookie cannot reach a single page or endpoint.
     */
    pendingTwoFactor: boolean("pending_two_factor").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Null for a guest checkout address. Guests complete checkout without an
     * account (MASTER_PRODUCT_SPEC.md section 5.5), and their order still has
     * to record where it is going.
     */
    userId: uuid("user_id").references(() => users.id),
    label: text("label"),
    recipientName: text("recipient_name").notNull(),
    phone: text("phone").notNull(),
    addressLine1: text("address_line1").notNull(),
    addressLine2: text("address_line2"),
    city: text("city").notNull(),
    district: text("district").notNull(),
    postalCode: text("postal_code"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("addresses_user_id_idx").on(table.userId)],
);

/**
 * Newsletter consent, one row per address. Unsubscribing stamps
 * `unsubscribedAt` rather than deleting, so the record of consent survives.
 */
export const newsletterSubscribers = pgTable("newsletter_subscribers", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  userId: uuid("user_id").references(() => users.id),
  source: text("source").notNull().default("footer"),
  subscribedAt: timestamp("subscribed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
});

/**
 * Single-use recovery codes, so losing a phone is not losing the account.
 *
 * Stored as SHA-256: they are high-entropy random strings, so a fast hash is
 * appropriate here in a way it never is for a password, and a stolen table
 * still yields nothing usable.
 */
export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("recovery_codes_user_idx").on(table.userId)],
);
