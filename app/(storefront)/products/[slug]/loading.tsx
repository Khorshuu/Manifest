/**
 * What the product page looks like while its data is on the way.
 *
 * Shaped like the page it precedes rather than a generic spinner, so nothing
 * jumps when the real content lands. The pulse is slow and low-contrast: a
 * loading state should be quiet, since it is by definition the least
 * interesting moment on the page.
 */
export default function ProductLoading() {
  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-8 md:px-6">
      <span className="sr-only" role="status">
        Loading this product
      </span>

      <div aria-hidden="true" className="animate-pulse">
        <div className="h-4 w-56 bg-ink/10" />

        <div className="mt-6 grid gap-10 lg:grid-cols-2">
          <div className="aspect-square w-full bg-ink/10" />

          <div className="flex flex-col gap-6">
            <div className="h-3 w-32 bg-ink/10" />
            <div className="h-10 w-3/4 bg-ink/10" />
            <div className="h-7 w-40 bg-ink/10" />

            <div className="border-y border-ink/10 py-4">
              <div className="h-3 w-28 bg-ink/10" />
              <div className="mt-3 flex gap-1.5">
                {[0, 1, 2, 3].map((cell) => (
                  <div key={cell} className="h-14 w-[3.75rem] bg-ink/10" />
                ))}
              </div>
            </div>

            <div className="flex items-end gap-4">
              <div className="h-11 w-24 bg-ink/10" />
              <div className="h-11 w-32 bg-ink/10" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
