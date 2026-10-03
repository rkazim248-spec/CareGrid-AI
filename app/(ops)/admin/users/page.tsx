import type { Metadata } from 'next';

import { LiveDataUnavailable } from '@/components/feedback';

export const metadata: Metadata = {
  title: 'Users',
  description: 'Account and access information is unavailable until the live admin service is connected.',
};

export default function AdminUsersPage() {
  return (
    <LiveDataUnavailable
      title="User management"
      description="User records and access controls are not connected to a live administrative service."
    />
  );
}
