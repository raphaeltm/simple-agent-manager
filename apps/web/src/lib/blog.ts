// ---------- Types ----------

export interface BlogPostMeta {
  title: string;
  slug: string;
  date: string;
  excerpt: string;
  author: string;
  category: string;
  tags: string[];
}

export interface BlogPost extends BlogPostMeta {
  content: string;
}

// ---------- Category Colors ----------

const CATEGORY_COLORS: Record<string, string> = {
  announcement: 'var(--sam-color-info)',
  engineering: 'var(--sam-color-success)',
  tutorial: 'var(--sam-color-purple)',
  devlog: 'var(--sam-color-warning)',
};

export function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category.toLowerCase()] ?? 'var(--sam-color-fg-muted)';
}

// ---------- Frontmatter Parser ----------

/**
 * Simple YAML-like frontmatter parser. Handles key: value pairs and
 * comma-separated arrays for `tags`. No external dependency needed.
 *
 * Expected format:
 * ---
 * title: My Post
 * tags: foo, bar, baz
 * ---
 */
function parseFrontmatter(raw: string): { meta: Record<string, string>; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) return { meta: {}, content: raw };

  const frontmatterBlock = match[1] ?? '';
  const bodyContent = match[2] ?? '';
  const meta: Record<string, string> = {};
  for (const line of frontmatterBlock.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, content: bodyContent };
}

function toMeta(slug: string, meta: Record<string, string>): BlogPostMeta {
  return {
    title: meta.title ?? 'Untitled',
    slug,
    date: meta.date ?? '',
    excerpt: meta.excerpt ?? '',
    author: meta.author ?? 'SAM Team',
    category: meta.category ?? 'engineering',
    tags: meta.tags ? meta.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
  };
}

// ---------- Post Loading ----------

const modules = import.meta.glob<string>('/src/content/blog/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function slugFromPath(path: string): string {
  const filename = path.split('/').pop() ?? '';
  return filename.replace(/\.md$/, '');
}

function loadAllPosts(): BlogPost[] {
  const posts: BlogPost[] = [];

  for (const [path, raw] of Object.entries(modules)) {
    // Skip CLAUDE.md (it's the authoring guide, not a blog post)
    if (path.endsWith('/CLAUDE.md')) continue;

    const slug = slugFromPath(path);
    const { meta, content } = parseFrontmatter(raw);
    posts.push({ ...toMeta(slug, meta), content });
  }

  // Sort by date descending
  posts.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
  return posts;
}

// Cache after first call
let cachedPosts: BlogPost[] | null = null;

export function getAllPosts(): BlogPost[] {
  if (!cachedPosts) cachedPosts = loadAllPosts();
  return cachedPosts;
}

export function getPostBySlug(slug: string): BlogPost | undefined {
  return getAllPosts().find((p) => p.slug === slug);
}

// ---------- Date Formatting ----------

export function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
