import type { Metadata } from 'next';

import { AdminRespondersView } from '@/features/admin/admin-views';

export const metadata: Metadata = {
  title: 'Responder verification',
  description: 'Approve or reject responder accounts with a recorded reason.',
};

export default function AdminRespondersPage() {
  return <AdminRespondersView />;
}
