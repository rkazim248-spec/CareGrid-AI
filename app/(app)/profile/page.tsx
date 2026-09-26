import { PageHeader } from '@/components/layout';
import { ProfileForm } from '@/features/profile/profile-form';

/**
 * `/profile` — docs/04 §13.15. Allowed for all four roles.
 *
 * The `<main>` landmark comes from the `(app)` group layout; the single `<h1>`
 * is the `PageHeader` title, and the section headings inside the form are `h2`.
 */
export default function Page() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Profile" description="Your account details and notification channels." />
      <ProfileForm />
    </div>
  );
}
