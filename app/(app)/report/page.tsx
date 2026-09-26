import { PageHeader } from '@/components/layout';
import { ReportView } from '@/features/reporting/report-view';

/**
 * /report — docs/04 §13.2. Allowed for all four roles (FR-001).
 *
 * The `<main>` landmark and the app chrome come from the `(app)` group layout;
 * this page contributes the single `<h1>`.
 */
export default function Page() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Report an incident"
        description="Tell us what is happening. Twenty characters or one photo is enough to start."
      />
      <ReportView />
    </div>
  );
}
