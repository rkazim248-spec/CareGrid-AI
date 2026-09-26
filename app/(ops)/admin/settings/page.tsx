import type { Metadata } from 'next';

import { AdminSettingsView } from '@/features/admin/admin-views';

export const metadata: Metadata = {
  title: 'Platform settings',
  description: 'Duplicate-detection thresholds and response targets. Every change is recorded.',
};

export default function AdminSettingsPage() {
  return <AdminSettingsView />;
}
