import { DatabaseSync } from 'node:sqlite';

// Bump when what gets indexed changes. user_version is set only after a full scan, so an index of another version,
// or one whose first build never finished, is dropped and rebuilt.
// 2: camelCase parts are indexed too.
export const VERSION = 2;

// files: one row per transcript, its rowid shared with docs. offset: bytes read so far, always at a line break.
// titles: JSON of the title candidates found so far (custom, ai, last, first).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  sid TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '',
  mtime REAL NOT NULL,
  size INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  titles TEXT NOT NULL DEFAULT '{}',
  tag TEXT
);
CREATE INDEX IF NOT EXISTS files_sid ON files(sid);
CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(title, body, tokenize='unicode61 remove_diacritics 2');
`;

export function openIndex(path: string, busyMs: number) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=${busyMs};`);
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (user_version !== VERSION) db.exec('DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS files;');
  db.exec(SCHEMA);
  return db;
}

export const markBuilt = (db: DatabaseSync) => db.exec(`PRAGMA user_version=${VERSION}`);

export type Titles = { custom?: string; ai?: string; last?: string; first?: string };

// A provider of saved conversations (Claude Code today, Codex later). Files are append-only logs.
export type SourceFile = { path: string; sid: string; mtime: number; size: number };
export type Sink = { text(s: string): void; title(kind: keyof Titles, s: string): void; cwd(s: string): void; tag(t: string): void };
export type Source = {
  name: string;
  list(): Promise<SourceFile[]>;
  // Feeds the sink from `offset` to the last complete line and returns the offset after it.
  read(file: SourceFile, offset: number, sink: Sink): Promise<number>;
};

// Same order the SDK's session list uses: custom title, AI title, last prompt, first prompt.
export const titleOf = (t: Titles) => t.custom || t.ai || t.last || t.first || 'Untitled';
