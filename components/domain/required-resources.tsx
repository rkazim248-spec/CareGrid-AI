import * as React from 'react';

import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { RESOURCE_CATALOGUE } from '@/config/resources';
import type { ResourceRequest } from '@/types/domain';

/**
 * RequiredResources — the chips a responder reads to know what to bring.
 *
 * An AI-suggested resource is labelled as such. A responder deciding whether to
 * stop for supplies needs to know whether "Ambulance x1" was in the report or
 * inferred by a model (FR-023: the model may not assert a need absent from the
 * report).
 */
const SOURCE_LABEL: Record<ResourceRequest['source'], string> = {
  ai: 'AI suggestion',
  reporter: 'Asked for in the report',
  dispatcher: 'Requested by a dispatcher',
};

export function RequiredResourceChips({
  resources,
  className,
  max = 4,
}: {
  resources: readonly ResourceRequest[];
  className?: string;
  max?: number;
}) {
  if (resources.length === 0) {
    return (
      <p className={cn('text-xs text-secondary', className)}>
        No resources were identified in this report.
      </p>
    );
  }

  const byId = new Map(RESOURCE_CATALOGUE.map((r) => [r.resourceId, r]));
  const shown = resources.slice(0, max);
  const overflow = resources.length - shown.length;

  return (
    <ul className={cn('flex flex-wrap items-center gap-1.5', className)} aria-label="Required resources">
      {shown.map((resource) => (
        <li key={resource.resourceId}>
          <Badge
            variant="default"
            size="md"
            className="border-default bg-elevated text-primary"
            aria-label={`${byId.get(resource.resourceId)?.name ?? resource.resourceId}, quantity ${resource.quantity}. ${SOURCE_LABEL[resource.source]}.`}
            title={SOURCE_LABEL[resource.source]}
          >
            {byId.get(resource.resourceId)?.name ?? resource.resourceId}
            {resource.quantity > 1 ? (
              <span className="tabular" aria-hidden="true">
                ×{resource.quantity}
              </span>
            ) : null}
          </Badge>
        </li>
      ))}
      {overflow > 0 ? (
        <li className="text-xs text-secondary">+{overflow} more</li>
      ) : null}
    </ul>
  );
}
