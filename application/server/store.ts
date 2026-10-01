import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface Entity {
  id: string;
  owner: string;
  [key: string]: unknown;
}
export const newID = () => randomBytes(16).toString('hex');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();

/** Single-process control plane with durable metadata and encrypted credentials. */
export class Store {
  readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly lock: string;
  private closed = false;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.lock = path.join(root, 'workbench.lock');
    if (existsSync(this.lock)) {
      const pid = Number(readFileSync(this.lock, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error(`Data directory is already owned by process ${pid}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error;
          }
        }
      }
      unlinkSync(this.lock);
    }
    const descriptor = openSync(this.lock, 'wx', 0o600);
    writeFileSync(descriptor, String(process.pid));
    closeSync(descriptor);
    try {
      const keyFile = path.join(root, 'credentials.key');
      if (!existsSync(keyFile)) {
        writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
      }
      this.key = readFileSync(keyFile);
      if (this.key.length !== 32) {
        throw new Error('Credential encryption key must contain 32 bytes');
      }
      this.db = new DatabaseSync(path.join(root, 'workbench.db'));
      this.db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS objects (kind TEXT, id TEXT, owner TEXT, data TEXT NOT NULL, PRIMARY KEY(kind,id));
        CREATE TABLE IF NOT EXISTS credentials (owner TEXT PRIMARY KEY, token BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS objects_owner ON objects(kind,owner);
        CREATE UNIQUE INDEX IF NOT EXISTS workspace_branch ON objects(owner,json_extract(data,'$.projectId'),json_extract(data,'$.branch'))
          WHERE kind='workspace' AND coalesce(json_extract(data,'$.archived'),0)=0;
        CREATE UNIQUE INDEX IF NOT EXISTS personal_machine ON objects(owner) WHERE kind='machine';
      `);
    } catch (error) {
      unlinkSync(this.lock);
      throw error;
    }
  }

  put<T extends Entity>(kind: string, value: T): T {
    this.db
      .prepare(
        'INSERT INTO objects(kind,id,owner,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET owner=excluded.owner,data=excluded.data',
      )
      .run(kind, value.id, value.owner, JSON.stringify(value));
    return value;
  }

  get<T extends Entity = Entity>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT owner,data FROM objects WHERE kind=? AND id=?').get(kind, id);
    if (!row) {
      return undefined;
    }
    return { ...JSON.parse(String(row.data)), owner: String(row.owner) } as T;
  }

  list<T extends Entity = Entity>(kind: string, owner?: string): T[] {
    const rows =
      owner === undefined
        ? this.db.prepare('SELECT owner,data FROM objects WHERE kind=?').all(kind)
        : this.db.prepare('SELECT owner,data FROM objects WHERE kind=? AND owner=?').all(kind, owner);
    return rows.map((row) => ({ ...JSON.parse(String(row.data)), owner: String(row.owner) }) as T);
  }

  delete(kind: string, id: string): void {
    this.db.prepare('DELETE FROM objects WHERE kind=? AND id=?').run(kind, id);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  secret(id: string, value?: unknown): unknown {
    if (value !== undefined) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
      const payload = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      this.db
        .prepare(
          'INSERT INTO credentials(owner,token) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET token=excluded.token',
        )
        .run(id, Buffer.concat([nonce, cipher.getAuthTag(), payload]));
      return value;
    }
    const row = this.db.prepare('SELECT token FROM credentials WHERE owner=?').get(id);
    if (!row) {
      return undefined;
    }
    const payload = Buffer.from(row.token as Uint8Array);
    const cipher = createDecipheriv('aes-256-gcm', this.key, payload.subarray(0, 12));
    cipher.setAuthTag(payload.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(payload.subarray(28)), cipher.final()]).toString());
  }

  createSession(owner: string): string {
    const token = randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    this.db
      .prepare('INSERT INTO sessions(hash,owner,expires) VALUES(?,?,?)')
      .run(hash(token), owner, Date.now() + 24 * 60 * 60 * 1000);
    return token;
  }
  session(token: string): string | undefined {
    const row = this.db.prepare('SELECT owner FROM sessions WHERE hash=? AND expires>?').get(hash(token), Date.now());
    return row ? String(row.owner) : undefined;
  }
  revoke(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
    unlinkSync(this.lock);
  }
}

export function publicEntity<T extends Entity>(value: T): Omit<T, 'owner'> {
  const { owner, ...rest } = value;
  return rest;
}
