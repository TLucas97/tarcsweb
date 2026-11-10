import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { onSkills, send } from '../socket.ts';
import { currentSummary, useStore } from '../store.ts';
import { useClaudeReady } from '../setup.ts';
import { isNarrow } from '../narrow.ts';
import { Chev, CopyBtn, Seg } from '../bits.tsx';
import { setPref, usePref, type PrefValue } from '../prefs.ts';
import { SKILL_THEMES, type SkillCatalog, type SkillDeep, type SkillInfo, type SkillOrigin, type SkillOriginKind, type SkillPick, type SkillUse } from '../../../server/protocol.ts';
import type { SkillRef } from './ref.tsx';
import { Reveal } from '../skeleton/Reveal.tsx';
import { shapeMemory } from '../skeleton/shapes.ts';

// picks is null until an answer came (or after dismissing it). deep: the request of a deep search and its current step.
type Deep = SkillDeep & { step: number };
type Sug = { busy: boolean; picks: SkillPick[] | null; error: string | null; deep?: Deep };
const SUG_MAX = 20;
// Organize is one run per client, so its state is not per session.
type Org = { phase: 'idle' | 'confirm' | 'running' | 'done' | 'error'; done: number; total: number; found: number; checked: number; sorted: number; error: string | null };
const ORG_IDLE: Org = { phase: 'idle', done: 0, total: 0, found: 0, checked: 0, sorted: 0, error: null };
const useSk = create<{ catalog: SkillCatalog | null; used: SkillUse[]; sug: Record<string, Sug>; org: Org }>(() => ({ catalog: null, used: [], sug: {}, org: ORG_IDLE }));
const setOrg = (o: Partial<Org>) => useSk.setState((s) => ({ org: { ...s.org, ...o } }));

function putSug(sid: string, v: Sug) {
  useSk.setState((s) => {
    const { [sid]: _old, ...rest } = s.sug;
    const keys = Object.keys(rest);
    for (const k of keys.slice(0, Math.max(0, keys.length - SUG_MAX + 1))) delete rest[k];
    return { sug: { ...rest, [sid]: v } };
  });
}

onSkills((m) => {
  if (m.type === 'skills') return useSk.setState({ catalog: m.catalog, used: m.used });
  const running = useSk.getState().org.phase === 'running';
  if (m.type === 'skills-organize-progress') return void (running && setOrg({ done: m.done, total: m.total }));
  if (m.type === 'skills-organized') {
    const counts = { found: m.found, checked: m.checked, sorted: m.sorted ?? 0 };
    if (running) setOrg(m.error ? { phase: 'error', error: m.error, ...counts } : { phase: 'done', error: null, ...counts });
    return;
  }
  const cur = useSk.getState().sug[m.sessionId];
  if (!cur?.busy) return;
  if (m.type === 'skills-suggest-step') return void (cur.deep && putSug(m.sessionId, { ...cur, deep: { ...cur.deep, step: m.step } }));
  putSug(m.sessionId, { ...cur, busy: false, picks: m.picks, error: m.error ?? null });
});

function startOrganize(sessionId: string | null, total: number) {
  setOrg({ ...ORG_IDLE, phase: 'running', total });
  if (!send({ type: 'skills-organize', ...(sessionId ? { sessionId } : {}) })) setOrg({ phase: 'error', error: 'Not connected to the server' });
}

