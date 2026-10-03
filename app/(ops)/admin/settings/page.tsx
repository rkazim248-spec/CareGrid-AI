import type { Metadata } from 'next';

import { LiveDataUnavailable } from '@/components/feedback';

export const metadata: Metadata = {
  title: 'Platform settings',
  description: 'Platform settings are unavailable until the live admin service is connected.',
};

export default function AdminSettingsPage() {
  return (
    <LiveDataUnavailable
      title="Platform settings"
      description="Operational settings are not connected to a live administrative service and cannot be saved here."
    />
  );
}
