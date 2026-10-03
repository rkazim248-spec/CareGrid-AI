import type { Metadata } from 'next';

import { LiveDataUnavailable } from '@/components/feedback';

export const metadata: Metadata = {
  title: 'Administration',
  description:
    'Platform trust, account state, responder verification, and the audit record of every privileged action.',
};

export default function AdminOverviewPage() {
  return (
    <LiveDataUnavailable
      title="Administration"
      description="Account, responder-verification, and audit information is not connected to live administrative services in this build."
    />
  );
}
