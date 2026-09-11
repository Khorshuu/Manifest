/** Skeleton for the product list, laid out like the page so nothing jumps. */
export default function ProductsLoading() {
  const bar = "animate-pulse rounded bg-blue-200/60";
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading products">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <span className={`${bar} h-6 w-32`} />
          <span className={`${bar} h-4 w-72`} />
        </div>
        <span className={`${bar} h-11 w-36`} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <span key={index} className={`${bar} h-[62px] rounded-card`} />
        ))}
      </div>
      <span className={`${bar} h-[62px] rounded-card`} />
      <div className="admin-card flex flex-col gap-3">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex items-center gap-3">
            <span className={`${bar} size-10`} />
            <span className={`${bar} h-4 flex-1`} />
            <span className={`${bar} hidden h-4 w-24 md:block`} />
            <span className={`${bar} hidden h-4 w-20 md:block`} />
            <span className={`${bar} h-8 w-24`} />
          </div>
        ))}
      </div>
    </div>
  );
}
