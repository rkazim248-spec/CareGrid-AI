import { SkeletonRegion } from '@/components/ui/skeleton';

/**
 * Loading for the admin routes. Mirrors the real geometry: a header, a trust
 * card, and a table-shaped block (anti-pattern A8 — a skeleton with the wrong
 * shape causes a layout jump on every load).
 */
export default function AdminLoading() {
  return (
    <SkeletonRegion label="Loading" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="skeleton-fill h-8 w-64 rounded-sm" />
        <div className="skeleton-fill h-4 w-96 max-w-full rounded-sm" />
      </div>
      <div className="skeleton-fill h-28 w-full rounded-card" />
      <div className="skeleton-fill h-72 w-full rounded-card" />
    </SkeletonRegion>
  );
}
