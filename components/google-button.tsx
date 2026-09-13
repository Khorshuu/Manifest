import { buttonClass } from "./button";

/**
 * "Continue with Google", rendered only where the server has said the
 * credentials exist. It is a plain link, not a fetch: the flow is a redirect
 * to Google and back, so it works before JavaScript has loaded.
 */
export function GoogleButton({
  next = "/",
  label = "Continue with Google",
  className = "",
}: {
  next?: string;
  label?: string;
  className?: string;
}) {
  const href =
    next && next !== "/"
      ? `/api/auth/google/start?next=${encodeURIComponent(next)}`
      : "/api/auth/google/start";

  return (
    <a
      href={href}
      className={buttonClass({
        variant: "secondary",
        size: "lg",
        className: `w-full ${className}`,
      })}
    >
      <GoogleMark />
      {label}
    </a>
  );
}

/** Google's mark, at the colours their branding guidelines require. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" width={18} height={18} aria-hidden="true" className="shrink-0">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.35 0-4.34-1.58-5.05-3.71H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.95 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l2.99-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l2.99 2.33C4.66 5.16 6.65 3.58 9 3.58Z"
      />
    </svg>
  );
}

/** A rule with "or" in the middle, between Google and the email form. */
export function AuthDivider() {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <span className="h-px flex-1 bg-ink/12" />
      <span className="text-meta text-ink/70">or</span>
      <span className="h-px flex-1 bg-ink/12" />
    </div>
  );
}
