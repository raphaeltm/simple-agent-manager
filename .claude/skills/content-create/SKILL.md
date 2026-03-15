---
name: content-create
description: Content creation from strategy artifacts. Drafts social media posts, blog outlines, changelog announcements, product launch copy, and developer content. Trigger when asked to write social posts, blog content, announcements, launch copy, or atomize strategy docs into publishable content.
user-invocable: true
---

# Content Creation

Transform strategy documents, product changes, and competitive insights into publishable content drafts.

## Prerequisites — Read These First

Before creating ANY content:
1. Read `strategy/content/style-guide-raph.md` for Raph's personal writing style
2. Read `strategy/marketing/messaging-guide.md` for voice, tone, approved language
3. Read `strategy/marketing/positioning.md` for core positioning and differentiators
4. Read `strategy/competitive/` for competitive context
5. For changelogs: check `git log`, recent PRs, and `specs/`
6. For technical content: read relevant source code and architecture docs

**Never create content without reading the style guide and messaging guide first.**

## Personal Hook Requirement

Every blog post and long-form piece needs a personal hook. A real story, experience, or observation from Raph that grounds the piece. Before writing:

1. Search the repo for relevant context: `docs/notes/`, `tasks/`, commit history, PR descriptions, post-mortems
2. Check `strategy/content/` for any existing notes or hooks the human may have left
3. **If you cannot find a personal story or hook in the repo, ASK the human before writing.** Say something like: "I have the technical content but I need a personal angle. Do you have a story about how this came up, what prompted it, or what surprised you?"

Do NOT fabricate personal stories. Do NOT substitute a generic "as developers, we all know..." opening. If there's no personal hook available, ask for one.

## Platform Guide (Tech Content)

Each platform has different norms, constraints, and audiences. Content must be adapted per platform, not copy-pasted across them.

### LinkedIn

- **Audience**: Professional network. Mix of developers, engineering managers, founders, tech-adjacent people.
- **Format**: Text posts perform best. No character limit in practice, but 1,300 chars is the fold ("see more"). Front-load the hook.
- **What works**: Personal builder stories, lessons learned, contrarian takes backed by experience. "I built X and here's what surprised me" format.
- **What doesn't**: Pure announcements with no insight. Marketing-speak. Posts that read like press releases.
- **Structure**: Short paragraphs (1-3 sentences). Line breaks between them. No headers. Can use bold sparingly. End with a question or a link, not both.
- **Links**: LinkedIn deprioritizes posts with links. Put the link in a comment or at the very end. Lead with the story, not the URL.
- **Hashtags**: 3-5 max, at the end. Relevant ones like #opensource #devtools #AIagents. Don't overdo it.

### Twitter/X

- **Audience**: Developers, open-source community, tech influencers. Fast-moving.
- **Format**: 280 chars per tweet. Threads for complex topics (4-6 tweets, not 20). Always include a single-tweet variant.
- **What works**: Concrete observations, technical surprises, debugging war stories. Code snippets in screenshots. Short and direct.
- **What doesn't**: Vague teasers ("Big announcement coming!"). Marketing tone. Threads that could have been one tweet.
- **Structure**: Tweet 1 is the hook. It must stand alone. Don't start with "Thread:" or "1/". End the thread with a link and a clear takeaway.
- **Media**: Images and code screenshots increase engagement. Consider a terminal screenshot or architecture diagram.

### Bluesky

- **Audience**: Growing dev community, especially open-source and indie builders. More conversational than Twitter.
- **Format**: 300 chars per post. Threads supported. Similar to early Twitter culture.
- **What works**: Same as Twitter but slightly more relaxed. Open-source community is strong here. Genuine, not performative.
- **What doesn't**: Cross-posted Twitter content that references Twitter-specific things ("RT", "quote tweet"). Adapt, don't copy.
- **Note**: Growing quickly in dev circles. Worth posting to even if the audience is smaller.

### Mastodon / Fediverse

- **Audience**: Privacy-conscious developers, open-source advocates, European tech community. Strong overlap with SAM's values.
- **Format**: 500 chars (most instances). CW (content warnings) for topics some find sensitive. Alt text on images expected.
- **What works**: Open-source announcements, European tech angles, technical deep-dives. The audience is technical and values substance.
- **What doesn't**: Growth-hacking tone, engagement bait, "like and share" CTAs. The culture actively rejects this.
- **Instances**: Post from a relevant instance or use hashtags like #opensource #foss #devtools #selfhosted.
- **Note**: Particularly good for SAM's European/open-source angle. The Scaleway/Mistral post would resonate here.

### Hacker News

- **Audience**: Technical builders, founders, senior engineers. Skeptical, detail-oriented.
- **Format**: Title + optional text body for Show HN. Title must start with "Show HN:" for project submissions.
- **Title rules**: No clickbait, no ALL CAPS, no exclamation marks. Use the original article title or a factual description. Strip gratuitous numbers.
- **Show HN rules**: Must be something you made that people can try. Blog posts alone don't qualify as Show HN (use the blog link with a regular submission instead). Minimize signup barriers.
- **What works**: Technical honesty, trade-off acknowledgment, "here's what went wrong" stories. The debugging journey section is perfect for HN.
- **What doesn't**: Marketing language (instant death). Superlatives. Anything that sounds like a press release. Over-designed landing pages.
- **Comments**: Be present in the thread. Answer questions directly and technically. Don't get defensive.
- **Timing**: Weekday mornings US Eastern tend to get more visibility.

