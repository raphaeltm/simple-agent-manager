import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { ulid } from 'ulid';
import * as schema from '../db/schema';

type DB = ReturnType<typeof drizzle>;

export interface UIStandardRecord {
  id: string;
  version: string;
  status: string;
  name: string;
  visualDirection: string;
  mobileFirstRulesRef: string;
  accessibilityRulesRef: string;
  ownerRole: string;
  createdAt: string;
  updatedAt: string;
}

export interface UIStandardUpsert {
  status: string;
  name: string;
  visualDirection: string;
  mobileFirstRulesRef: string;
  accessibilityRulesRef: string;
  ownerRole: string;
}

export interface ThemeTokenUpsertInput {
  tokenNamespace: string;
  tokenName: string;
  tokenValue: string;
  mode: string;
  isDeprecated?: boolean;
  replacementToken?: string;
}

export interface ComponentDefinitionCreateInput {
  standardId: string;
  name: string;
  category: string;
  supportedSurfaces: string[];
  requiredStates: string[];
  usageGuidance: string;
  accessibilityNotes: string;
  mobileBehavior: string;
  desktopBehavior: string;
  status: string;
}

export interface ComponentDefinitionUpdateInput {
  supportedSurfaces?: string[];
  requiredStates?: string[];
  usageGuidance?: string;
  accessibilityNotes?: string;
  mobileBehavior?: string;
  desktopBehavior?: string;
  status?: string;
}

export interface ComplianceRunCreateInput {
  standardId: string;
  checklistVersion: string;
  authorType: 'human' | 'agent';
  changeRef: string;
}

export interface ExceptionRequestCreateInput {
  standardId: string;
  requestedBy: string;
  rationale: string;
  scope: string;
  expirationDate: string;
}

export interface MigrationWorkItemCreateInput {
  standardId: string;
  surface: 'control-plane' | 'agent-ui';
  targetRef: string;
  priority: 'high' | 'medium' | 'low';
  status: 'backlog' | 'planned' | 'in-progress' | 'completed' | 'verified';
  owner: string;
  dueMilestone?: string;
  notes?: string;
}

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function serializeJsonStringArray(value: string[]): string {
  return JSON.stringify(value ?? []);
}

function toComponentDefinition(row: typeof schema.componentDefinitions.$inferSelect) {
  return {
    ...row,
    supportedSurfaces: parseJsonStringArray(row.supportedSurfacesJson),
    requiredStates: parseJsonStringArray(row.requiredStatesJson),
  };
}

export function createUiGovernanceService(database: D1Database) {
  const db = drizzle(database, { schema });
  return new UiGovernanceService(db);
}

export class UiGovernanceService {
  constructor(private readonly db: DB) {}

