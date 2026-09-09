import { Skeleton, SkeletonBar, SkeletonHeading } from "@/components/skeleton";

export default function AdminLoading() {
  return (
    <Skeleton>
      <SkeletonHeading />

      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="flex flex-col gap-3 rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]"
          >
            <SkeletonBar className="h-3 w-20" />
            <SkeletonBar className="h-7 w-12" />
          </div>
        ))}
      </div>

      <div className="mt-10 rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]">
        <SkeletonBar className="h-4 w-full" />
        <SkeletonBar className="mt-4 h-4 w-full" />
        <SkeletonBar className="mt-4 h-4 w-3/4" />
      </div>
    </Skeleton>
  );
}
