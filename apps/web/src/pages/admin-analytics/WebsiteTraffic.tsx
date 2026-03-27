import { type FC } from 'react';
import { Body } from '@simple-agent-manager/ui';
import type { AnalyticsWebsiteTrafficResponse, WebsiteTrafficSection } from '../../lib/api';

interface Props {
  data: AnalyticsWebsiteTrafficResponse | null;
}

const SECTION_LABELS: Record<string, string> = {
  landing: 'Landing Page',
  blog: 'Blog',
  docs: 'Documentation',
  presentations: 'Presentations',
  other: 'Other Pages',
};

function formatNumber(n: number): string {
  return n.toLocaleString();
}

const SectionCard: FC<{ section: WebsiteTrafficSection; maxViews: number }> = ({ section, maxViews }) => {
  const widthPercent = maxViews > 0 ? Math.max((section.views / maxViews) * 100, 3) : 3;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="w-32 text-sm font-medium text-fg-primary truncate">
          {SECTION_LABELS[section.name] ?? section.name}
        </div>
        <div
          className="flex-1 h-6 bg-surface-secondary rounded-sm overflow-hidden"
          role="img"
          aria-label={`${SECTION_LABELS[section.name] ?? section.name}: ${formatNumber(section.views)} views, ${formatNumber(section.unique_visitors)} visitors`}
        >
          <div
            className="h-full bg-accent-emphasis rounded-sm transition-all"
            style={{ width: `${widthPercent}%` }}
            aria-hidden="true"
          />
        </div>
        <div className="w-16 text-xs text-fg-secondary tabular-nums text-right flex-shrink-0">
          {formatNumber(section.views)}
        </div>
        <div className="w-20 text-xs text-fg-muted tabular-nums text-right flex-shrink-0">
          {formatNumber(section.unique_visitors)} visitors
        </div>
      </div>

      {/* Top pages within this section */}
      {section.topPages.length > 0 && (
        <div className="ml-36 flex flex-col gap-0.5">
          {section.topPages.slice(0, 5).map((p) => (
            <div key={p.page} className="flex items-center gap-2 text-xs">
              <span className="text-fg-muted truncate flex-1" title={p.page}>
                {p.page}
              </span>
              <span className="text-fg-secondary tabular-nums flex-shrink-0">
                {formatNumber(p.views)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const WebsiteTraffic: FC<Props> = ({ data }) => {
  if (!data?.hosts?.length) {
    return <Body className="text-fg-muted">No website traffic data available yet.</Body>;
  }

  return (
    <div className="flex flex-col gap-6">
      {data.hosts.map((host) => {
        const maxViews = Math.max(...host.sections.map((s) => s.views), 1);

        return (
          <div key={host.host} className="flex flex-col gap-3">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-fg-primary">{host.host}</span>
              <span className="text-xs text-fg-muted">
                {formatNumber(host.totalViews)} views &middot; {formatNumber(host.uniqueVisitors)} visitors &middot; {formatNumber(host.uniqueSessions)} sessions
              </span>
            </div>

            {host.sections.length > 0 ? (
              <div className="flex flex-col gap-3">
                {host.sections.map((section) => (
                  <SectionCard key={section.name} section={section} maxViews={maxViews} />
                ))}
              </div>
            ) : (
              <Body className="text-fg-muted text-xs">No section data</Body>
            )}
          </div>
        );
      })}
    </div>
  );
};
