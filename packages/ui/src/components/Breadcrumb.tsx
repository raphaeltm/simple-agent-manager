import { type CSSProperties } from 'react';
import { Link } from 'react-router-dom';

export interface BreadcrumbSegment {
  label: string;
  path?: string;
}

export interface BreadcrumbProps {
  segments: BreadcrumbSegment[];
  className?: string;
}

const navStyle: CSSProperties = {
  fontSize: 'var(--sam-type-secondary-size)',
  lineHeight: 'var(--sam-type-secondary-line-height)',
};

const listStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sam-space-1)',
  listStyle: 'none',
  margin: 0,
  padding: 0,
};

const separatorStyle: CSSProperties = {
  color: 'var(--sam-color-fg-muted)',
  userSelect: 'none',
};

const linkStyle: CSSProperties = {
  color: 'var(--sam-color-fg-muted)',
  textDecoration: 'none',
};

const currentStyle: CSSProperties = {
  color: 'var(--sam-color-fg-primary)',
};

export function Breadcrumb({ segments, className }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className={className} style={navStyle}>
      <ol style={listStyle}>
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          return (
            <li key={segment.path ?? segment.label} style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-1)' }}>
              {index > 0 && <span style={separatorStyle} aria-hidden="true">/</span>}
              {isLast || !segment.path ? (
                <span aria-current={isLast ? 'page' : undefined} style={currentStyle}>
                  {segment.label}
                </span>
              ) : (
                <Link to={segment.path} style={linkStyle} className="sam-breadcrumb-link">
                  {segment.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>

      <style>{`
        .sam-breadcrumb-link:hover {
          text-decoration: underline;
          color: var(--sam-color-fg-primary);
        }
      `}</style>
    </nav>
  );
}
