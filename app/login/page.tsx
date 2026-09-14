import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell, safeNext } from "@/components/auth-shell";
import { AuthDivider, GoogleButton } from "@/components/google-button";
import { getCurrentUser } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in",
};

/**
 * What went wrong on the way back from Google, in words a shopper can act on.
 * The callback passes one of these keys and never a provider message, so
 * nothing a third party wrote is rendered here.
 */
const GOOGLE_ERRORS: Record<string, string> = {
  "google-cancelled": "Google sign-in was cancelled. Nothing was changed.",
  "google-expired":
    "That Google sign-in took too long. Start it again from this page.",
  "google-state":
    "That Google sign-in could not be verified. Start it again from this page.",
  "google-unavailable":
    "Google sign-in isn't switched on yet. Use your email and password for now.",
  "google-failed":
    "Google sign-in did not complete. Try again, or use your email and password.",
};

export default async function LoginPage({
  searchParams,
}: PageProps<"/login">) {
  const params = await searchParams;
  const redirectTo = safeNext(params.next);

  const user = await getCurrentUser();
  if (user) redirect(redirectTo);

  const signupHref =
    redirectTo !== "/"
      ? `/register?next=${encodeURIComponent(redirectTo)}`
      : "/register";

  return (
    <AuthShell
      mode="signin"
      title="Sign in"
      summary="Track your preorders, keep a wishlist and manage your delivery addresses."
      next={redirectTo}
      footer={
        <>
          <p>
            New here?{" "}
            <Link
              href={signupHref}
              className="font-semibold text-blue-600 underline-offset-4 hover:underline"
            >
              Create an account
            </Link>
            .
          </p>
          <p className="mt-2">
            Ordered without an account?{" "}
            <Link
              href="/orders/lookup"
              className="text-blue-600 underline-offset-4 hover:underline"
            >
              Track it with your order number
            </Link>
            .
          </p>
        </>
      }
    >
      <div className="mb-6 flex flex-col gap-6">
        <GoogleButton next={redirectTo} />
        <AuthDivider label="or use your email" />
      </div>

      <LoginForm
        redirectTo={redirectTo}
        /* Google proved the password's worth of identity, not the second
           factor: the account still owes a code before it is signed in. */
        startWithCode={params.code === "required"}
        initialError={GOOGLE_ERRORS[String(params.error ?? "")] ?? null}
      />
    </AuthShell>
  );
}
