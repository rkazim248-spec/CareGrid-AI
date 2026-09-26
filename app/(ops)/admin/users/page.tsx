import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AdminSkeleton } from '@/components/layout';
import { AdminUsersView } from '@/features/admin/admin-users-view';

export const metadata: Metadata = {
  title: 'Users',
  description: 'Accounts, roles, and access state. Every change is recorded with a reason.',
};

export default function AdminUsersPage() {
  return (
    <Suspense fallback={<AdminSkeleton label="Loading users" />}>
      <AdminUsersView />
    </Suspense>
  );
}
