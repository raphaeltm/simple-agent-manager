import {
  type ArchiveSearchDocument,
  insertArchiveSearchDocumentBatch,
} from '@simple-agent-manager/project-data/internal/do/archive-search-writes';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';

import { projectDataStub } from './helpers/archive-fixtures';

it('rolls back documents with failed FTS and validates repeated identities inside a batch', async () => {
  const stub = projectDataStub(`projection-atomic-${crypto.randomUUID()}`);
  await stub.ensureProjectId('projection-atomic');
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    const document: ArchiveSearchDocument = {
      projectionId: 'raw:projection-atomic:message',
      documentId: 'message',
      role: 'assistant',
      content: 'original searchable payload',
      createdAt: 1000,
    };
    const interrupted = new Proxy(sql, {
      get(target, key) {
        if (key === 'exec')
          return (query: string, ...args: unknown[]) => {
            if (query.includes('INSERT INTO project_data_archive_search_documents_fts'))
              throw new Error('injected reset between documents and FTS');
            return target.exec(query, ...args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const noExisting = () => {
      throw new Error('Unexpected pre-existing identity');
    };
    expect(() =>
      state.storage.transactionSync(() =>
        insertArchiveSearchDocumentBatch(interrupted, 'session', [document], noExisting)
      )
    ).toThrow('injected reset');
    expect(
      sql.exec('SELECT count(*) AS n FROM project_data_archive_search_documents').toArray()[0].n
    ).toBe(0);
    let validated = 0;
    const validate = (incoming: ArchiveSearchDocument) => {
      validated++;
      const row = sql
        .exec(
          'SELECT content FROM project_data_archive_search_documents WHERE projection_id = ?',
          incoming.projectionId
        )
        .toArray()[0];
      if (row?.content !== incoming.content) throw new Error('projection conflict');
    };
    state.storage.transactionSync(() =>
      insertArchiveSearchDocumentBatch(sql, 'session', [document, document], validate)
    );
    expect(validated).toBe(1);
    expect(
      sql
        .exec(
          "SELECT count(*) AS n FROM project_data_archive_search_documents_fts WHERE project_data_archive_search_documents_fts MATCH 'searchable'"
        )
        .toArray()[0].n
    ).toBe(1);
    expect(() =>
      state.storage.transactionSync(() =>
        insertArchiveSearchDocumentBatch(
          sql,
          'session',
          [{ ...document, content: 'conflicting content' }],
          validate
        )
      )
    ).toThrow('projection conflict');
    expect(
      sql
        .exec(
          "SELECT count(*) AS n FROM project_data_archive_search_documents_fts WHERE project_data_archive_search_documents_fts MATCH 'searchable'"
        )
        .toArray()[0].n
    ).toBe(1);
  });
});