  async getActiveStandard(): Promise<UIStandardRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.uiStandards)
      .where(eq(schema.uiStandards.status, 'active'))
      .orderBy(desc(schema.uiStandards.updatedAt))
      .limit(1);

    return rows[0] ?? null;
  }

  async upsertStandardVersion(version: string, input: UIStandardUpsert): Promise<UIStandardRecord> {
    const existing = await this.db
      .select()
      .from(schema.uiStandards)
      .where(eq(schema.uiStandards.version, version))
      .limit(1);

    const now = new Date().toISOString();
    const found = existing[0];
    if (found) {
      const updated = await this.db
        .update(schema.uiStandards)
        .set({
          status: input.status,
          name: input.name,
          visualDirection: input.visualDirection,
          mobileFirstRulesRef: input.mobileFirstRulesRef,
          accessibilityRulesRef: input.accessibilityRulesRef,
          ownerRole: input.ownerRole,
          updatedAt: now,
        })
        .where(eq(schema.uiStandards.id, found.id))
        .returning();
      return updated[0]!;
    }

    const inserted = await this.db
      .insert(schema.uiStandards)
      .values({
        id: ulid(),
        version,
        status: input.status,
        name: input.name,
        visualDirection: input.visualDirection,
        mobileFirstRulesRef: input.mobileFirstRulesRef,
        accessibilityRulesRef: input.accessibilityRulesRef,
        ownerRole: input.ownerRole,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return inserted[0]!;
  }

  async listThemeTokens(standardId: string) {
    return this.db
      .select()
      .from(schema.themeTokens)
      .where(eq(schema.themeTokens.standardId, standardId))
      .orderBy(schema.themeTokens.tokenNamespace, schema.themeTokens.tokenName);
  }

  async upsertThemeTokens(standardId: string, tokens: ThemeTokenUpsertInput[]) {
    const now = new Date().toISOString();
    const inserted = [];
    for (const token of tokens) {
      const existing = await this.db
        .select()
        .from(schema.themeTokens)
        .where(
          and(
            eq(schema.themeTokens.standardId, standardId),
            eq(schema.themeTokens.tokenNamespace, token.tokenNamespace),
            eq(schema.themeTokens.tokenName, token.tokenName),
            eq(schema.themeTokens.mode, token.mode)
          )
        )
        .limit(1);

      const found = existing[0];
      if (found) {
        const updated = await this.db
          .update(schema.themeTokens)
          .set({
            tokenValue: token.tokenValue,
            isDeprecated: token.isDeprecated ?? false,
            replacementToken: token.replacementToken ?? null,
          })
          .where(eq(schema.themeTokens.id, found.id))
          .returning();
        inserted.push(updated[0]!);
      } else {
        const created = await this.db
          .insert(schema.themeTokens)
          .values({
            id: ulid(),
            standardId,
            tokenNamespace: token.tokenNamespace,
            tokenName: token.tokenName,
            tokenValue: token.tokenValue,
            mode: token.mode,
            isDeprecated: token.isDeprecated ?? false,
            replacementToken: token.replacementToken ?? null,
            createdAt: now,
          })
          .returning();
        inserted.push(created[0]!);
      }
    }
    return inserted;
  }

  async listComponentDefinitions(surface?: string, status?: string) {
    const rows = await this.db.select().from(schema.componentDefinitions);

    return rows
      .map(toComponentDefinition)
      .filter((item) => (surface ? item.supportedSurfaces.includes(surface) : true))
      .filter((item) => (status ? item.status === status : true));
  }

  async createComponentDefinition(input: ComponentDefinitionCreateInput) {
    const now = new Date().toISOString();
    const inserted = await this.db
      .insert(schema.componentDefinitions)
      .values({
        id: ulid(),
        standardId: input.standardId,
        name: input.name,
        category: input.category,
        supportedSurfacesJson: serializeJsonStringArray(input.supportedSurfaces),
        requiredStatesJson: serializeJsonStringArray(input.requiredStates),
        usageGuidance: input.usageGuidance,
        accessibilityNotes: input.accessibilityNotes,
        mobileBehavior: input.mobileBehavior,
        desktopBehavior: input.desktopBehavior,
        status: input.status,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return toComponentDefinition(inserted[0]!);
  }

  async getComponentDefinition(componentId: string) {
    const rows = await this.db
      .select()
      .from(schema.componentDefinitions)
      .where(eq(schema.componentDefinitions.id, componentId))
      .limit(1);

    const row = rows[0];
    return row ? toComponentDefinition(row) : null;
  }

  async updateComponentDefinition(componentId: string, input: ComponentDefinitionUpdateInput) {
    const existing = await this.getComponentDefinition(componentId);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    const updated = await this.db
      .update(schema.componentDefinitions)
      .set({
        supportedSurfacesJson: input.supportedSurfaces
          ? serializeJsonStringArray(input.supportedSurfaces)
          : existing.supportedSurfacesJson,
        requiredStatesJson: input.requiredStates
          ? serializeJsonStringArray(input.requiredStates)
          : existing.requiredStatesJson,
        usageGuidance: input.usageGuidance ?? existing.usageGuidance,
        accessibilityNotes: input.accessibilityNotes ?? existing.accessibilityNotes,
        mobileBehavior: input.mobileBehavior ?? existing.mobileBehavior,
        desktopBehavior: input.desktopBehavior ?? existing.desktopBehavior,
        status: input.status ?? existing.status,
        updatedAt: now,
      })
      .where(eq(schema.componentDefinitions.id, componentId))
      .returning();

    return toComponentDefinition(updated[0]!);
  }

  async createComplianceRun(input: ComplianceRunCreateInput) {
    const inserted = await this.db
      .insert(schema.complianceRuns)
      .values({
        id: ulid(),
        standardId: input.standardId,
        checklistVersion: input.checklistVersion,
        authorType: input.authorType,
        changeRef: input.changeRef,
        status: 'queued',
        createdAt: new Date().toISOString(),
      })
      .returning();

    return inserted[0]!;
  }

  async getComplianceRun(runId: string) {
    const runs = await this.db
      .select()
      .from(schema.complianceRuns)
      .where(eq(schema.complianceRuns.id, runId))
      .limit(1);

    return runs[0] ?? null;
  }

  async createExceptionRequest(input: ExceptionRequestCreateInput) {
    const now = new Date().toISOString();
    const inserted = await this.db
      .insert(schema.exceptionRequests)
      .values({
        id: ulid(),
        standardId: input.standardId,
        requestedBy: input.requestedBy,
        rationale: input.rationale,
        scope: input.scope,
        expirationDate: input.expirationDate,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return inserted[0]!;
  }

  async createMigrationWorkItem(input: MigrationWorkItemCreateInput) {
    const now = new Date().toISOString();
    const inserted = await this.db
      .insert(schema.migrationWorkItems)
      .values({
        id: ulid(),
        standardId: input.standardId,
        surface: input.surface,
        targetRef: input.targetRef,
        priority: input.priority,
        status: input.status,
        owner: input.owner,
        dueMilestone: input.dueMilestone ?? null,
        notes: input.notes ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return inserted[0]!;
  }

  async updateMigrationWorkItem(
    itemId: string,
    updates: {
      status: 'backlog' | 'planned' | 'in-progress' | 'completed' | 'verified';
      owner?: string;
      notes?: string;
    }
  ) {
    const updatePayload: {
      status: 'backlog' | 'planned' | 'in-progress' | 'completed' | 'verified';
      updatedAt: string;
      owner?: string;
      notes?: string;
    } = {
      status: updates.status,
      updatedAt: new Date().toISOString(),
    };
    if (updates.owner !== undefined) {
      updatePayload.owner = updates.owner;
    }
    if (updates.notes !== undefined) {
      updatePayload.notes = updates.notes;
    }

    const rows = await this.db
      .update(schema.migrationWorkItems)
      .set(updatePayload)
      .where(eq(schema.migrationWorkItems.id, itemId))
      .returning();

    return rows[0] ?? null;
  }

  async getActiveAgentInstructions() {
    const rows = await this.db
      .select()
      .from(schema.agentInstructionSets)
      .where(eq(schema.agentInstructionSets.isActive, true))
      .orderBy(desc(schema.agentInstructionSets.updatedAt))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      ...row,
      instructionBlocks: parseJsonStringArray(row.instructionBlocksJson),
    };
  }

  async createChecklist(
    standardId: string,
    version: string,
    items: string[],
    appliesTo: string[],
    isActive: boolean
  ) {
    const inserted = await this.db
      .insert(schema.complianceChecklists)
      .values({
        id: ulid(),
        standardId,
        version,
        itemsJson: serializeJsonStringArray(items),
        appliesToJson: serializeJsonStringArray(appliesTo),
        isActive,
        publishedAt: new Date().toISOString(),
      })
      .returning();

    return inserted[0]!;
  }

  async getChecklist(standardId: string, version: string) {
    const rows = await this.db
      .select()
      .from(schema.complianceChecklists)
      .where(
        and(
          eq(schema.complianceChecklists.standardId, standardId),
          eq(schema.complianceChecklists.version, version)
        )
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      ...row,
      items: parseJsonStringArray(row.itemsJson),
      appliesTo: parseJsonStringArray(row.appliesToJson),
    };
  }
}
