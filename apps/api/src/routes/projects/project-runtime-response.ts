import type { ProjectRuntimeConfigResponse } from '@simple-agent-manager/shared';
import { eq, sql } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';

export async function buildProjectRuntimeConfigResponse(
  db: ReturnType<typeof drizzle<typeof schema>>,
  project: schema.Project
): Promise<ProjectRuntimeConfigResponse> {
  const [envRows, fileRows] = await Promise.all([
    db
      .select({
        envKey: schema.projectRuntimeEnvVars.envKey,
        storedValue: sql<
          string | null
        >`CASE WHEN ${schema.projectRuntimeEnvVars.isSecret} THEN NULL ELSE ${schema.projectRuntimeEnvVars.storedValue} END`,
        isSecret: schema.projectRuntimeEnvVars.isSecret,
        createdAt: schema.projectRuntimeEnvVars.createdAt,
        updatedAt: schema.projectRuntimeEnvVars.updatedAt,
      })
      .from(schema.projectRuntimeEnvVars)
      .where(eq(schema.projectRuntimeEnvVars.projectId, project.id))
      .orderBy(schema.projectRuntimeEnvVars.envKey),
    db
      .select({
        filePath: schema.projectRuntimeFiles.filePath,
        storedContent: sql<
          string | null
        >`CASE WHEN ${schema.projectRuntimeFiles.isSecret} THEN NULL ELSE ${schema.projectRuntimeFiles.storedContent} END`,
        isSecret: schema.projectRuntimeFiles.isSecret,
        createdAt: schema.projectRuntimeFiles.createdAt,
        updatedAt: schema.projectRuntimeFiles.updatedAt,
      })
      .from(schema.projectRuntimeFiles)
      .where(eq(schema.projectRuntimeFiles.projectId, project.id))
      .orderBy(schema.projectRuntimeFiles.filePath),
  ]);

  const envVars: ProjectRuntimeConfigResponse['envVars'] = [];
  for (const row of envRows) {
    let value: string | null = row.storedValue;
    if (row.isSecret) {
      value = null;
    }
    envVars.push({
      key: row.envKey,
      value,
      isSecret: row.isSecret,
      hasValue: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  const files: ProjectRuntimeConfigResponse['files'] = [];
  for (const row of fileRows) {
    let content: string | null = row.storedContent;
    if (row.isSecret) {
      content = null;
    }
    files.push({
      path: row.filePath,
      content,
      isSecret: row.isSecret,
      hasValue: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  return { envVars, files };
}
