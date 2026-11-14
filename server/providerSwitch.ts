import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CACHE_DIR } from './config.ts';
import { oneLine } from './text.ts';
import { fullText } from './stretch.ts';
import { LIVE_SERVER, tmpName } from './workspace.ts';
import { CODEX_EFFORTS, type Effort, type Provider, type ProviderSide, type TimedEvent } from './protocol.ts';

const provider = z.enum(['claude', 'codex']);
const savedId = z.string().min(1).max(200);
const model = z.string().min(1).max(100);
const effort = z.enum(CODEX_EFFORTS as [Effort, ...Effort[]]);
// One provider's part of a conversation that changed provider: its saved conversation (null until one exists), its
// model and effort, and for the provider that is away, when it last saw the conversation (null: it has not taken part yet).
export const side = z.object({ id: savedId.nullable(), model, effort, speed: z.enum(['standard', 'fast']).optional(), seenAt: z.number().nullable() });
export type Side = z.infer<typeof side>;
// owed: the active provider has not received its replay yet (since null: the whole conversation).
// key: the random id its replay blocks carry, so its history can tell them from user text.
// tab: the tab's own id, the only key a tab has between a switch and its first message on the new side.
export const sides = z.object({
  active: provider, claude: side.optional(), codex: side.optional(), owed: z.object({ since: z.number().nullable() }).optional(), key: z.string().min(1).max(100).optional(),
  tab: savedId.optional(),
});
export type SidesRecord = z.infer<typeof sides>;

