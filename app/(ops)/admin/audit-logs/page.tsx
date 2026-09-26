import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AdminSkeleton } from '@/components/layout';
import { AdminAuditLogsView } from '@/features/admin/admin-views';

export const metadata: Metadata = {
  title: 'Audit log',
  description: 'Append-only record of every privileged action. Retained for 365 days.',
};

export default function AdminAuditLogsPage() {
  return (
    <Suspense fallback={<AdminSkeleton label="Loading the audit log" />}>
      <AdminAuditLogsView />
    </Suspense>
  );
}
