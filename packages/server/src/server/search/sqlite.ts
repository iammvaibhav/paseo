/**
 * node:sqlite is present on Node 22 / Electron 41 (the daemon runtime) but
 * @types/node@20 has no typings. Keep the import behind a string so TypeScript
 * does not try to resolve the module, and treat a missing runtime as "search
 * stays metadata-only".
 */

export interface SqliteStatement {
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

export async function tryLoadNodeSqlite(): Promise<NodeSqliteModule | null> {
  const sqliteSpecifier: string = "node:sqlite";
  try {
    return (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
  } catch {
    return null;
  }
}
