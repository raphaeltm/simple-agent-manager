import { Link } from 'react-router-dom';

export interface BreadcrumbSegment {
  label: string;
  path?: string;
}

export interface BreadcrumbProps {
  segments: BreadcrumbSegment[];
  className?: string;
}

export function Breadcrumb({ segments, className }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className={`sam-type-secondary overflow-hidden ${className ?? ''}`}>
      <ol className="flex items-center gap-1 list-none m-0 p-0 flex-wrap">
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          return (
            <li key={segment.path ?? segment.label} className="flex items-center gap-1 min-w-0">
              {index > 0 && <span className="text-fg-muted select-none shrink-0" aria-hidden="true">/</span>}
              {isLast || !segment.path ? (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className={`text-fg-primary ${isLast ? 'truncate max-w-[200px]' : ''}`}
                  title={isLast ? segment.label : undefined}
                >
                  {segment.label}
                </span>
              ) : (
                <Link
                  to={segment.path}
                  className="text-fg-muted no-underline hover:underline hover:text-fg-primary whitespace-nowrap"
                >
                  {segment.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