### Lobste.rs

- **Audience**: Invite-only community of serious programmers. Narrower and more technical than HN.
- **Format**: Link submission with tags from a predefined list. No custom tags.
- **What works**: Content that improves programming skills, deepens understanding, or would be interesting in 5-10 years. The provider abstraction pattern and debugging journey fit well.
- **What doesn't**: Startup/business content, entrepreneurship angles, product announcements disguised as blog posts. "News about companies that employ programmers" is explicitly off-topic.
- **Self-promotion**: Must be < 25% of your submissions and comments. Don't just post your own stuff.
- **Tags**: Pick from their predefined list. Likely tags for SAM content: `devops`, `practices`, `go`, `typescript`, `cloud`.
- **Note**: Requires an invite. Build presence by commenting first.

### Dev.to

- **Audience**: Broad developer community. Junior to mid-level skew. Good for tutorials and how-tos.
- **Format**: Markdown blog posts with frontmatter (title, tags, cover image). No length limit. Supports code blocks, embeds, series.
- **Tags**: Up to 4 per post. Popular relevant ones: `opensource`, `devops`, `ai`, `cloudflare`, `selfhosted`.
- **What works**: Step-by-step technical content, "how I built X" posts, debugging stories. Series format for multi-part content.
- **What doesn't**: Short link posts. Content that's purely promotional. Duplicate of your blog with no adaptation.
- **Cross-posting**: Dev.to supports canonical URLs. Cross-post the blog with `canonical_url` set to your original post for SEO.

### Reddit

Different subreddits have very different cultures. Never cross-post the same text.

**r/selfhosted** (~400k members)
- Audience: People running services on their own hardware/cloud
- What works: BYOC angle, self-hosting guide links, comparison with other platforms, "here's my setup" posts
- What doesn't: SaaS pitches, anything that requires a hosted service you control
- Format: Text post or link post. Include a comment explaining what it is and why self-hosters care

**r/devops** (~300k members)
- Audience: DevOps/platform engineers
- What works: Infrastructure abstraction patterns, multi-cloud stories, CI/CD integration
- What doesn't: AI hype, "just use our tool" posts

**r/programming** (~6M members)
- Audience: Broad programming community. Very skeptical of self-promotion
- What works: Technical blog posts about interesting engineering problems. The IP allocation/abstraction story could work
- What doesn't: Product announcements, anything that looks like marketing. Must be genuinely interesting as an engineering story

**r/opensource** (~100k members)
- Audience: Open-source enthusiasts
- What works: Project updates, contribution invitations, technical architecture posts
- What doesn't: Closed-source or freemium pitches

**r/france** (French tech threads)
- Audience: French-speaking community, broad interests
- What works: French-language posts about French tech companies. Personal stories about building from France
- Write in French. Don't just translate English marketing copy

### Product Hunt

- **When**: For major launches only, not regular content. Save for significant milestones.
- **Format**: Product page with tagline, description, screenshots, maker comment
- **What works**: Clear value prop, demo video/GIF, being present all day to answer questions
- **Timing**: Launch at 12:01 AM PT. Be available all day.
- **Note**: Not relevant for this blog post. Save for a proper launch.

### Newsletter (ontech.raphaeltm.com)

- **Audience**: Raph's existing subscribers. Already interested in his perspective.
- **Format**: Beehiiv newsletter. Can be longer and more personal than social posts.
- **What works**: The full blog post or a condensed version with personal commentary. This is where Raph's voice matters most.
- **Cross-reference**: Link to the full blog post. Include 2-3 paragraphs of the personal hook + a "read more" link.

## Content Types

### Blog Posts
Full-length technical content. Follow the style guide. Personal hook required. Code snippets verified against the codebase. Save to `strategy/content/drafts/`.

### Social Media Posts
Generate per-platform variants following the platform guide above. 2-3 variants for headlines/hooks where relevant. Always include in the same draft file as the blog post.

### Changelog / Release Announcements
Generated from git history, PRs, and feature specs. Format: What's New (feature name + why it matters + how it works), Improvements, Fixes.

### Product Launch Copy
Headline options (benefit/problem/curiosity focused), subheadline, hero section, key benefits with proof points, social proof, CTA (primary + secondary), email announcement draft.

### Developer Content (Diataxis Framework)
Identify which type: Tutorial (learning), How-to Guide (task), Explanation (understanding), Reference (information).

## Content Atomization

From one source, produce platform-native pieces (not copies):

Blog post (long-form) → LinkedIn post → Twitter/X thread + single tweet → Bluesky post → Mastodon post → HN submission → Dev.to cross-post → Reddit posts (per-subreddit) → Newsletter excerpt

Each piece is adapted to its platform. A LinkedIn post is not a shortened blog post. A Reddit post is not a LinkedIn post with different formatting.

## Output

Save drafts to `strategy/content/drafts/YYYY-MM-DD-[topic].md`
Save reusable templates to `strategy/content/templates/`

## Quality Standards

- Consistent with style guide voice and tone (no em dashes, no self-deprecation, no marketing-speak)
- Uses approved language (not banned terms from messaging guide)
- Differentiators are evidence-backed
- CTA is clear and channel-appropriate
- Platform-native formatting and tone per the platform guide
- No unverified competitive claims
- Always provide 2-3 variants for headlines, hooks, and CTAs
- Aim for 70-80% ready. Human adds brand taste and final polish
