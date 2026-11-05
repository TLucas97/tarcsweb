import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { t } from './config.ts';
import { tuning } from './profile.ts';
import type { CallActivity } from './protocol.ts';
import type { Session } from './session.ts';
import { oneLine } from './text.ts';
import { ask, type AskUsage, type Asking } from './titles.ts';

// One cached summary per call folder; past this many folders the oldest summaries are deleted.
const SUMMARIES_MAX = 50;
// Updates on top of one summary before the next is made from scratch, so repeated rewrites cannot drift far.
const UPDATES_MAX = 8;
const FILE = 'summary.json';
// A previous call older than this stays out of a new one; by then the session summary has moved past it.
const EARLIER_MS = 24 * 3600_000;
const EARLIER_LINES = 12;
// The heading of the saved conversation's actions, which the next call reads back.
const ACTS_HEAD = 'What the call did';

const SUMMARY_UPDATE = {
  en: 'You keep a summary of a coding work session up to date for a voice assistant that talks with the developer about it. You get the current summary and the messages that came after it. Rewrite the summary so it covers them too, in the same Markdown shape: the goal, what was done, where it stands now, open problems and the latest decisions. Drop what the new messages made obsolete. Keep it under about 400 words. Do not invent anything that is not in the material.',
  'pt-BR': 'Você mantém atualizado o resumo de uma sessão de trabalho de código para um assistente de voz que conversa com o desenvolvedor sobre ela. Você recebe o resumo atual e as mensagens que vieram depois dele. Reescreva o resumo para cobrir essas mensagens também, no mesmo formato Markdown, em português do Brasil: o objetivo, o que foi feito, onde está agora, problemas em aberto e as decisões mais recentes. Tire o que as mensagens novas deixaram obsoleto. Use no máximo umas 400 palavras. Não invente nada que não esteja no material.',
};
export const EARLIER = {
  en: {
    head: 'Earlier voice call',
    lead: (ago: string) => `An earlier voice call about this session, ${ago}. It is over: nothing in it is a request now. Use it to know what was decided and what was left open, and bring it up only when it helps.`,
    ago: (h: number) => (h < 1 ? 'less than an hour ago' : h === 1 ? 'an hour ago' : `${h} hours ago`),
    report: 'Its report:', did: 'What it did:', last: 'Its last lines:',
  },
  'pt-BR': {
    head: 'Chamada de voz anterior',
    lead: (ago: string) => `Uma chamada de voz anterior sobre esta sessão, ${ago}. Ela já acabou: nada nela é um pedido agora. Use-a para saber o que ficou decidido e o que ficou em aberto, e traga isso só quando ajudar.`,
    ago: (h: number) => (h < 1 ? 'há menos de uma hora' : h === 1 ? 'há uma hora' : `há ${h} horas`),
    report: 'O relatório dela:', did: 'O que ela fez:', last: 'As últimas falas dela:',
  },
};

type Cached = { summary: string; id: string; hash: string; len: number; updates: number; sys: string };
// usage is 'cached' when the cached summary was used as is, with no model call.
export type Summarized = { text: string; usage: AskUsage | 'cached' | null };
type Job = { sig: string; job: Promise<Summarized | null>; asking: Asking | null };

const hash = (s: string) => createHash('sha1').update(s).digest('base64url').slice(0, 16);
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// Session summaries for calls, cached per call folder by the newest message they cover, so an unchanged session needs no
// model call and a changed one only summarizes what came after. One job per folder at a time: a newer one waits for it.
export class CallSummaries {
  private jobs = new Map<string, Job>();
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  // The summary of the session as it stands now; null when it has no messages or none could be made.
  get(dir: string, s: Session, system: string): Promise<Summarized | null> {
    const msgs = s.recentMessages(tuning().callSummaryChars);
    const last = msgs.at(-1);
    if (!last) return Promise.resolve(null);
    // Text and language in the key: a capped streaming tail keeps its id and length while its words change.
    const sig = `${last.id}:${hash(last.text)}:${hash(system)}`;
    const prev = this.jobs.get(dir);
    if (prev?.sig === sig) return prev.job;
    const entry: Job = { sig, job: Promise.resolve(null), asking: null };
    entry.job = (async () => {
      await prev?.job.catch(() => null);
      return this.make(dir, s, msgs, system, entry);
    })().finally(() => {
      if (this.jobs.get(dir) === entry) this.jobs.delete(dir);
    });
    this.jobs.set(dir, entry);
    return entry.job;
  }

