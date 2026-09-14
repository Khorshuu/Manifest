import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell, safeNext } from "@/components/auth-shell";
import { AuthDivider, GoogleButton } from "@/components/google-button";
import { getCurrentUser } from "@/lib/auth";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = {
  title: "Create an account",
  robots: { index: false },
};

export default async function RegisterPage({
  searchParams,
}: PageProps<"/register">) {
  const params = await searchParams;
  const redirectTo = safeNext(params.next);

  const user = await getCurrentUser();
  if (user) redirect(redirectTo);

  return (
    <AuthShell
      mode="signup"
      title="Create your account"
      summary="Save products to a wishlist, check out faster and follow every order from the US to your door."
      next={redirectTo}
      footer={
        <p>
          Already have an account?{" "}
          <Link
            href={
              redirectTo !== "/"
                ? `/login?next=${encodeURIComponent(redirectTo)}`
                : "/login"
            }
            className="font-semibold text-blue-600 underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
          .
        </p>
      }
    >
      <div className="mb-6 flex flex-col gap-6">
        <GoogleButton next={redirectTo} label="Sign up with Google" />
        <AuthDivider label="or use your email" />
      </div>

      <RegisterForm redirectTo={redirectTo} />
    </AuthShell>
  );
}
