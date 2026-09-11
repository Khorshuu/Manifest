import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell, safeNext } from "@/components/auth-shell";
import { getCurrentUser } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in",
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
      <LoginForm redirectTo={redirectTo} />
    </AuthShell>
  );
}