function stopOrganize() {
  send({ type: 'skills-organize-stop' });
  setOrg(ORG_IDLE);
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

// Confirm, then a determinate bar while batches run (the total is known), then a result line.
function OrganizePanel({ org, pending, sessionId, account }: { org: Org; pending: number; sessionId: string | null; account: string }) {
  const close = <button type="button" className="sk-x" aria-label="Dismiss" title="Dismiss" onClick={() => setOrg(ORG_IDLE)}>×</button>;
  if (org.phase === 'confirm') {
    return (
      <section className="sk-orgp" aria-label="Organize skills">
        <p>Reads your skills with your {account} account to find who wrote them and sort them by theme. No skill file is changed; tarcsweb only saves what it finds for itself.</p>
        <div className="sk-orgacts">
          <button type="button" className="sk-link" onClick={() => setOrg(ORG_IDLE)}>Cancel</button>
          <button type="button" className="sk-add wide" onClick={() => startOrganize(sessionId, pending)}>Organize</button>
        </div>
      </section>
    );
  }
  if (org.phase === 'running') {
    const total = org.total || pending;
    return (
      <section className="sk-orgp" aria-label="Organize skills" aria-busy="true">
        <div className="sk-busy" role="status">
          <span>Organizing {Math.min(org.done, total)} of {total}…</span>
          <button type="button" className="sk-link" onClick={stopOrganize}>Stop</button>
        </div>
        <div className="sk-bar" role="progressbar" aria-label="Organize progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={org.done}>
          <i style={{ transform: `scaleX(${total ? Math.min(1, org.done / total) : 0})` }} />
        </div>
      </section>
    );
  }
  if (org.phase === 'error') {
    return (
      <section className="sk-orgp" aria-label="Organize skills">
        <div className="sk-err" role="alert">{org.error}<button type="button" className="sk-link" onClick={() => startOrganize(sessionId, pending)}>Try again</button>{close}</div>
      </section>
    );
  }
  if (org.phase === 'done') {
    return (
      <section className="sk-orgp" aria-label="Organize skills">
        <div className="sk-busy" role="status">
          <span>{[
            org.checked ? (org.found ? `Found authors for ${plural(org.found, 'skill')}` : `No authors named in the ${plural(org.checked, 'skill')} read`) : '',
            org.sorted ? `sorted ${plural(org.sorted, 'skill')} by theme` : '',
          ].filter(Boolean).join(' · ') || 'Nothing left to organize'}</span>
          <span className="sk-push">{close}</span>
        </div>
      </section>
    );
  }
  return null;
}

const SUB: Record<SkillOriginKind, string> = {
  user: '~/.claude/skills', project: '.claude/skills in this folder', plugin: 'Claude Code plugin',
  synced: 'Synced from claude.ai', codex: '~/.codex/skills', 'codex-plugin': 'Codex plugin',
};
const tagOf = (o: SkillOrigin | undefined) => (!o ? '' : o.kind === 'codex-plugin' ? `${o.label} · Codex` : o.label);

type Group = PrefValue<'skillsGroup'>;
const GROUPS: [Group, string][] = [['source', 'Source'], ['author', 'Author'], ['theme', 'Theme']];
// A first-level folder; key is the group's letter and the value ("s:<origin>", "a:<author>", "t:<theme>"), empty when unknown.
type Bucket = { key: string; label: string; sub?: string };
type Level = { families: { prefix: string; skills: SkillInfo[] }[]; singles: SkillInfo[]; total: number };
type Tree = {
  origins: Map<string, SkillOrigin>; byKey: Map<string, SkillInfo>; byPath: Map<string, SkillInfo>; byName: Map<string, SkillInfo | null>;
  children: Map<string, SkillInfo[]>; buckets: Record<Group, Bucket[]>; levels: Map<string, Level>; familyOf: Map<string, string>;
};

const push = <T,>(m: Map<string, T[]>, k: string, v: T) => void (m.get(k) ?? m.set(k, []).get(k)!).push(v);
const prefixOf = (name: string) => name.split(/[-_:]/)[0].toLowerCase();
const byName = (a: SkillInfo, b: SkillInfo) => a.name.localeCompare(b.name);
const bucketOf = (g: Group, s: SkillInfo) => (g === 'source' ? `s:${s.origin}` : g === 'author' ? `a:${s.author ?? ''}` : `t:${s.theme ?? ''}`);
const famKey = (bucket: string, key: string) => `${bucket}\n${key}`;

// A family folder when 2+ skills share a name prefix (gsap-*), unless that would be the whole folder.
function levelOf(bucket: string, list: SkillInfo[], familyOf: Map<string, string>): Level {
  const groups = new Map<string, SkillInfo[]>();
  for (const s of list) push(groups, prefixOf(s.name), s);
  const level: Level = { families: [], singles: [], total: list.length };
  for (const [prefix, skills] of groups) {
    if (skills.length >= 2 && skills.length < list.length) {
      level.families.push({ prefix, skills: skills.sort(byName) });
      for (const s of skills) familyOf.set(famKey(bucket, s.key), prefix);
    } else level.singles.push(...skills);
  }
  level.families.sort((a, b) => a.prefix.localeCompare(b.prefix));
  level.singles.sort(byName);
  return level;
}

const trees = new WeakMap<SkillCatalog, Tree>();
function treeOf(c: SkillCatalog): Tree {
  const hit = trees.get(c);
  if (hit) return hit;
  const children = new Map<string, SkillInfo[]>();
  const lists = new Map<string, SkillInfo[]>(c.origins.map((o) => [`s:${o.key}`, []]));
  for (const s of c.skills) {
    if (s.parent) push(children, s.parent, s);
    else for (const [g] of GROUPS) push(lists, bucketOf(g, s), s);
  }
  const levels = new Map<string, Level>();
  const familyOf = new Map<string, string>();
  for (const [k, list] of lists) levels.set(k, levelOf(k, list, familyOf));
  const size = (k: string) => levels.get(k)?.total ?? 0;
  // Authors by size, then themes in list order; the unknown folder goes last in both.
  const authors = [...lists.keys()].filter((k) => k.startsWith('a:') && k !== 'a:').sort((a, b) => size(b) - size(a) || a.localeCompare(b));
  const buckets: Record<Group, Bucket[]> = {
    source: c.origins.map((o) => ({ key: `s:${o.key}`, label: o.label, sub: SUB[o.kind] })),
    author: [...authors.map((k) => ({ key: k, label: k.slice(2) })), ...(lists.has('a:') ? [{ key: 'a:', label: 'Unknown author', ...(c.authorsPending ? { sub: 'Organize can look for more' } : {}) }] : [])],
    theme: [
      ...SKILL_THEMES.filter((t) => lists.has(`t:${t}`)).map((t) => ({ key: `t:${t}`, label: t })),
      ...(lists.has('t:') ? [{ key: 't:', label: 'Not sorted yet', sub: 'Organize sorts them by theme' }] : []),
    ],
  };
  const names = new Map<string, SkillInfo | null>();
  for (const s of c.skills) for (const n of new Set([s.name, s.cmd].filter((x): x is string => !!x))) names.set(n, names.has(n) && names.get(n) !== s ? null : s);
  const t: Tree = {
    origins: new Map(c.origins.map((o) => [o.key, o])), byKey: new Map(c.skills.map((s) => [s.key, s])), byPath: new Map(c.skills.map((s) => [s.path, s])),
    byName: names, children, buckets, levels, familyOf,
  };
  trees.set(c, t);
  return t;
}

type Nav = { kind: 'bucket'; key: string } | { kind: 'family'; bucket: string; prefix: string } | { kind: 'skill'; key: string };

// Where a skill lives under the current grouping, as the breadcrumb shows it.
function pathTo(t: Tree, g: Group, key: string): Nav[] {
  const s = t.byKey.get(key);
  if (!s) return [];
  if (s.parent) return [...pathTo(t, g, s.parent), { kind: 'skill', key }];
  const bucket = bucketOf(g, s);
  const fam = t.familyOf.get(famKey(bucket, key));
  return [{ kind: 'bucket', key: bucket }, ...(fam ? [{ kind: 'family' as const, bucket, prefix: fam }] : []), { kind: 'skill', key }];
}

// The longest start of nav that still exists, so a catalog refresh never leaves a dead view.
function validNav(t: Tree, nav: Nav[]) {
  const ok = (n: Nav) => (n.kind === 'skill' ? t.byKey.has(n.key) : n.kind === 'bucket' ? t.levels.has(n.key) : !!t.levels.get(n.bucket)?.families.some((f) => f.prefix === n.prefix));
  const i = nav.findIndex((n) => !ok(n));
  return i < 0 ? nav : nav.slice(0, i);
}

// A Recent entry's skill: by file path, else by the name or /command the agent used.
const skillOfUse = (t: Tree, u: SkillUse) => (u.path ? t.byPath.get(u.path) : undefined) ?? t.byKey.get(u.name) ?? t.byName.get(u.name) ?? undefined;
const RECENT_MAX = 5;

function ago(at: number, now: number) {
  const m = Math.round((now - at) / 60_000);
  if (m < 60) return m < 1 ? 'just now' : `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d < 7 ? `${d} days ago` : d < 14 ? 'last week' : `${Math.round(d / 7)} weeks ago`;
}

// Every word must appear in the name, key, author or description; name matches rank first.
function search(c: SkillCatalog, query: string) {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { s: SkillInfo; r: number }[] = [];
  for (const s of c.skills) {
    const name = s.name.toLowerCase();
    const hay = `${name} ${s.key.toLowerCase()} ${(s.author ?? '').toLowerCase()} ${s.desc.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    scored.push({ s, r: name === q ? 0 : name.startsWith(words[0]) ? 1 : words.every((w) => name.includes(w)) ? 2 : 3 });
  }
  return scored.sort((a, b) => a.r - b.r || byName(a.s, b.s)).map((x) => x.s);
}

const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/tree\/HEAD\//, '/…/');

const FolderIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h2.6l1.5 1.6h5.4a1.5 1.5 0 0 1 1.5 1.5v6.4a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5z" />
  </svg>
);
const SparkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
    <path d="m6.5 2 1.1 3.4L11 6.5 7.6 7.6 6.5 11 5.4 7.6 2 6.5l3.4-1.1zM12 9.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z" />
  </svg>
);
const DeepIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h6M2.5 12h4" /><circle cx="11.75" cy="10.75" r="2.25" /><path d="m13.4 12.4 1.35 1.35" /></svg>
);
const SearchIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3.5 3.5" /></svg>
);
const Next = () => (
  <svg className="sk-next" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" /></svg>
);

