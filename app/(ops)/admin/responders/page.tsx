import type { Metadata } from 'next';

import { LiveDataUnavailable } from '@/components/feedback';

export const metadata: Metadata = {
  title: 'Responder verification',
  description: 'Responder verification is unavailable until the live admin service is connected.',
};

export default function AdminRespondersPage() {
  return (
    <LiveDataUnavailable
      title="Responder verification"
      description="Responder verification and review actions are not connected to a live administrative service."
    />
  );
}
