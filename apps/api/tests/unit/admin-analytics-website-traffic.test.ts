import { describe, expect, it } from 'vitest';

/**
 * Tests for the website traffic admin analytics endpoint.
 *
 * Tests the page classification logic and response structure building
 * that the GET /api/admin/analytics/website-traffic endpoint uses.
 */

type SectionName = 'landing' | 'blog' | 'docs' | 'presentations' | 'other';

/** Replicated from admin-analytics.ts to test classification logic */
function classifyPage(page: string): SectionName {
  if (page.startsWith('/blog')) return 'blog';
  if (page.startsWith('/docs')) return 'docs';
  if (page.startsWith('/presentations')) return 'presentations';
  if (page === '/' || page === '') return 'landing';
  return 'other';
}

describe('website traffic — page classification', () => {
  it('classifies root path as landing', () => {
    expect(classifyPage('/')).toBe('landing');
    expect(classifyPage('')).toBe('landing');
  });

  it('classifies blog paths', () => {
    expect(classifyPage('/blog')).toBe('blog');
    expect(classifyPage('/blog/')).toBe('blog');
    expect(classifyPage('/blog/my-first-post')).toBe('blog');
    expect(classifyPage('/blog/2026/03/analytics-update')).toBe('blog');
  });

  it('classifies docs paths', () => {
    expect(classifyPage('/docs')).toBe('docs');
    expect(classifyPage('/docs/')).toBe('docs');
    expect(classifyPage('/docs/overview')).toBe('docs');
    expect(classifyPage('/docs/guides/self-hosting')).toBe('docs');
  });

  it('classifies presentations paths', () => {
    expect(classifyPage('/presentations')).toBe('presentations');
    expect(classifyPage('/presentations/')).toBe('presentations');
    expect(classifyPage('/presentations/demo-2026')).toBe('presentations');
  });

  it('classifies unknown paths as other', () => {
    expect(classifyPage('/about')).toBe('other');
    expect(classifyPage('/pricing')).toBe('other');
    expect(classifyPage('/contact')).toBe('other');
  });
});

describe('website traffic — response structure', () => {
  it('builds host sections from page data', () => {
    // Simulate the server-side grouping logic
    const topPagesData = [
      { host: 'www.example.com', page: '/', views: 100, unique_visitors: 50 },
      { host: 'www.example.com', page: '/blog/post-1', views: 80, unique_visitors: 40 },
      { host: 'www.example.com', page: '/blog/post-2', views: 60, unique_visitors: 30 },
      { host: 'www.example.com', page: '/docs/overview', views: 40, unique_visitors: 20 },
      { host: 'app.example.com', page: '/', views: 200, unique_visitors: 100 },
    ];

    const hostSections = new Map<
      string,
      Map<SectionName, { views: number; pages: Array<{ page: string; views: number }> }>
    >();

    for (const row of topPagesData) {
      if (!hostSections.has(row.host)) hostSections.set(row.host, new Map());
      const sections = hostSections.get(row.host)!;
      const section = classifyPage(row.page);

      if (!sections.has(section)) {
        sections.set(section, { views: 0, pages: [] });
      }
      const s = sections.get(section)!;
      s.views += row.views;
      s.pages.push({ page: row.page, views: row.views });
    }

    // www.example.com should have landing, blog, docs sections
    const wwwSections = hostSections.get('www.example.com')!;
    expect(wwwSections.size).toBe(3);
    expect(wwwSections.get('landing')!.views).toBe(100);
    expect(wwwSections.get('blog')!.views).toBe(140);
    expect(wwwSections.get('blog')!.pages).toHaveLength(2);
    expect(wwwSections.get('docs')!.views).toBe(40);

    // app.example.com should have only landing
    const appSections = hostSections.get('app.example.com')!;
    expect(appSections.size).toBe(1);
    expect(appSections.get('landing')!.views).toBe(200);
  });

  it('section totals accurately sum page views', () => {
    const pages = [
      { page: '/blog/a', views: 10 },
      { page: '/blog/b', views: 20 },
      { page: '/blog/c', views: 30 },
    ];

    const total = pages.reduce((sum, p) => sum + p.views, 0);
    expect(total).toBe(60);
  });
});

describe('website traffic — period parameter', () => {
  /** Replicated from admin-analytics.ts */
  function periodToInterval(period: string): string {
    switch (period) {
      case '24h': return "INTERVAL '1' DAY";
      case '30d': return "INTERVAL '30' DAY";
      case '90d': return "INTERVAL '90' DAY";
      case '7d':
      default: return "INTERVAL '7' DAY";
    }
  }

  it('maps period strings to SQL intervals', () => {
    expect(periodToInterval('24h')).toBe("INTERVAL '1' DAY");
    expect(periodToInterval('7d')).toBe("INTERVAL '7' DAY");
    expect(periodToInterval('30d')).toBe("INTERVAL '30' DAY");
    expect(periodToInterval('90d')).toBe("INTERVAL '90' DAY");
  });

  it('defaults unknown period to 7d', () => {
    expect(periodToInterval('unknown')).toBe("INTERVAL '7' DAY");
    expect(periodToInterval('')).toBe("INTERVAL '7' DAY");
  });
});
