import type { Metadata } from 'next';

import { AdminOverviewView } from '@/features/admin/admin-overview-view';

export const metadata: Metadata = {
  title: 'Administration',
  description:
    'Platform trust, account state, responder verification, and the audit record of every privileged action.',
};

export default function AdminOverviewPage() {
  return <AdminOverviewView />;
}
