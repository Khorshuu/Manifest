import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getTwoFactorStatus } from "@/lib/auth/two-factor";
import { TwoFactorPanel } from "./two-factor-panel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Security",
  robots: { index: false },
};

export default async function AccountSecurityPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account/security");

  const status = await getTwoFactorStatus(user);

  return (
    <div className="mx-auto w-full max-w-[900px] px-4 py-8 md:px-6">
      <p className="text-meta text-blue-600">
        <Link href="/account" className="hover:underline">
          Your account
        </Link>
      </p>
      <h1 className="mt-2 font-display text-h1 text-ink">Security</h1>
      <p className="mt-2 text-meta text-ink/70">Signed in as {user.email}</p>

      {isStaff(user) && !status.enabled ? (
        <p className="mt-6 max-w-[70ch] border border-brass bg-brass/10 p-4 text-meta text-ink">
          This account can change prices, issue refunds, and read every
          customer&rsquo;s address. Two-factor authentication is strongly
          recommended for it.
        </p>
      ) : null}

      <section className="mt-8">
        <h2 className="sr-only">Two-factor authentication</h2>
        <TwoFactorPanel status={status} />
      </section>
    </div>
  );
}