function FolderRow({ label, sub, count, onOpen }: { label: string; sub?: string; count: number; onOpen: () => void }) {
  return (
    <button type="button" className="sk-row sk-folder" onClick={onOpen}>
      <span className="sk-fi"><FolderIcon /></span>
      <span className="sk-nm">{label}</span>
      {sub && <small>{sub}</small>}
      <span className="sk-count">{count}</span>
      <Next />
    </button>
  );
}

// The skeleton's shape on a first visit; later visits use the shape of the list last shown.
const noop = () => {};
const SHAPE = shapeMemory('skills');
const SAMPLE = (
  <>
    <nav className="sk-crumbs">
      <span className="sk-cur">All skills</span>
      <span className="sk-push"><Seg small label="Group skills by" value="source" options={GROUPS} onPick={noop} /></span>
    </nav>
    <div className="sk-view">
      {(['user', 'project', 'plugin', 'synced', 'codex'] as const).map((k, i) => <FolderRow key={k} label={['Personal', 'This project', 'Plugins', 'Synced', 'Codex'][i]} sub={SUB[k]} count={12} onOpen={noop} />)}
    </div>
  </>
);

function SkillRow({ s, tag, why, kids, onOpen, children }: { s: SkillInfo; tag?: string; why?: string; kids: number; onOpen: () => void; children?: ReactNode }) {
  return (
    <div className="sk-item">
      <button type="button" className="sk-row" onClick={onOpen}>
        <span className="sk-nm">
          {s.name}
          {tag && <span className="sk-tag">{tag}</span>}
          {kids > 0 && <span className="sk-tag">{kids} sub-skills</span>}
        </span>
        <small>{why || s.desc || 'No description'}</small>
        {!children && <Next />}
      </button>
      {children}
    </div>
  );
}

