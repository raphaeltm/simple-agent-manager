import { type FC } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Container, Typography } from '@simple-agent-manager/ui';
import { getPostBySlug, getCategoryColor, formatDate } from '../lib/blog';
import { useDocumentMeta } from '../hooks/useDocumentMeta';
import { RenderedMarkdown } from '../components/MarkdownRenderer';

export const BlogPost: FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const post = slug ? getPostBySlug(slug) : undefined;

  useDocumentMeta({
    title: post ? `${post.title} | SAM Blog` : 'Post Not Found | SAM Blog',
    description: post?.excerpt,
  });

  if (!post) {
    return (
      <div style={{ padding: 'var(--sam-space-8) var(--sam-space-4)', textAlign: 'center' }}>
      <Container maxWidth="sm">
        <Typography variant="display">404</Typography>
        <Typography variant="body-muted" style={{ marginTop: 'var(--sam-space-2)' }}>
          Post not found.
        </Typography>
        <Link
          to="/blog"
          style={{
            display: 'inline-block',
            marginTop: 'var(--sam-space-4)',
            color: 'var(--sam-color-info)',
            textDecoration: 'none',
          }}
        >
          &larr; Back to blog
        </Link>
      </Container>
      </div>
    );
  }

  return (
    <div style={{ padding: 'var(--sam-space-6) var(--sam-space-4)' }}>
    <Container maxWidth="sm">
      {/* Back link */}
      <Link
        to="/blog"
        style={{
          fontSize: 'var(--sam-type-secondary-size)',
          color: 'var(--sam-color-fg-muted)',
          textDecoration: 'none',
          display: 'inline-block',
          marginBottom: 'var(--sam-space-4)',
        }}
      >
        &larr; All posts
      </Link>

      {/* Article header */}
      <header style={{ marginBottom: 'var(--sam-space-4)' }}>
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

        <h1
          style={{
            fontSize: 'var(--sam-type-display-size)',
            fontWeight: 700,
            margin: '0 0 var(--sam-space-2)',
            lineHeight: 1.2,
            color: 'var(--sam-color-fg-primary)',
          }}
        >
          {post.title}
        </h1>

        <Typography variant="body-muted">By {post.author}</Typography>
      </header>

      {/* Article body */}
      <RenderedMarkdown
        content={post.content}
        style={{ padding: 0, fontSize: '1rem', lineHeight: 1.7 }}
      />

      {/* Tags */}
      {post.tags.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 'var(--sam-space-2)',
            flexWrap: 'wrap',
            marginTop: 'var(--sam-space-6)',
            paddingTop: 'var(--sam-space-4)',
            borderTop: '1px solid var(--sam-color-border-default)',
          }}
        >
          {post.tags.map((tag) => (
            <span
              key={tag}
              style={{
                fontSize: '0.75rem',
                padding: '3px 10px',
                borderRadius: 'var(--sam-radius-sm)',
                backgroundColor: 'var(--sam-color-info-tint)',
                color: 'var(--sam-color-fg-muted)',
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </Container>
    </div>
  );
};
