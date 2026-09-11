-- Staff roles beyond the original two, and a name to greet a shopper by.
--
-- The roles are still one column (DATABASE.md). What each may do is the
-- permission table in lib/auth/authorize.ts (DECISIONS.md D-034); the
-- constraint only guarantees nobody holds a role the application does not
-- know about. `staff_admin` keeps its value and every capability it had.
--
-- First and last name are optional so every existing account stays valid; the
-- header falls back to "Account" for an account with no first name.
--
-- Every statement is safe to run twice: `npm run db:setup` re-applies the
-- whole directory.

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_role_check";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" in ('super_admin', 'staff_admin', 'product_manager', 'order_manager', 'support', 'marketing', 'finance', 'customer'));
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "first_name" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_name" text;
