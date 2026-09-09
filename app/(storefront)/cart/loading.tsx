import {
  Skeleton,
  SkeletonBar,
  SkeletonHeading,
} from "@/components/skeleton";

export default function CartLoading() {
  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-10 md:px-6 md:py-12">
      <Skeleton>
        <SkeletonHeading />

        <div className="mt-8 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-12">
          <div className="flex flex-col gap-4">
            {[0, 1].map((row) => (
              <div
                key={row}
                className="flex gap-5 rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-raise)]"
              >
                <SkeletonBar className="size-28 shrink-0" />
                <div className="flex flex-1 flex-col gap-2">
                  <SkeletonBar className="h-5 w-56" />
                  <SkeletonBar className="h-3 w-24" />
                  <SkeletonBar className="h-6 w-20" />
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-4 rounded-card border border-blue-300 bg-paper p-6 shadow-[var(--shadow-lift)]">
            <SkeletonBar className="h-7 w-32" />
            <SkeletonBar className="h-4 w-full" />
            <SkeletonBar className="h-4 w-full" />
            <SkeletonBar className="h-12 w-full" />
          </div>
        </div>
      </Skeleton>
    </div>
  );
}
