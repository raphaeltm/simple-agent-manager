import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { loadInstantRestoreWorkspace } from '../../../src/services/instant-restore-workspace';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
let sqlite: Database.Database;
let env: Env;
const input = {
  workspaceId: 'workspace-1',
  userId: 'user-1',
  projectId: 'project-1',
  chatSessionId: 'chat-1',
};
beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.users,
    schema.projects,
    schema.workspaces,
    schema.projectGitlabRepositories,
  ]);
  sqlite
    .prepare(
      "INSERT INTO users (id,name,email,github_id) VALUES ('user-1','Developer','developer@example.com',123)"
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO projects (id,user_id,name,normalized_name,installation_id,repository,default_branch) VALUES ('project-1','user-1','Project','project','installation-1','owner/repo','develop')"
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO workspaces (id,user_id,project_id,chat_session_id,name,repository,branch,vm_size,vm_location) VALUES ('workspace-1','user-1','project-1','chat-1','Task workspace','owner/repo','sam/task-change','small','auto')"
    )
    .run();
  env = { DATABASE: createSqliteD1(sqlite) } as Env;
});
afterEach(() => sqlite.close());
describe('canonical cold Instant workspace Git metadata', () => {
  it('uses project default branch independently of task checkout, with owned user Git identity', async () => {
    expect(await loadInstantRestoreWorkspace(env, input)).toEqual({
      workspaceId: 'workspace-1',
      repository: 'owner/repo',
      branch: 'sam/task-change',
      defaultBranch: 'develop',
      baseBranch: 'develop',
      repoProvider: 'github',
      cloneUrl: null,
      repositoryHost: null,
      repositoryPath: null,
      gitUserName: 'Developer',
      gitUserEmail: 'developer@example.com',
      githubId: '123',
    });
  });
  it('retains canonical GitLab repository source and project default branch', async () => {
    sqlite
      .prepare(
        "UPDATE projects SET repo_provider = 'gitlab', repository = 'group/repo' WHERE id = 'project-1'"
      )
      .run();
    sqlite
      .prepare("UPDATE workspaces SET repository = 'group/repo' WHERE id = 'workspace-1'")
      .run();
    sqlite
      .prepare(
        "INSERT INTO project_gitlab_repositories (id,project_id,user_id,host,gitlab_project_id,path_with_namespace,http_url_to_repo,default_branch) VALUES ('gitlab-meta','project-1','user-1','gitlab.example.test',123,'group/repo','https://gitlab.example.test/group/repo.git','stale-metadata-branch')"
      )
      .run();
    expect(await loadInstantRestoreWorkspace(env, input)).toMatchObject({
      repoProvider: 'gitlab',
      repository: 'group/repo',
      cloneUrl: 'https://gitlab.example.test/group/repo.git',
      repositoryHost: 'gitlab.example.test',
      repositoryPath: 'group/repo',
      defaultBranch: 'develop',
      baseBranch: 'develop',
      branch: 'sam/task-change',
    });
  });
  it('fails closed when a GitLab project lacks repository metadata', async () => {
    sqlite.prepare("UPDATE projects SET repo_provider = 'gitlab' WHERE id = 'project-1'").run();
    await expect(loadInstantRestoreWorkspace(env, input)).rejects.toThrow(
      'GitLab repository metadata is missing'
    );
  });
  it.each(['userId', 'projectId', 'chatSessionId', 'workspaceId'] as const)(
    'rejects conflicting %s ownership rather than hydrating another session',
    async (field) => {
      await expect(
        loadInstantRestoreWorkspace(env, { ...input, [field]: 'foreign-identity' })
      ).rejects.toThrow('Git identity unavailable or changed');
    }
  );
  it.each([
    ['missing canonical default', "UPDATE projects SET default_branch = ''"],
    ['missing task checkout', "UPDATE workspaces SET branch = ''"],
    ['changed project repository', "UPDATE projects SET repository = 'different/repo'"],
    ['missing project', 'DELETE FROM projects'],
    ['missing user', 'DELETE FROM users'],
  ])('fails closed for %s', async (_name, mutation) => {
    sqlite.exec(mutation);
    await expect(loadInstantRestoreWorkspace(env, input)).rejects.toThrow(
      'Git identity unavailable or changed'
    );
  });
});
