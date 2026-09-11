import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccountNav } from "@/components/account-nav";
import { PageHeading } from "@/components/page-heading";
import { getCurrentUser } from "@/lib/auth";
import { listAddresses, MAX_ADDRESSES } from "@/lib/account";
import { AddressBook } from "./address-book";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your addresses",
  robots: { index: false },
};

export default async function AddressesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account/addresses");

  const rows = await listAddresses(user.id);

  return (
    <div className="mx-auto w-full max-w-[960px] px-4 py-10 md:px-6 md:py-12">
      <PageHeading
        eyebrow="Your account"
        title="Your addresses"
        summary="Saved here, offered at checkout. Changing one never changes where a past order went."
      />
      <AccountNav current="/account/addresses" />

      <div className="mt-8">
        <AddressBook
          max={MAX_ADDRESSES}
          addresses={rows.map((row) => ({
            id: row.id,
            label: row.label,
            recipientName: row.recipientName,
            phone: row.phone,
            addressLine1: row.addressLine1,
            addressLine2: row.addressLine2,
            city: row.city,
            district: row.district,
            postalCode: row.postalCode,
            isDefault: row.isDefault,
          }))}
        />
      </div>
    </div>
  );
}
