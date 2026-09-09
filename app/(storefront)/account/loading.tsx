import { Skeleton, SkeletonHeading, SkeletonRows } from "@/components/skeleton";

export default function AccountLoading() {
  return (
    <div className="mx-auto w-full max-w-[960px] px-4 py-10 md:px-6 md:py-12">
      <Skeleton>
        <SkeletonHeading />
        <div className="mt-8">
          <SkeletonRows count={3} />
        </div>
      </Skeleton>
    </div>
  );
}
