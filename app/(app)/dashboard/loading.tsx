import { Card, Skeleton, SkeletonRegion } from '@/components/ui';
import { KpiStripSkeleton } from '@/features/dashboard/kpi-strip';
import { RoleGate } from '@/features/shared/role-gate';

/**
 * `/dashboard` loading state — docs/04 §13.7, §5.21, §9.1.
 *
 * Geometry is mirrored, not approximated: 5 KPI tiles and 12 queue rows at the
 * real column widths, so the first paint does not jump (anti-pattern A8). The
 * whole region is announced once by `SkeletonRegion`; the individual skeletons
 * are `aria-hidden`, because a screen reader should hear "Loading the incident
 * dashboard", not a column of empty boxes.
 */
const QUEUE_COLUMN_WIDTHS = [
  'w-[7ch]',
  'w-[9ch]',
  'w-[7ch]',
  'w-[11ch]',
  'w-[13ch]',
  'w-[8ch]',
  'w-[6ch]',
  'w-[5ch]',
  'w-[10ch]',
  'w-[9ch]',
] as const;

export default function Loading() {
  return (
    <RoleGate href="/dashboard">
      <SkeletonRegion label="Loading the incident dashboard" className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>

        <KpiStripSkeleton />

        <Skeleton className="h-32 w-full rounded-card" />

        <Card className="overflow-hidden">
          <div className="flex flex-col divide-y divide-subtle">
            {Array.from({ length: 12 }, (_, rowIndex) => (
              <div key={rowIndex} className="flex items-center gap-4 px-4 py-3">
                {QUEUE_COLUMN_WIDTHS.map((width, columnIndex) => (
                  <Skeleton key={columnIndex} className={`h-4 ${width}`} />
                ))}
              </div>
            ))}
          </div>
        </Card>
      </SkeletonRegion>
    </RoleGate>
  );
}
