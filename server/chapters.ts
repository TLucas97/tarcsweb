import type { Chapter } from './protocol.ts';

const KEEP = 100;
const REPLY_MAX = 4000;

// How a chapter got its title: the prompt's first words, a Haiku call in flight, or a final one.
type TitleState = 'auto' | 'pending' | 'final';

type Rec = {
  id: string;
  prompt: string;
  // Main-thread reply text, trimmed, used only to ask for a title.
  reply: string;
  title: string;
  state: TitleState;
  startedAt: number | null;
  endedAt: number | null;
  files: Map<string, { add: number; rm: number }>;
  reads: Set<string>;
  tools: number;
};

export type TitleJob = { id: string; prompt: string; reply: string; files: string[]; first: boolean };

// "Fix the login redirect" from a long prompt: the first five words, cut at a word boundary.
export function firstWords(text: string, words = 5, max = 40) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cut = flat.split(' ').slice(0, words).join(' ');
  const short = cut.length > max ? cut.slice(0, max).replace(/\s+\S*$/, '') : cut;
  return short.replace(/[\s,.;:!?-]+$/, '') + (short.length < flat.length ? '…' : '') || 'Untitled';
}

export class Chapters {
  private list: Rec[] = [];

  get size() {
    return this.list.length;
  }

  private get last() {
    return this.list[this.list.length - 1];
  }

  start(id: string, prompt: string, at: number | null) {
    const prev = this.last;
    if (prev && prev.endedAt === null) prev.endedAt = at;
    // Slash commands are their own title; Haiku has nothing to add.
    const command = /^\/\S+/.exec(prompt.trim())?.[0];
    this.list.push({
      id, prompt, reply: '', title: command ?? firstWords(prompt), state: command ? 'final' : 'auto',
      startedAt: at, endedAt: null, files: new Map(), reads: new Set(), tools: 0,
    });
    if (this.list.length > KEEP) this.list.shift();
  }

  text(delta: string) {
    const c = this.last;
    if (c) c.reply = (c.reply + delta).slice(-REPLY_MAX);
  }

  tool() {
    if (this.last) this.last.tools++;
  }

  read(path: string) {
    this.last?.reads.add(path);
  }

  edited(path: string, add: number, rm: number) {
    const c = this.last;
    if (!c) return;
    const f = c.files.get(path) ?? { add: 0, rm: 0 };
    c.files.set(path, { add: f.add + add, rm: f.rm + rm });
  }

  end(at: number | null) {
    if (this.last) this.last.endedAt = at;
  }

  // A turn ended; returns the job to title it, or null when it needs none.
  turnEnd(at: number): TitleJob | null {
    const c = this.last;
    if (!c) return null;
    c.endedAt = at;
    return c.state === 'auto' ? this.job(c) : null;
  }

  // Finished chapters still on first-words titles, newest first; a running one is titled when its turn ends.
  untitled(max: number): TitleJob[] {
    return this.list.filter((c) => c.state === 'auto' && c.endedAt !== null).reverse().slice(0, max).map((c) => this.job(c));
  }

  private job(c: Rec): TitleJob {
    c.state = 'pending';
    return { id: c.id, prompt: c.prompt, reply: c.reply, files: [...c.files.keys()], first: c === this.list[0] };
  }

  // null keeps the first-words title and stops asking again.
  titled(id: string, title: string | null) {
    const c = this.list.find((x) => x.id === id);
    if (!c) return;
    c.state = 'final';
    if (title) c.title = title;
  }

  // Every title plus the last n prompts and replies, for the skills suggestion.
  recent(n: number) {
    return { titles: this.list.map((c) => c.title), turns: this.list.slice(-n).map((c) => ({ prompt: c.prompt, reply: c.reply })) };
  }

  snapshot(): Chapter[] {
    return this.list.map((c) => ({
      id: c.id, title: c.title, startedAt: c.startedAt, endedAt: c.endedAt,
      files: [...c.files].map(([path, f]) => ({ path, ...f })), tools: c.tools, reads: c.reads.size,
    }));
  }
}
