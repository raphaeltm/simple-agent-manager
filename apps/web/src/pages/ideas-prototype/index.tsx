/**
 * Ideas redesign prototype — PROTOTYPE ONLY, never merge to main.
 *
 * Mounted inside the real project shell at /projects/:id/ideas/prototype?scene=… so screenshots
 * compare like with like against today's Ideas pages. Mock data only: no API calls, no auth
 * reads. Scenes tell one idea's story; see mock-data.ts.
 */
import { useSearchParams } from 'react-router';

import { IdeaPageScene } from './IdeaPageScene';
import { IdeasListScene } from './IdeasListScene';
import { LIST_EMPTY, LIST_MERGED, LIST_START, LIST_STRESS, STORY_IDEA } from './mock-data';

export function IdeasPrototype() {
  const [params] = useSearchParams();
  switch (params.get('scene')) {
    case 'list-merged':
      return <IdeasListScene scene={LIST_MERGED} />;
    case 'list-stress':
      return <IdeasListScene scene={LIST_STRESS} />;
    case 'list-empty':
      return <IdeasListScene scene={LIST_EMPTY} />;
    case 'idea':
      return <IdeaPageScene data={STORY_IDEA['not-started']} />;
    case 'start':
      return <IdeaPageScene data={STORY_IDEA['not-started']} sheet="work" />;
    case 'start-chat':
      return <IdeaPageScene data={STORY_IDEA['not-started']} sheet="chat" />;
    case 'idea-working':
      return <IdeaPageScene data={STORY_IDEA.working} />;
    case 'idea-review':
      return <IdeaPageScene data={STORY_IDEA.review} />;
    case 'idea-done':
      return <IdeaPageScene data={STORY_IDEA.done} />;
    default:
      return <IdeasListScene scene={LIST_START} />;
  }
}
