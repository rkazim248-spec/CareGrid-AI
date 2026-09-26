import { Skeleton, SkeletonRegion } from '@/components/ui';

/**
 * `(auth)` loading — docs/04 §9.1.
 *
 * The skeleton mirrors the real geometry: a heading block, a form row, and a
 * card the height of the incident card. A skeleton with the wrong shape causes
 * a 300 ms layout jump (anti-pattern A8).
 *
 * No `<h1>` and no `<main>`: the group layout already renders the landmark, and
 * a loading state must not add a second document heading.
 */
export default function Loading() {
  return (
    <SkeletonRegion label="Loading a report" className="mx-auto w-full max-w-[760px] px-5 py-8 sm:px-6">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-full max-w-[52ch]" />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Skeleton className="h-12 w-full sm:h-10" />
          <Skeleton className="h-12 w-full sm:h-10 sm:w-32" />
        </div>

        <Skeleton className="h-10 w-full" />

        <div className="flex flex-col gap-3 rounded-card border border-subtle bg-surface p-4">
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-20" />
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </SkeletonRegion>
  );
}
