import { type CSSProperties, type FC } from 'react';
import { Link } from 'react-router-dom';
import { Container, Typography } from '@simple-agent-manager/ui';
import { getAllPosts, getCategoryColor, formatDate } from '../lib/blog';
import { useDocumentMeta } from '../hooks/useDocumentMeta';

export const BlogIndex: FC = () => {
  const posts = getAllPosts();

  useDocumentMeta({
    title: 'Blog | Simple Agent Manager',
    description: 'Engineering updates, tutorials, and announcements from the SAM team.',
  });

  return (
    <div style={{ padding: 'var(--sam-space-6) var(--sam-space-4)' }}>
    <Container maxWidth="md">
      <div style={{ marginBottom: 'var(--sam-space-6)' }}>
        <Typography variant="display">Blog</Typography>
        <Typography variant="body-muted" style={{ marginTop: 'var(--sam-space-2)' }}>
          Engineering updates, tutorials, and announcements
        </Typography>
      </div>

      {posts.length === 0 && (
        <Typography variant="body-muted" style={{ textAlign: 'center', padding: 'var(--sam-space-8)' }}>
          No posts yet. Check back soon!
        </Typography>
      )}

      <div style={gridStyle}>
        {posts.map((post) => (
          <Link
            key={post.slug}
            to={`/blog/${post.slug}`}
            style={{ textDecoration: 'none', color: 'inherit' }}
          >
            <article style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', marginBottom: 'var(--sam-space-2)' }}>
                <span
                  style={{
                    fontSize: 'var(--sam-type-caption-size)',
                    fontWeight: 600,
                    color: getCategoryColor(post.category),
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {post.category}
                </span>
                <span style={{ color: 'var(--sam-color-fg-muted)', fontSize: 'var(--sam-type-caption-size)' }}>
                  &middot;
                </span>
                <time
                  style={{ color: 'var(--sam-color-fg-muted)', fontSize: 'var(--sam-type-caption-size)' }}
                  dateTime={post.date}
                >
                  {formatDate(post.date)}
                </time>
              </div>

              <h2
                style={{
                  fontSize: 'var(--sam-type-section-heading-size)',
                  fontWeight: 600,
                  margin: '0 0 var(--sam-space-2)',
                  lineHeight: 1.3,
                  color: 'var(--sam-color-fg-primary)',
                }}
              >
                {post.title}
              </h2>

              <p
                style={{
                  fontSize: 'var(--sam-type-secondary-size)',
                  color: 'var(--sam-color-fg-muted)',
                  margin: '0 0 var(--sam-space-3)',
                  lineHeight: 1.5,
                }}
              >
                {post.excerpt}
              </p>

              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
                {post.tags.map((tag) => (
                  <span
                    key={tag}
                    style={{
                      fontSize: '0.6875rem',
                      padding: '2px 8px',
                      borderRadius: 'var(--sam-radius-sm)',
                      backgroundColor: 'var(--sam-color-info-tint)',
                      color: 'var(--sam-color-fg-muted)',
                    }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </article>
          </Link>
        ))}
      </div>
    </Container>
    </div>
  );
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
  gap: 'var(--sam-space-4)',
};

const cardStyle: CSSProperties = {
  padding: 'var(--sam-space-4)',
  backgroundColor: 'var(--sam-color-bg-surface)',
  borderRadius: 'var(--sam-radius-lg)',
  border: '1px solid var(--sam-color-border-default)',
  transition: 'border-color 0.15s',
  cursor: 'pointer',
};
