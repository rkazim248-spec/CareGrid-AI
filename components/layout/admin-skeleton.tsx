import { SkeletonRegion } from '@/components/ui/skeleton';

/**
 * The loading skeleton for a data-heavy admin route.
 *
 * Lives outside the layout because a Next.js layout may only export `default`,
 * `metadata`, and the framework config hooks — exporting a component from one
 * is a build error, not a style choice.
 *
 * It mirrors the real geometry: a header, a card, and a table-shaped block
 * (anti-pattern A8).
 */
export function AdminSkeleton({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="skeleton-fill h-8 w-64 rounded-sm" />
        <div className="skeleton-fill h-4 w-96 max-w-full rounded-sm" />
      </div>
      <div className="skeleton-fill h-28 w-full rounded-card" />
      <div className="skeleton-fill h-72 w-full rounded-card" />
    </SkeletonRegion>
  );
}
