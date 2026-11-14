import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CACHE_DIR } from '../config.ts';

const UPLOADS = resolve(CACHE_DIR, 'codex-uploads');
// Saved conversations retain only their newest attachments to bound disk use.
const UPLOADS_MAX = 200;

export async function saveUpload(threadId: string, name: string, data: string) {
  const dir = join(UPLOADS, threadId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${name}`);
  await writeFile(path, Buffer.from(data, 'base64'));
  const files = (await readdir(dir)).sort();
  for (const name of files.slice(0, Math.max(0, files.length - UPLOADS_MAX))) await rm(join(dir, name), { force: true });
  return path;
}

export const removeUploads = (id: string) => rm(join(UPLOADS, id), { recursive: true, force: true });
