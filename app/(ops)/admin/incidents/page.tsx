import type { Metadata } from 'next';

import { LiveDataUnavailable } from '@/components/feedback';

export const metadata: Metadata = {
  title: 'Incident archive',
  description: 'The administrative incident archive is unavailable until its live service is connected.',
};

export default function AdminIncidentsPage() {
  return (
    <LiveDataUnavailable
      title="Incident archive"
      description="The administrative archive, including deleted incidents, is not connected to a live service."
    />
  );
}
