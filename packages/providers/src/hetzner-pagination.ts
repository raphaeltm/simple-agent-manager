import {
  buildHetznerListUrl,
  DEFAULT_HETZNER_MAX_LIST_PAGES,
  recordHetznerListPage,
} from './hetzner-metadata';
import { providerFetch, throwIfProviderRequestAborted } from './provider-fetch';
import type { ProviderRequestContext } from './types';
import { ProviderError } from './types';
import { parseProviderJson } from './validation';

type HetznerListOperation = 'listVMs' | 'listVolumes' | 'listInstanceOfferings';
type HetznerListResource = 'servers' | 'volumes' | 'server_types';

interface FetchPaginatedHetznerListOptions {
  apiToken: string;
  resource: HetznerListResource;
  baseParams: URLSearchParams;
  operation: HetznerListOperation;
  handlePage: (payload: unknown) => number | undefined;
  labelParts: string[];
  context?: ProviderRequestContext;
}

export async function fetchPaginatedHetznerList(
  options: FetchPaginatedHetznerListOptions
): Promise<void> {
  throwIfProviderRequestAborted(options.context);
  const seenPages = new Set<number>();
  let page = 1;

  for (let pageCount = 0; pageCount < DEFAULT_HETZNER_MAX_LIST_PAGES; pageCount += 1) {
    throwIfProviderRequestAborted(options.context);
    recordHetznerListPage(seenPages, page, options.operation);

    const url = buildHetznerListUrl(
      options.resource,
      options.baseParams,
      options.labelParts,
      page
    );
    const response = await providerFetch(
      'hetzner',
      url,
      {
        headers: {
          Authorization: `Bearer ${options.apiToken}`,
        },
      },
      undefined,
      undefined,
      options.context
    );

    throwIfProviderRequestAborted(options.context);
    const payload = await parseProviderJson(response, 'hetzner', options.operation);
    throwIfProviderRequestAborted(options.context);
    const nextPage = options.handlePage(payload);
    if (nextPage === undefined) return;
    page = nextPage;
  }

  throw new ProviderError(
    'hetzner',
    undefined,
    `Hetzner ${options.operation} exceeded ${DEFAULT_HETZNER_MAX_LIST_PAGES} pages`,
    {
      category: 'invalid_config',
    }
  );
}
