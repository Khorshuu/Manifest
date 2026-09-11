"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function MarkReadButton({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={disabled || pending}
      onClick={async () => {
        setPending(true);
        await fetch("/api/admin/inbox", { method: "POST" }).catch(() => null);
        setPending(false);
        router.refresh();
      }}
      className="admin-chip disabled:opacity-50"
    >
      {pending ? "Marking…" : "Mark all as read"}
    </button>
  );
}
