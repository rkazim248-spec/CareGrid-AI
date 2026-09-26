import { Suspense } from 'react';
import type { Metadata } from 'next';

import { PageHeader, SectionHeader } from '@/components/layout';
import { SettingsView } from '@/features/settings/settings-view';
import { SETTINGS_COPY } from '@/features/settings/settings-copy';

export const metadata: Metadata = {
  title: 'Settings',
  description: 'CareGrid AI notification, display, and privacy settings.',
};

/**
 * `/settings` — docs/04 §13.16.
 *
 * `SettingsView` reads `?tab=` with `useSearchParams`, which opts the subtree
 * into client-side rendering and therefore needs a Suspense boundary. The
 * fallback mirrors the real geometry: a heading and a card.
 */
export default function Page() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={SETTINGS_COPY.title} description={SETTINGS_COPY.description} />

      <Suspense fallback={<SettingsFallback />}>
        <SettingsView />
      </Suspense>
    </div>
  );
}

function SettingsFallback() {
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4" aria-busy="true">
      <SectionHeader title="Loading settings" />
      <div className="h-64 rounded-card border border-subtle bg-surface" />
    </div>
  );
}
