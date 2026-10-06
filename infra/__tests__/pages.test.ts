import { beforeAll, describe, expect, it } from 'vitest';
import { findRegisteredResource, getOutputValue } from './setup';

describe('Pages Resources', () => {
  let pagesModule: typeof import('../resources/pages');
  let configModule: typeof import('../resources/config');

  beforeAll(async () => {
    pagesModule = await import('../resources/pages');
    configModule = await import('../resources/config');
  });

  it('registers the Pages project with stable naming and configured default branch', () => {
    const project = findRegisteredResource(
      `${configModule.prefix}-pages-project`,
      'cloudflare:index/pagesProject:PagesProject'
    );

    expect(project.inputs).toMatchObject({
      accountId: 'test-account-id-00000000000000000000',
      name: `${configModule.prefix}-web-${configModule.stack}`,
      productionBranch: configModule.DEFAULT_PAGES_PRODUCTION_BRANCH,
    });
  });

  it('registers the app custom domain from the required base domain', async () => {
    const domain = findRegisteredResource(
      `${configModule.prefix}-pages-domain`,
      'cloudflare:index/pagesDomain:PagesDomain'
    );

    await expect(
      getOutputValue(domain.inputs.projectName as typeof pagesModule.pagesProject.name)
    ).resolves.toBe(`${configModule.prefix}-web-${configModule.stack}`);
    expect(domain.inputs).toMatchObject({
      accountId: 'test-account-id-00000000000000000000',
      name: 'app.example.com',
    });
  });

  it('exports the Pages project name consumed by deployment scripts', async () => {
    await expect(getOutputValue(pagesModule.pagesProjectName)).resolves.toBe(
      `${configModule.prefix}-web-${configModule.stack}`
    );
  });
});
