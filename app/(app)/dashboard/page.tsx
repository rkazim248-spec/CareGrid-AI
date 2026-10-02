import type { Metadata } from 'next';

import { DashboardView } from '@/features/dashboard/dashboard-view';

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Your CareGrid account and the incident reports available to you.',
};

export default function Page() {
  return <DashboardView />;
}
