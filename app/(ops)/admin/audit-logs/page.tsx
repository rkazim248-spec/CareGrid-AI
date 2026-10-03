import type { Metadata } from 'next';

import { LiveDataUnavailable } from '@/components/feedback';

export const metadata: Metadata = {
  title: 'Audit log',
  description: 'The audit log is unavailable until the live administrative service is connected.',
};

export default function AdminAuditLogsPage() {
  return (
    <LiveDataUnavailable
      title="Audit log"
      description="Privileged-action records are not connected to a live audit service. No sample events are shown."
    />
  );
}