function AddBtn({ s, added, onToggle, wide }: { s: SkillInfo; added: boolean; onToggle: (r: SkillRef) => void; wide?: boolean }) {
  return (
    <button
      type="button" className={`sk-add${added ? ' on' : ''}${wide ? ' wide' : ''}`} aria-pressed={added}
      title={added ? 'Remove it from your message' : 'Add it to your message as a chip; the agent gets its file path when you send'}
      onClick={() => onToggle({ name: s.name, path: s.path })}
    >
      {added ? (
        <><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m2.5 6.2 2.3 2.3 4.7-5" /></svg>Added</>
      ) : (
        'Add to message'
      )}
    </button>
  );
}

// 3-10 s is the usual wait; past 12 s the line says so instead of looking stuck.
function BusyLine({ count, onStop }: { count: number; onStop: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="sk-busy" role="status">
      <span className="sk-dots" aria-hidden="true"><i /><i /><i /></span>
      <span>{slow ? 'Still reading, this can take up to half a minute…' : `Reading this chat and ${count} skills…`}</span>
      <button type="button" className="sk-link" onClick={onStop}>Stop</button>
    </div>
  );
}

// A deep search takes tens of seconds, so it names the step that runs and keeps the finished ones visible.
const DEEP_STEPS = ['Reading this chat', 'Shortlisting from {n} skills', 'Opening the best candidates', 'Ranking the best fits'];
function DeepSteps({ step, count, onStop }: { step: number; count: number; onStop: () => void }) {
  return (
    <>
      <div className="sk-gh"><span>Deep search</span><button type="button" className="sk-link" onClick={onStop}>Stop</button></div>
      <ol className="sk-steps" role="status">
        {DEEP_STEPS.map((s, i) => (
          <li key={i} className={i < step ? 'done' : i === step ? 'now' : undefined}>
            <i aria-hidden="true">{i < step && <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m2.5 6.2 2.3 2.3 4.7-5" /></svg>}</i>
            {s.replace('{n}', String(count))}{i === step && '…'}
          </li>
        ))}
      </ol>
    </>
  );
}

function DeepSwitch({ k, label }: { k: 'skillsDeepRecent' | 'skillsDeepSummary'; label: string }) {
  const on = usePref(k);
  return (
    <label className="sk-sw">
      <button type="button" role="switch" className="set-sw" aria-checked={on} onClick={() => setPref(k, !on)}><i /></button>
      {label}
    </label>
  );
}

const usedLine = (d: SkillDeep) => ['your note', d.recent && 'recent messages', d.summary && 'session summary'].filter(Boolean).join(' · ');

type Props = { sessionId: string | null; open: boolean; chips: SkillRef[]; onToggle: (r: SkillRef) => void; draft: () => string; slashOn: boolean };

export default function Library({ sessionId, open, chips, onToggle, draft, slashOn }: Props) {
  const catalog = useSk((s) => s.catalog);
  const used = useSk((s) => s.used);
  const sug = useSk((s) => (sessionId ? s.sug[sessionId] : undefined));
  const org = useSk((s) => s.org);
  const group = usePref('skillsGroup');
  const deepRecent = usePref('skillsDeepRecent');
  const deepSummary = usePref('skillsDeepSummary');
  const [deepOpen, setDeepOpen] = useState(false);
  const [note, setNote] = useState('');
  const deepId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // Organize runs on the tab's account; without a tab, on Claude when signed in, else Codex (as ask() decides).
  const provider = useStore((s) => (sessionId ? currentSummary(s)?.provider : undefined));
  const claudeReady = useClaudeReady();
  const account = (provider ?? (claudeReady ? 'claude' : 'codex')) === 'codex' ? 'Codex' : 'Claude';
  const [query, setQuery] = useState('');
  const [rawNav, setNav] = useState<Nav[]>([]);
  // Skills opened from search results; the query stays, so Back returns to the same results.
  const [rawFound, setFound] = useState<Nav[]>([]);
  // 'none' on first paint and for search, so only drilling slides.
  const [dir, setDir] = useState<'in' | 'back' | 'none'>('none');
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    send({ type: 'skills-load', ...(sessionId ? { sessionId } : {}) });
    if (!isNarrow()) searchRef.current?.focus({ preventScroll: true });
  }, [open, sessionId]);

  const tree = catalog ? treeOf(catalog) : null;
  const nav = tree ? validNav(tree, rawNav) : rawNav;
  const found = tree ? validNav(tree, rawFound) : rawFound;
  const searching = !!query.trim();
  const stack = searching ? found : nav;
  const added = (s: SkillInfo) => chips.some((c) => c.path === s.path);
  const kidsOf = (s: SkillInfo) => tree?.children.get(s.key)?.length ?? 0;

  const go = (next: Nav[], d: 'in' | 'back') => {
    (searching ? setFound : setNav)(next);
    setDir(d);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  const openSkill = (key: string) => {
    if (!tree) return;
    setNav(pathTo(tree, group, key));
    setDir('in');
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  const editQuery = (q: string) => {
    setQuery(q);
    setFound([]);
    setDir('none');
  };

  const busy = !!sug?.busy;
  // deep: undefined for the quick suggestion; a retry passes the same deep request again.
  const suggest = (deep?: SkillDeep) => {
    if (!sessionId || busy) return;
    editQuery('');
    putSug(sessionId, { busy: true, picks: null, error: null, ...(deep ? { deep: { ...deep, step: 0 } } : {}) });
    if (!send({ type: 'skills-suggest', sessionId, draft: draft(), ...(deep ? { deep } : {}) })) putSug(sessionId, { busy: false, picks: null, error: 'Not connected to the server' });
  };
  const searchDeep = (e?: FormEvent) => {
    e?.preventDefault();
    if (note.trim()) suggest({ note: note.trim(), recent: deepRecent, summary: deepSummary });
  };
  const toggleDeep = () => {
    setDeepOpen(!deepOpen);
    if (!deepOpen) requestAnimationFrame(() => noteRef.current?.focus());
  };
  const stop = () => {
    if (!sessionId) return;
    send({ type: 'skills-suggest-stop' });
    putSug(sessionId, { busy: false, picks: null, error: null });
  };
  const pickGroup = (g: Group) => {
    setPref('skillsGroup', g);
    setNav([]);
    setDir('none');
  };
  // One skill can be recorded by name and by path; forget every record that resolves to it, or it comes back.
  const forget = (s: SkillInfo, id: string) => {
    const ids = new Set([id, ...(tree ? used.filter((u) => skillOfUse(tree, u) === s).map((u) => u.id) : [])]);
    useSk.setState((st) => ({ used: st.used.filter((u) => !ids.has(u.id)) }));
    for (const one of ids) send({ type: 'skills-forget', id: one });
  };

  const results = catalog && searching && !found.length ? search(catalog, query) : null;
  const openFound = (key: string) => go([{ kind: 'skill', key }], 'in');

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape' && query) {
      e.preventDefault();
      e.stopPropagation();
      editQuery('');
    } else if (e.key === 'Backspace' && !query && nav.length) {
      e.preventDefault();
      go(nav.slice(0, -1), 'back');
    } else if (e.key === 'Enter' && results?.length) {
      e.preventDefault();
      openFound(results[0].key);
    }
  };

  const crumbLabel = (n: Nav) => (n.kind === 'bucket' ? Object.values(tree?.buckets ?? {}).flat().find((b) => b.key === n.key)?.label : n.kind === 'family' ? n.prefix : tree?.byKey.get(n.key)?.name) ?? '';
  const unsorted = (catalog?.authorsPending ?? 0) + (catalog?.themesPending ?? 0);
  const rootLabel = searching ? `Results for “${query.trim()}”` : 'All skills';
  const last = stack[stack.length - 1];

  let body: ReactNode;
  if (!catalog || !tree) body = null;
  else if (results) {
    body = results.length ? (
      results.map((s) => <SkillRow key={s.key} s={s} tag={tagOf(tree.origins.get(s.origin))} kids={kidsOf(s)} onOpen={() => openFound(s.key)} />)
    ) : (
      <div className="sk-empty">No skill matches “{query.trim()}”</div>
    );
  } else if (!last) {
    body = catalog.origins.length ? (
      <>
        {tree.buckets[group].map((b) => <FolderRow key={b.key} label={b.label} sub={b.sub} count={tree.levels.get(b.key)?.total ?? 0} onOpen={() => go([{ kind: 'bucket', key: b.key }], 'in')} />)}
        {unsorted > 0 && org.phase === 'idle' && (
          <div className="sk-orgrow">
            <button type="button" className="sk-suggest" onClick={() => setOrg({ ...ORG_IDLE, phase: 'confirm' })}>Organize skills</button>
            <span className="sk-note">
              {[catalog.authorsPending && `${plural(catalog.authorsPending, 'skill')} without an author`, catalog.themesPending && `${catalog.themesPending} without a theme`].filter(Boolean).join(' · ')}
            </span>
          </div>
        )}
      </>
    ) : (
      <div className="sk-empty">No skills found in ~/.claude/skills, plugins or ~/.codex/skills</div>
    );
  } else if (last.kind === 'bucket') {
    const level = tree.levels.get(last.key)!;
    body = (
      <>
        {level.families.map((f) => <FolderRow key={f.prefix} label={f.prefix} count={f.skills.length} onOpen={() => go([...nav, { kind: 'family', bucket: last.key, prefix: f.prefix }], 'in')} />)}
        {level.singles.map((s) => <SkillRow key={s.key} s={s} kids={kidsOf(s)} onOpen={() => go([...nav, { kind: 'skill', key: s.key }], 'in')} />)}
      </>
    );
  } else if (last.kind === 'family') {
    const fam = tree.levels.get(last.bucket)!.families.find((f) => f.prefix === last.prefix)!;
    body = fam.skills.map((s) => <SkillRow key={s.key} s={s} kids={kidsOf(s)} onOpen={() => go([...nav, { kind: 'skill', key: s.key }], 'in')} />);
  } else {
    const s = tree.byKey.get(last.key)!;
    const kids = tree.children.get(s.key) ?? [];
    body = (
      <div className="sk-detail">
        <div className="sk-dh">
          <h3>{s.name}</h3>
          <AddBtn s={s} added={added(s)} onToggle={onToggle} wide />
        </div>
        <p className={`sk-desc${s.desc ? '' : ' none'}`}>{s.desc || 'This skill has no description.'}</p>
        <dl className="sk-meta">
          <dt>From</dt><dd>{tagOf(tree.origins.get(s.origin))}{s.parent && <> · inside {tree.byKey.get(s.parent)?.name}</>}</dd>
          {s.author && <><dt>Author</dt><dd>{s.author}{s.authorInferred && <span className="sk-inf" title="Found by Organize in the skill's own text"> · inferred</span>}</dd></>}
          {s.theme && <><dt>Theme</dt><dd>{s.theme}</dd></>}
          <dt>File</dt><dd className="sk-path"><span className="mono">{s.path}</span><CopyBtn text={s.path} what="path" label={false} /></dd>
          {s.link && <><dt>Source</dt><dd><a href={s.link} target="_blank" rel="noreferrer noopener">{shortUrl(s.link)}</a></dd></>}
          {slashOn && s.cmd && <><dt>Command</dt><dd className="mono">/{s.cmd}</dd></>}
        </dl>
        {kids.length > 0 && (
          <>
            <div className="sk-gh">Sub-skills</div>
            {kids.map((k) => <SkillRow key={k.key} s={k} kids={0} onOpen={() => go([...stack, { kind: 'skill', key: k.key }], 'in')} />)}
          </>
        )}
      </div>
    );
  }

  const picks = sug?.picks?.filter((p) => tree?.byKey.has(p.key)) ?? null;
  const showSug = !searching && !!sug && (busy || !!picks || !!sug.error);
  const atRoot = !searching && !stack.length;
  const now = Date.now();
  const recent: { u: SkillUse; s: SkillInfo }[] = [];
  for (const u of atRoot && tree ? used : []) {
    const s = skillOfUse(tree!, u);
    if (s && recent.length < RECENT_MAX && !recent.some((r) => r.s === s)) recent.push({ u, s });
  }

  return (
    <div className="sk-body">
      <div className="sk-head">
        <label className="sk-search">
          <SearchIcon />
          <input
            ref={searchRef} value={query} placeholder="Search skills" aria-label="Search skills" autoComplete="off" spellCheck={false}
            onChange={(e) => editQuery(e.currentTarget.value)} onKeyDown={onSearchKey}
          />
          {query && <button type="button" className="sk-x" aria-label="Clear search" title="Clear" onClick={() => { editQuery(''); searchRef.current?.focus(); }}>×</button>}
        </label>
        <div className="sk-sugrow">
          <button type="button" className="sk-suggest" onClick={() => suggest()} disabled={!sessionId} aria-disabled={busy} aria-busy={busy && !sug?.deep}>
            <SparkIcon />{busy && !sug?.deep ? 'Suggesting…' : 'Suggest skills'}
          </button>
          <button type="button" className="sk-suggest" onClick={toggleDeep} disabled={!sessionId} aria-expanded={deepOpen} aria-controls={deepId}>
            <DeepIcon />Describe and search deeper
          </button>
          <span className="sk-note">{sessionId ? 'Reads your draft and this chat' : 'Open a session to get suggestions'}</span>
        </div>
        {deepOpen && sessionId && (
          <form className="sk-deep" id={deepId} onSubmit={searchDeep}>
            <textarea
              ref={noteRef} value={note} rows={3} aria-label="What you want to do" placeholder="What are you trying to do? E.g. a settings panel with toggles that feels native on phones"
              onChange={(e) => setNote(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) searchDeep(e); }}
            />
            <div className="sk-drow">
              <DeepSwitch k="skillsDeepRecent" label="Recent messages" />
              <DeepSwitch k="skillsDeepSummary" label="Session summary" />
              <button type="submit" className="sk-add wide sk-push" disabled={!note.trim()} aria-disabled={busy}>Search deeper</button>
            </div>
            <div className="sk-note">Reads the full description of every skill, then opens the best candidates. It can take a minute.</div>
          </form>
        )}
      </div>
      <div className="sk-scroll" ref={scrollRef}>
        <Reveal ready={!!tree} shape={SHAPE} label="Loading skills…" done="Skills loaded" sample={SAMPLE}>
          <OrganizePanel org={org} pending={unsorted} sessionId={sessionId} account={account} />
          {showSug && (
            <section className="sk-sug" aria-label="Suggested skills">
              {busy && sug.deep ? (
                <DeepSteps step={sug.deep.step} count={catalog?.skills.length ?? 0} onStop={stop} />
              ) : (
                <>
                  <div className="sk-gh">
                    <span>{sug.deep ? 'Best fits for what you described' : 'Suggested for this chat'}</span>
                    {!busy && <button type="button" className="sk-x" aria-label="Dismiss suggestions" title="Dismiss" onClick={() => sessionId && putSug(sessionId, { busy: false, picks: null, error: null })}>×</button>}
                  </div>
                  {sug.deep && !busy && !sug.error && <div className="sk-used">Used: {usedLine(sug.deep)}</div>}
                </>
              )}
              {busy ? (
                !sug.deep && <BusyLine count={catalog?.skills.length ?? 0} onStop={stop} />
              ) : sug.error ? (
                <div className="sk-err" role="alert">{sug.error}<button type="button" className="sk-link" onClick={() => suggest(sug.deep)}>Try again</button></div>
              ) : picks?.length ? (
                picks.map((p) => {
                  const s = tree!.byKey.get(p.key)!;
                  return (
                    <SkillRow key={p.key} s={s} tag={tagOf(tree!.origins.get(s.origin))} why={p.why} kids={kidsOf(s)} onOpen={() => openSkill(s.key)}>
                      <AddBtn s={s} added={added(s)} onToggle={onToggle} />
                    </SkillRow>
                  );
                })
              ) : (
                <div className="sk-empty">{sug.deep ? 'No skill fits what you described.' : 'No skill stands out for this chat.'}</div>
              )}
            </section>
          )}
          {recent.length > 0 && (
            <section className="sk-recent" aria-label="Recent skills">
              <div className="sk-gh"><span>Recent</span></div>
              {recent.map(({ u, s }) => (
                <div key={u.id} className="sk-item sk-rec">
                  <button type="button" className="sk-row" onClick={() => openSkill(s.key)}>
                    <span className="sk-nm">{s.name}</span>
                    <small>{s.desc || 'No description'}</small>
                    <span className="sk-when">{ago(u.last, now)}</span>
                  </button>
                  <button type="button" className="sk-x" aria-label={`Remove ${s.name} from Recent`} title="Remove from Recent" onClick={() => forget(s, u.id)}>×</button>
                </div>
              ))}
            </section>
          )}
          {!results && tree && (
            <nav className="sk-crumbs" aria-label="Skill folders">
              {stack.length > 0 && (
                <button type="button" className="sk-back" aria-label="Back" title="Back" onClick={() => go(stack.slice(0, -1), 'back')}><Chev /></button>
              )}
              {[null, ...stack].map((n, i) =>
                i === stack.length ? (
                  <span key={i} className="sk-cur" aria-current="page">{n ? crumbLabel(n) : rootLabel}</span>
                ) : (
                  <span key={i} className="sk-crumb">
                    <button type="button" onClick={() => go(stack.slice(0, i), 'back')}>{n ? crumbLabel(n) : rootLabel}</button>
                    <span className="sk-sep" aria-hidden="true">/</span>
                  </span>
                ),
              )}
              {atRoot && <span className="sk-push"><Seg small label="Group skills by" value={group} options={GROUPS} onPick={pickGroup} /></span>}
            </nav>
          )}
          <div className="sk-view" key={results ? 'search' : (searching ? 'found>' : '') + stack.map((n) => (n.kind === 'family' ? n.prefix : n.key)).join('>')} data-dir={results ? 'none' : dir}>
            {body}
          </div>
        </Reveal>
      </div>
    </div>
  );
}
