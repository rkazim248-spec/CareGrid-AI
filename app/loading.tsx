import { SkeletonRegion } from '@/components/ui/skeleton';

/**
 * Root loading fallback. Rarely reached — each route group and each data route
 * has its own `loading.tsx` that matches its real geometry (docs/04 §9.1).
 */
export default function Loading() {
  return (
    <SkeletonRegion label="Loading" className="mx-auto w-full max-w-[1600px] px-4 py-6 lg:px-8">
      <div className="flex flex-col gap-4">
        <div className="skeleton-fill h-8 w-64 rounded-sm" />
        <div className="skeleton-fill h-24 w-full rounded-card" />
        <div className="skeleton-fill h-72 w-full rounded-card" />
      </div>
    </SkeletonRegion>
  );
}
