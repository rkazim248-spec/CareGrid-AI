import { Suspense } from 'react';
import type { Metadata } from 'next';

import { PageHeader, SectionHeader } from '@/components/layout';
import { NotificationList } from '@/features/notifications/notification-list';

export const metadata: Metadata = {
  title: 'Notifications',
  description: 'CareGrid AI assignment, status, and response-target notifications.',
};

/**
 * `/notifications` — docs/04 §13.14. Allowed for all four roles.
 *
 * The list reads `?filter=` with `useSearchParams`, so it needs a Suspense
 * boundary. The fallback mirrors the real geometry: a tab strip row and a
 * card-shaped list.
 */
export default function Page() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notifications"
        description="Assignments, verification, and response-target updates for you."
      />

      <Suspense fallback={<NotificationsFallback />}>
        <NotificationList />
      </Suspense>
    </div>
  );
}

function NotificationsFallback() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <SectionHeader title="Loading notifications" />
      <div className="h-72 rounded-card border border-subtle bg-surface" />
    </div>
  );
}
