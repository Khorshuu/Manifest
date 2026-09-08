import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in",
};

export default async function LoginPage({
  searchParams,
}: PageProps<"/login">) {
  const params = await searchParams;
  const rawNext = typeof params.next === "string" ? params.next : "/";
  // Only same-site paths, so ?next= cannot be used as an open redirect.
  const redirectTo = rawNext.startsWith("/") && !rawNext.startsWith("//")
    ? rawNext
    : "/";

  const user = await getCurrentUser();
  if (user) redirect(redirectTo);

  return (
    <main className="mx-auto w-full max-w-md px-6 py-16">
      <p className="text-meta text-blue-600">Account</p>
      <h1 className="mt-3 font-display text-h1 text-ink">Sign in</h1>
      <p className="mt-3 text-body text-ink/80">
        Track your preorders and manage your delivery addresses.
      </p>

      <div className="mt-10">
        <LoginForm redirectTo={redirectTo} />
      </div>
    </main>
  );
}