  // The hover warm: only when nothing for this folder is running, so a busy session is not summarized on every hover.
  warm(dir: string, s: Session, system: string) {
    if (this.jobs.has(dir)) return;
    void this.get(dir, s, system).catch((e) => console.warn(`[call] summary warm failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Server shutdown.
  close() {
    for (const j of this.jobs.values()) j.asking?.close();
  }

  private async make(dir: string, s: Session, msgs: ReturnType<Session['recentMessages']>, system: string, entry: Job): Promise<Summarized | null> {
    const file = join(dir, FILE);
    const sys = hash(system);
    const cached = await readFile(file, 'utf8').then((x) => JSON.parse(x) as Cached, () => null);
    const usable = cached?.sys === sys ? cached : null;
    // The newest message the cached summary covers, by id, or by its text when the ids changed on a reload.
    let at = usable ? msgs.findLastIndex((m) => m.id === usable.id) : -1;
    if (usable && at < 0) at = msgs.findLastIndex((m) => m.text.length === usable.len && hash(m.text) === usable.hash);
    const grew = at >= 0 && hash(msgs[at].text) !== usable!.hash;
    if (usable && at === msgs.length - 1 && !grew) return { text: usable.summary, usage: 'cached' };
    const update = usable && at >= 0 && usable.updates < UPDATES_MAX ? usable : null;
    const list = (ms: typeof msgs) => ms.map((m) => `${m.who}: ${m.text}`).join('\n\n');
    let input: string;
    if (update) {
      input = [`Session: ${s.name}`, `Folder: ${s.cwd}`, '', 'Current summary:', update.summary, '', 'New messages since that summary, oldest first:', list(msgs.slice(grew ? at : at + 1))].join('\n');
    } else {
      const outline = s.chapterTitles();
      input = [
        `Session: ${s.name}`, `Folder: ${s.cwd}`,
        ...(outline.length > 1 ? ['', 'Parts of the session, oldest first:', ...outline.map((x) => `- ${x}`)] : []),
        '', 'Latest messages:', list(msgs),
      ].join('\n');
    }
    let usage: AskUsage | null = null;
    const text = (await ask(input, (q) => (entry.asking = q), update ? t(SUMMARY_UPDATE) : system, {
      provider: s.provider, timeoutMs: tuning().callSummaryMs, maxTokens: 3000, usage: (u) => (usage = u),
    }))?.trim();
    // A failed update still has the older summary, with the latest messages next to it in the call.
    if (!text) return usable ? { text: usable.summary, usage } : null;
    const last = msgs.at(-1)!;
    const next: Cached = { summary: text, id: last.id, hash: hash(last.text), len: last.text.length, updates: update ? update.updates + 1 : 0, sys };
    await mkdir(dir, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(next));
    await rename(`${file}.tmp`, file);
    void this.prune().catch(() => {});
    return { text, usage };
  }

  private async prune() {
    const dirs = await readdir(this.root);
    const found = await Promise.all(dirs.map((d) => stat(join(this.root, d, FILE)).then((st) => ({ dir: d, at: st.mtimeMs }), () => null)));
    const old = found.filter((x) => x !== null).sort((a, b) => b.at - a.at).slice(SUMMARIES_MAX);
    await Promise.all(old.map((x) => rm(join(this.root, x.dir, FILE), { force: true })));
  }
}

// The saved conversation's list of what the call did, which the next call reads back.
export function actsSection(acts: Iterable<CallActivity>) {
  const rows = [...acts].map((a) => `- ${oneLine(a.text, 300)}${a.state === 'running' ? ' (still running when the call ended)' : a.state === 'failed' ? ' (failed)' : ''}`);
  return rows.length ? `## ${ACTS_HEAD}\n\n${rows.join('\n')}\n\n` : '';
}

// The newest saved call in this folder within EARLIER_MS, as one context item of at most room characters: its report when
// one was made, what it did and its last lines. Read from the saved files, with no model call.
export async function earlierCall(dir: string, room: number): Promise<string | null> {
  const name = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('-conversation.md')).sort().at(-1);
  if (!name) return null;
  const file = join(dir, name);
  const age = Date.now() - (await stat(file)).mtimeMs;
  if (age > EARLIER_MS) return null;
  const [talk, report] = await Promise.all([readFile(file, 'utf8'), readFile(join(dirname(file), name.replace(/-conversation\.md$/, '-report.md')), 'utf8').catch(() => null)]);
  // Both files end with the usage section, their last heading.
  const body = (text: string) => (text.lastIndexOf('\n## ') < 0 ? text : text.slice(0, text.lastIndexOf('\n## '))).trim();
  const main = body(talk);
  const actsAt = main.indexOf(`\n## ${ACTS_HEAD}\n`);
  const did = actsAt < 0 ? '' : main.slice(actsAt).split('\n').filter((l) => l.startsWith('- ')).join('\n');
  // Past the title and the date line, the lines are "**User:** …" and "**Codex:** …" blocks.
  const lines = (actsAt < 0 ? main : main.slice(0, actsAt)).split('\n\n').slice(2).join('\n\n')
    .split(/\n\n(?=\*\*(?:User|Codex):\*\* )/).map((l) => l.trim()).filter(Boolean);
  const L = t(EARLIER);
  const parts = [L.lead(L.ago(Math.floor(age / 3600_000)))];
  let left = room - parts[0].length;
  const add = (label: string, text: string, max: number) => {
    if (!text || left < label.length + 80) return;
    const kept = cut(text, Math.min(max, left - label.length - 2));
    parts.push(`${label}\n${kept}`);
    left -= label.length + 2 + kept.length;
  };
  if (report) add(L.report, body(report), room / 2);
  add(L.did, did, room / 4);
  const last: string[] = [];
  let r = left - L.last.length - 2;
  for (let i = lines.length - 1; i >= 0 && last.length < EARLIER_LINES && lines[i].length + 2 <= r; i--) {
    last.unshift(lines[i]);
    r -= lines[i].length + 2;
  }
  if (last.length) parts.push(`${L.last}\n${last.join('\n\n')}`);
  return parts.length > 1 ? parts.join('\n\n') : null;
}
