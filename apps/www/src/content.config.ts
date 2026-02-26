import { glob } from 'astro/loaders';
import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    date: z.date(),
    author: z.string(),
    category: z.enum(['announcement', 'engineering', 'tutorial', 'devlog']),
    tags: z.array(z.string()),
    excerpt: z.string(),
    draft: z.boolean().optional().default(false),
  }),
});

export const collections = { blog };
