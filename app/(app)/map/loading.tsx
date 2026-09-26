import { Loader2 } from 'lucide-react';

import { Card, Skeleton, SkeletonRegion } from '@/components/ui';
import { RoleGate } from '@/features/shared/role-gate';

/**
 * `/map` loading state — docs/04 §13.10.
 *
 * "A `Skeleton` map frame with a centred `Loader2` and 'Loading map'; the list
 * loads in parallel so something useful is always present." Both halves are here
 * for exactly that reason: a map-only skeleton would leave a screen-reader user
 * with a spinner and nothing to read, because the map canvas is `aria-hidden` and
 * the list is this page's accessible content.
 */
export default function Loading() {
  return (
    <RoleGate href="/map">
      <SkeletonRegion label="Loading the map and the incident list" className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>

        <Skeleton className="h-32 w-full rounded-card" />

        <div className="grid min-w-0 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="flex flex-col gap-3">
            <Card className="h-28 p-3">
              <Skeleton className="h-full w-full" />
            </Card>
            <Card className="h-64 p-3">
              <Skeleton className="h-full w-full" />
            </Card>
          </div>

          <Card className="relative flex min-h-[320px] items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <Loader2
                className="size-6 animate-[var(--animate-spin-slow)] text-muted motion-reduce:animate-none"
                aria-hidden="true"
              />
              <p className="text-sm text-secondary">Loading map</p>
            </div>
          </Card>
        </div>
      </SkeletonRegion>
    </RoleGate>
  );
}
