import { LIBRARY_DEFAULTS, type ProjectFile, type ProjectFileTag } from '@simple-agent-manager/shared';
import { queryOptions } from '@tanstack/react-query';

import { listLibraryFiles } from '../api/library';
import { QUERY_PERSIST_MAX_AGE_MS } from '../query-persist-config';

export type LibraryIndexFile = ProjectFile & { tags: ProjectFileTag[] };

export interface LibraryIndexQueryData {
  files: LibraryIndexFile[];
  fileCount: number;
  status: 'ready' | 'overCap';
}

export interface LibraryIndexQueryConfig {
  cap: number;
  maxSweepPages: number;
  namespace?: string | null;
}

export const libraryQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'library'] as const,
  index: (
    queryScope: string,
    projectId: string,
    config: Pick<LibraryIndexQueryConfig, 'cap' | 'maxSweepPages' | 'namespace'>
  ) =>
    [
      ...libraryQueryKeys.all(queryScope),
      'index',
      projectId,
      {
        cap: config.cap,
        maxSweepPages: config.maxSweepPages,
        namespace: config.namespace ?? null,
      },
    ] as const,
};

function stripPreview(file: LibraryIndexFile): LibraryIndexFile {
  return { ...file, extractedTextPreview: null };
}

async function sweepLibraryIndex(
  projectId: string,
  config: Pick<LibraryIndexQueryConfig, 'cap' | 'maxSweepPages'>
): Promise<LibraryIndexQueryData> {
  const accumulated: LibraryIndexFile[] = [];
  let cursor: string | undefined;
  let pages = 0;

  for (;;) {
    const resp = await listLibraryFiles(projectId, {
      directory: '/',
      recursive: true,
      sortBy: 'createdAt',
      sortOrder: 'asc',
      limit: LIBRARY_DEFAULTS.LIST_MAX_PAGE_SIZE,
      cursor,
    });

    if (resp.total >= config.cap) {
      return {
        files: [],
        fileCount: resp.total,
        status: 'overCap',
      };
    }

    for (const file of resp.files as LibraryIndexFile[]) {
      accumulated.push(stripPreview(file));
    }
    pages += 1;

    if (resp.cursor === null || pages >= config.maxSweepPages) break;
    cursor = resp.cursor;
  }

  return {
    files: accumulated,
    fileCount: accumulated.length,
    status: 'ready',
  };
}

export function libraryIndexQueryOptions(
  queryScope: string,
  projectId: string,
  config: LibraryIndexQueryConfig
) {
  return queryOptions({
    queryKey: libraryQueryKeys.index(queryScope, projectId, config),
    queryFn: () => sweepLibraryIndex(projectId, config),
    gcTime: QUERY_PERSIST_MAX_AGE_MS,
  });
}
