import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CACHE_DIR } from '../config.ts';
import { CodexClient } from '../codex/client.ts';
import { TEXT_ONLY_CONFIG } from '../codex/helper.ts';
import { attachClient } from '../codex/threads.ts';
import type { ModelListResponse } from '../codex/types.ts';
import { tuning } from '../profile.ts';
import type { BoardModel } from './api.ts';

// The board's own `codex app-server`: a separate CODEX_HOME holding only a minimal config.toml and a symlink to
// the main sign-in, so jobs never see ~/.codex/AGENTS.md, skills, plugins, MCP servers or the owner's config.

const ROOT = join(CACHE_DIR, 'board-codex');
export const BOARD_HOME = join(ROOT, 'home');
// An empty folder as cwd, so no project instructions or files come along.
export const BOARD_CWD = join(ROOT, 'work');
const MAIN_AUTH = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
const MODELS_TTL = 30 * 60_000;
const MODEL_PAGES = 5;

// Everything here is also what `codex debug prompt-input` reads when run with CODEX_HOME=BOARD_HOME.
type Toml = string | number | boolean | { [k: string]: Toml };
const CONFIG: Record<string, Toml> = {
  cli_auth_credentials_store: 'file',
  check_for_update_on_startup: false,
  'history.persistence': 'none',
  ...TEXT_ONLY_CONFIG,
  // A plain false still sends ~600 tokens of multi-agent role text; empty hint texts drop it (0.155.1).
  'features.multi_agent_v2': { enabled: false, usage_hint_enabled: false, root_agent_usage_hint_text: '', multi_agent_mode_hint_text: '' },
  'skills.include_instructions': false,
  project_doc_max_bytes: 0,
  include_permissions_instructions: false,
  include_environment_context: false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false,
  include_apps_usage_instructions: false,
};
const tomlValue = (v: Toml): string => typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${k} = ${tomlValue(x)}`).join(', ')} }` : JSON.stringify(v);
const TOML = `# Written by tarcsweb for board jobs; rewritten whenever it differs.\n${Object.entries(CONFIG).map(([k, v]) => `${k} = ${tomlValue(v)}`).join('\n')}\n`;

// A link, never a copy, so both app-servers share one sign-in and one set of refreshed tokens.
// Another tarcsweb server may share this home, so both files are swapped in with a rename and never half-written.
async function linkAuth() {
  const at = join(BOARD_HOME, 'auth.json');
  const st = await lstat(at).catch(() => null);
  if (st?.isSymbolicLink() && (await readlink(at)) === MAIN_AUTH) return;
  if (st && !st.isSymbolicLink()) console.warn('[board] the board Codex auth.json was a plain file; linking it to the main sign-in again');
  const tmp = `${at}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  await symlink(MAIN_AUTH, tmp);
  await rename(tmp, at);
}

async function writeConfig() {
  const file = join(BOARD_HOME, 'config.toml');
  if ((await readFile(file, 'utf8').catch(() => null)) === TOML) return;
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, TOML, { mode: 0o600 });
  await rename(tmp, file);
}

async function prepare() {
  await mkdir(BOARD_HOME, { recursive: true, mode: 0o700 });
  await mkdir(BOARD_CWD, { recursive: true });
  await writeConfig();
  await linkAuth();
}

// One process at most; it starts on the first model list or job and stops after tuning().boardCodexIdleMs.
export const boardCodex = new CodexClient({
  label: 'board',
  env: () => ({ ...process.env, CODEX_HOME: BOARD_HOME }),
  cwd: () => BOARD_CWD,
  idleMs: () => tuning().boardCodexIdleMs,
  prepare,
});
attachClient(boardCodex);

export async function boardSignedIn() {
  const { account } = await boardCodex.request('account/read', {});
  return !!account;
}

let catalog: { at: number; models: BoardModel[] } | null = null;
let loading: Promise<BoardModel[]> | null = null;

// Models of the signed-in subscription that take image input, as the board app-server lists them.
export function boardModels(): Promise<BoardModel[]> {
  if (catalog && Date.now() - catalog.at < MODELS_TTL) return Promise.resolve(catalog.models);
  loading ??= (async () => {
    const out: BoardModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MODEL_PAGES; page++) {
      // peek: a list that boots the process lets it go after a short idle.
      const r: ModelListResponse = await boardCodex.peek('model/list', { cursor, limit: 100 });
      for (const m of r.data) {
        if (m.hidden || !m.inputModalities.includes('image')) continue;
        const tiers = ((m as { serviceTiers?: { id?: unknown }[] }).serviceTiers ?? []).map((t) => String(t.id));
        out.push({
          id: m.id, name: m.displayName, description: m.description, isDefault: m.isDefault,
          efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort, tiers, provider: 'codex',
        });
      }
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    catalog = { at: Date.now(), models: out };
    return out;
  })().finally(() => (loading = null));
  return loading;
}
