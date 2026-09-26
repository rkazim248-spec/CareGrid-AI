import { Card, Skeleton, SkeletonRegion } from '@/components/ui';

/**
 * `/incidents/[id]` loading state — docs/04 §13.9, §5.21.
 *
 * Mirrors the real geometry: a header with real badge heights, the two-column
 * body at `xl`, and a 56 px action-bar skeleton. The label names the region once
 * so a screen-reader user hears "Loading this incident" rather than a column of
 * empty boxes.
 */
export default function Loading() {
  return (
    <SkeletonRegion label="Loading this incident" className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-24" />
      </div>
      <Skeleton className="h-6 w-3/4 max-w-full" />
      <Skeleton className="h-2 w-64 max-w-full" />

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Card className="flex flex-col gap-3 p-4">
          {Array.from({ length: 7 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </Card>

        <div className="flex flex-col gap-3">
          <Card className="h-40 p-4">
            <Skeleton className="h-full w-full" />
          </Card>
          <Card className="h-32 p-4">
            <Skeleton className="h-full w-full" />
          </Card>
        </div>
      </div>

      <Skeleton className="h-14 w-full rounded-card xl:hidden" />
    </SkeletonRegion>
  );
}
