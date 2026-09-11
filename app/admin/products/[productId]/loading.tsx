/** Skeleton for the product editor: header, action bar, tabs, fields. */
export default function ProductLoading() {
  const bar = "animate-pulse rounded bg-blue-200/60";
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading product">
      <div className="flex flex-col gap-2">
        <span className={`${bar} h-4 w-24`} />
        <span className={`${bar} h-7 w-2/3 max-w-lg`} />
      </div>
      <span className={`${bar} h-12 rounded-card`} />
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 9 }, (_, index) => (
          <span key={index} className={`${bar} h-9 w-24`} />
        ))}
      </div>
      <div className="flex max-w-2xl flex-col gap-4">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2">
            <span className={`${bar} h-4 w-32`} />
            <span className={`${bar} h-11 w-full`} />
          </div>
        ))}
      </div>
    </div>
  );
}
