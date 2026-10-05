import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import {
  openDatabase,
  setDatabaseForTests,
  type SqliteDatabase,
} from '../lib/db';

export function createTemporaryDatabase(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-sqlite-test-'));
  const filePath = path.join(directory, 'clipcraft.db');
  const connections: SqliteDatabase[] = [];
  const db = openDatabase(filePath);
  connections.push(db);
  setDatabaseForTests(db);

  t.after(() => {
    setDatabaseForTests(null);
    for (const connection of connections) {
      if (connection.open) connection.close();
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  return {
    db,
    filePath,
    openConnection(): SqliteDatabase {
      const connection = openDatabase(filePath);
      connections.push(connection);
      return connection;
    },
  };
}