export const otherProvider = (p: Provider): Provider => (p === 'claude' ? 'codex' : 'claude');
export const when = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [cut, ${text.length - max} more characters]` : text);

// Tabs that changed provider in place, so reopening one shows both conversations and can switch back. Newest last.
const LINKS_FILE = join(CACHE_DIR, 'provider-switches.json');
const LINKS_MAX = 500;
const linkList = z.array(sides);

class SwitchLinks {
  private list: SidesRecord[] = [];
  private write: Promise<void> = Promise.resolve();

  constructor() {
    // Test servers on spare ports share the cache dir, so only the live server reads or writes it.
    if (!LIVE_SERVER) return;
    try {
      this.list = linkList.parse(JSON.parse(readFileSync(LINKS_FILE, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.log('provider switch: unreadable links file; starting empty');
    }
  }

  // The record naming this saved conversation, on either side, or this tab.
  find(id: string | null | undefined) {
    return id ? this.list.findLast((r) => r.claude?.id === id || r.codex?.id === id || r.tab === id) ?? null : null;
  }

  // ids: every saved id the tab had, so the old record is replaced rather than duplicated.
  put(r: SidesRecord, ids: (string | null | undefined)[]) {
    const known = new Set([...ids, r.claude?.id, r.codex?.id, r.tab].filter((x): x is string => !!x));
    const names = (x: SidesRecord) => [x.claude?.id, x.codex?.id, x.tab].some((v) => !!v && known.has(v));
    const i = this.list.findIndex(names);
    if (i >= 0 && JSON.stringify(this.list[i]) === JSON.stringify(r)) return;
    if (i >= 0) this.list.splice(i, 1);
    this.list.push(r);
    if (this.list.length > LINKS_MAX) this.list.splice(0, this.list.length - LINKS_MAX);
    this.save();
  }

  // A deleted conversation: its records go, so the other side lists on its own again. Returns what was dropped.
  forget(ids: (string | null | undefined)[]) {
    const gone = new Set(ids.filter((x): x is string => !!x));
    const dropped = this.list.filter((x) => [x.claude?.id, x.codex?.id, x.tab].some((v) => !!v && gone.has(v)));
    if (!dropped.length) return [];
    this.list = this.list.filter((x) => !dropped.includes(x));
    this.save();
    return dropped;
  }

  // Saved ids that show through their active side instead, once that side has a conversation of its own.
  awayIds() {
    return new Set(this.list.flatMap((r) => (r[r.active]?.id ? r[otherProvider(r.active)]?.id ?? [] : [])));
  }

  private save() {
    if (!LIVE_SERVER) return;
    const data = JSON.stringify(this.list);
    this.write = this.write.then(async () => {
      const tmp = tmpName(LINKS_FILE);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, LINKS_FILE);
    }).catch((err) => console.log(`provider switch: saving links failed (${(err as Error).message})`));
  }
}

export const switchLinks = new SwitchLinks();

// Two lists, each oldest first, as one by time; an event with no time stays right behind the one before it.
export function mergeTimed(events: TimedEvent[], others: TimedEvent[]): TimedEvent[] {
  if (!others.length) return events;
  const out: TimedEvent[] = [];
  let k = 0;
  let last = -Infinity;
  for (const e of events) {
    if (e.at !== undefined) {
      while (k < others.length && (others[k].at ?? last) <= e.at) {
        last = others[k].at ?? last;
        out.push(others[k++]);
      }
    }
    out.push(e);
  }
  return [...out, ...others.slice(k)];
}

// Past messages a provider gets when it takes a conversation over: about this many tokens, counted as TOKEN_CHARS
// characters each, and no more than REPLAY_SHARE of its context window when that is known.
export const REPLAY_TOKENS = 16_000;
const REPLAY_SHARE = 0.1;
const TOKEN_CHARS = 4;
// One replayed message at most, so a single long one cannot take the whole budget.
const REPLAY_ITEM = 6000;
const APP_ROLE: Partial<Record<string, string>> = { delegated: 'delegated task result', approval: 'permission asks handed over', consult: 'recommendation asked on a waiting permission' };
const AGENT = { claude: 'Claude', codex: 'Codex' };

type ReplayItem = { kind: 'user' | 'reply' | 'step' | 'app'; head: string; text: string };

// The replay block's opening line and items, oldest first, or null when there is nothing to replay. since: only what
// came after that time. partial: older events were not read, so the count of items left out is a lower bound.
export function replayText(events: TimedEvent[], o: { since: number | null; window: number | null; from: ProviderSide; to: ProviderSide; partial: boolean }) {
  const items: ReplayItem[] = [];
  const byId = new Map<string, ReplayItem>();
  const add = (id: string, it: ReplayItem) => {
    byId.set(id, it);
    items.push(it);
    return it;
  };
  let at = 0;
  for (const e of events) {
    at = e.at ?? at;
    if (o.since !== null && at <= o.since) continue;
    if (e.type === 'user') {
      const extra = (e.files?.length ?? 0) + (e.pastes?.length ?? 0);
      if (e.origin) items.push({ kind: 'app', head: `App · ${APP_ROLE[e.origin.role] ?? 'message from another session'}`, text: oneLine(e.text, 300) });
      else items.push({ kind: 'user', head: 'User', text: `${cut(e.text, REPLAY_ITEM)}${extra ? `\n(${extra} attached or pasted item${extra > 1 ? 's' : ''} not replayed)` : ''}` });
    } else if (e.type === 'text') {
      // Codex ids carry the cx: prefix, so each reply names the provider that wrote it.
      const it = byId.get(e.id) ?? add(e.id, { kind: 'reply', head: e.id.startsWith('cx:') ? AGENT.codex : AGENT.claude, text: '' });
      it.text += e.delta;
    } else if (e.type === 'tool' && !e.partial && !e.fold) {
      const it = byId.get(e.id) ?? add(e.id, { kind: 'step', head: `${e.id.startsWith('cx:') ? AGENT.codex : AGENT.claude} · tool steps`, text: '' });
      it.text = `- ${e.name}: ${oneLine(e.summary, 140)}`;
    } else if (e.type === 'tool-result' && e.error) {
      const it = byId.get(e.id);
      if (it?.kind === 'step' && !it.text.includes(' — failed: ')) it.text += ` — failed: ${oneLine(e.error, 120)}`;
    }
  }
  const all = items.flatMap((it) => {
    const text = it.kind === 'reply' ? cut(fullText(it.text).trim(), REPLAY_ITEM) : it.text;
    return text.trim() ? [{ ...it, text }] : [];
  });
  if (!all.length) return null;
  // The last user message, the last reply and the first user message go first, then the rest, newest first.
  const first = [all.findLastIndex((it) => it.kind === 'user'), all.findLastIndex((it) => it.kind === 'reply'), all.findIndex((it) => it.kind === 'user')].filter((i) => i >= 0);
  const keep = new Set<number>();
  let left = Math.floor(Math.min(REPLAY_TOKENS, o.window ? o.window * REPLAY_SHARE : REPLAY_TOKENS) * TOKEN_CHARS);
  for (const i of new Set([...first, ...all.map((_, k) => all.length - 1 - k)])) {
    const cost = all[i].head.length + all[i].text.length + 16;
    if (cost > left) break;
    keep.add(i);
    left -= cost;
  }
  const out: string[] = [];
  let run = '';
  all.forEach((it, i) => {
    if (!keep.has(i)) return;
    const head = `[Earlier · ${it.head}]`;
    // Consecutive tool steps of one provider share a header.
    if (it.kind === 'step' && head === run) out[out.length - 1] += `\n${it.text}`;
    else out.push(`${head}\n${it.text}`);
    run = it.kind === 'step' ? head : '';
  });
  const gone = all.length - keep.size;
  const side = (s: ProviderSide) => `${AGENT[s.provider]} (${s.model})`;
  const open = o.since === null
    ? `Context from earlier in this same conversation, replayed by the app: it ran on ${side(o.from)} until now and continues on ${side(o.to)}.`
    : `Context from this same conversation since you last took part, replayed by the app: ${side(o.from)} ran it meanwhile.`;
  const count = `${gone || 'No'} item${gone === 1 ? ' was' : 's were'} left out to fit${o.partial ? ', and messages before the oldest one read are not counted' : ''}.`;
  return [`${open} These are past messages, not a new request: do not answer them or repeat their actions. ${count}`, ...out].join('\n\n');
}


// Divider rows where the conversation passes from one provider's turns to the other's; theirs holds the other side's events.
export function markSwitches(events: TimedEvent[], theirs: Set<TimedEvent>, mine: ProviderSide, other: ProviderSide): TimedEvent[] {
  const out: TimedEvent[] = [];
  let was: boolean | null = null;
  for (const e of events) {
    if (e.type === 'user' || e.type === 'text') {
      const now = theirs.has(e);
      if (was !== null && now !== was) out.push({ type: 'provider-switch', id: `sw:${e.id}`, from: now ? mine : other, to: now ? other : mine, ...(e.at !== undefined ? { at: e.at } : {}) });
      was = now;
    }
    out.push(e);
  }
  return out;
}
