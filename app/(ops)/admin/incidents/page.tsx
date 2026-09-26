import type { Metadata } from 'next';

import { AdminIncidentsView } from '@/features/admin/admin-views';

export const metadata: Metadata = {
  title: 'Incident archive',
  description: 'Every incident, including soft-deleted ones. Restoring is reversible.',
};

export default function AdminIncidentsPage() {
  return <AdminIncidentsView />;
}
