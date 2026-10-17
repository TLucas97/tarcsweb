import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { onSkills, send } from '../socket.ts';
import { currentSummary, useStore } from '../store.ts';
import { useClaudeReady } from '../setup.ts';
import { isNarrow } from '../narrow.ts';
import { Chev, CopyBtn } from '../bits.tsx';
import type { SkillCatalog, SkillInfo, SkillOrigin, SkillOriginKind, SkillPick } from '../../../server/protocol.ts';
import type { SkillRef } from './ref.tsx';

// picks is null until an answer came (or after dismissing it).
type Sug = { busy: boolean; picks: SkillPick[] | null; error: string | null };
const SUG_MAX = 20;
// Organize is one run per client, so its state is not per session.
type Org = { phase: 'idle' | 'confirm' | 'running' | 'done' | 'error'; done: number; total: number; found: number; checked: number; error: string | null };
const ORG_IDLE: Org = { phase: 'idle', done: 0, total: 0, found: 0, checked: 0, error: null };
const useSk = create<{ catalog: SkillCatalog | null; sug: Record<string, Sug>; org: Org }>(() => ({ catalog: null, sug: {}, org: ORG_IDLE }));
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
  if (m.type === 'skills') return useSk.setState({ catalog: m.catalog });
  const running = useSk.getState().org.phase === 'running';
  if (m.type === 'skills-organize-progress') return void (running && setOrg({ done: m.done, total: m.total }));
  if (m.type === 'skills-organized') {
    if (running) setOrg(m.error ? { phase: 'error', error: m.error, found: m.found, checked: m.checked } : { phase: 'done', found: m.found, checked: m.checked, error: null });
    return;
  }
  if (useSk.getState().sug[m.sessionId]?.busy) putSug(m.sessionId, { busy: false, picks: m.picks, error: m.error ?? null });
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
        <p>Reads the start of {plural(pending, 'skill')} with your {account} account to find who wrote them. No skill file is changed; tarcsweb only saves what it finds for itself.</p>
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
          <span>{org.found ? `Found authors for ${plural(org.found, 'skill')}` : `No authors named in the ${plural(org.checked, 'skill')} read`}</span>
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

type Level = { families: { prefix: string; skills: SkillInfo[] }[]; singles: SkillInfo[]; total: number };
type Tree = { origins: Map<string, SkillOrigin>; byKey: Map<string, SkillInfo>; children: Map<string, SkillInfo[]>; levels: Map<string, Level>; familyOf: Map<string, string> };

const push = <T,>(m: Map<string, T[]>, k: string, v: T) => void (m.get(k) ?? m.set(k, []).get(k)!).push(v);
const prefixOf = (name: string) => name.split(/[-_:]/)[0].toLowerCase();
const byName = (a: SkillInfo, b: SkillInfo) => a.name.localeCompare(b.name);

// Origin, then a family folder when 2+ skills share a name prefix (gsap-*), unless that would be the whole origin.
const trees = new WeakMap<SkillCatalog, Tree>();
function treeOf(c: SkillCatalog): Tree {
  const hit = trees.get(c);
  if (hit) return hit;
  const children = new Map<string, SkillInfo[]>();
  const tops = new Map<string, SkillInfo[]>();
  for (const s of c.skills) push(s.parent ? children : tops, s.parent ?? s.origin, s);
  const levels = new Map<string, Level>();
  const familyOf = new Map<string, string>();
  for (const o of c.origins) {
    const list = tops.get(o.key) ?? [];
    const groups = new Map<string, SkillInfo[]>();
    for (const s of list) push(groups, prefixOf(s.name), s);
    const level: Level = { families: [], singles: [], total: list.length };
    for (const [prefix, skills] of groups) {
      if (skills.length >= 2 && skills.length < list.length) {
        level.families.push({ prefix, skills: skills.sort(byName) });
        for (const s of skills) familyOf.set(s.key, prefix);
      } else level.singles.push(...skills);
    }
    level.families.sort((a, b) => a.prefix.localeCompare(b.prefix));
    level.singles.sort(byName);
    levels.set(o.key, level);
  }
  const t: Tree = { origins: new Map(c.origins.map((o) => [o.key, o])), byKey: new Map(c.skills.map((s) => [s.key, s])), children, levels, familyOf };
  trees.set(c, t);
  return t;
}

type Nav = { kind: 'origin'; key: string } | { kind: 'family'; origin: string; prefix: string } | { kind: 'skill'; key: string };

// Where a skill lives, as the breadcrumb shows it.
function pathTo(t: Tree, key: string): Nav[] {
  const s = t.byKey.get(key);
  if (!s) return [];
  if (s.parent) return [...pathTo(t, s.parent), { kind: 'skill', key }];
  const fam = t.familyOf.get(key);
  return [{ kind: 'origin', key: s.origin }, ...(fam ? [{ kind: 'family' as const, origin: s.origin, prefix: fam }] : []), { kind: 'skill', key }];
}

// The longest start of nav that still exists, so a catalog refresh never leaves a dead view.
function validNav(t: Tree, nav: Nav[]) {
  const ok = (n: Nav) => (n.kind === 'skill' ? t.byKey.has(n.key) : n.kind === 'origin' ? t.levels.has(n.key) : !!t.levels.get(n.origin)?.families.some((f) => f.prefix === n.prefix));
  const i = nav.findIndex((n) => !ok(n));
  return i < 0 ? nav : nav.slice(0, i);
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

type Props = { sessionId: string | null; open: boolean; chips: SkillRef[]; onToggle: (r: SkillRef) => void; draft: () => string; slashOn: boolean };

export default function Library({ sessionId, open, chips, onToggle, draft, slashOn }: Props) {
  const catalog = useSk((s) => s.catalog);
  const sug = useSk((s) => (sessionId ? s.sug[sessionId] : undefined));
  const org = useSk((s) => s.org);
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
    setNav(pathTo(tree, key));
    setDir('in');
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  const editQuery = (q: string) => {
    setQuery(q);
    setFound([]);
    setDir('none');
  };

  const busy = !!sug?.busy;
  const suggest = () => {
    if (!sessionId || busy) return;
    editQuery('');
    putSug(sessionId, { busy: true, picks: null, error: null });
    if (!send({ type: 'skills-suggest', sessionId, draft: draft() })) putSug(sessionId, { busy: false, picks: null, error: 'Not connected to the server' });
  };
  const stop = () => {
    if (!sessionId) return;
    send({ type: 'skills-suggest-stop' });
    putSug(sessionId, { busy: false, picks: null, error: null });
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

  const crumbLabel = (n: Nav) => (n.kind === 'origin' ? tree?.origins.get(n.key)?.label : n.kind === 'family' ? n.prefix : tree?.byKey.get(n.key)?.name) ?? '';
  const rootLabel = searching ? `Results for “${query.trim()}”` : 'All skills';
  const last = stack[stack.length - 1];

  let body: ReactNode;
  if (!catalog || !tree) body = <div className="sk-wait" role="status">Loading skills…</div>;
  else if (results) {
    body = results.length ? (
      results.map((s) => <SkillRow key={s.key} s={s} tag={tagOf(tree.origins.get(s.origin))} kids={kidsOf(s)} onOpen={() => openFound(s.key)} />)
    ) : (
      <div className="sk-empty">No skill matches “{query.trim()}”</div>
    );
  } else if (!last) {
    body = catalog.origins.length ? (
      <>
        {catalog.origins.map((o) => <FolderRow key={o.key} label={o.label} sub={SUB[o.kind]} count={tree.levels.get(o.key)?.total ?? 0} onOpen={() => go([{ kind: 'origin', key: o.key }], 'in')} />)}
        {catalog.authorsPending > 0 && org.phase === 'idle' && (
          <div className="sk-orgrow">
            <button type="button" className="sk-suggest" onClick={() => setOrg({ ...ORG_IDLE, phase: 'confirm' })}>Organize skills</button>
            <span className="sk-note">{plural(catalog.authorsPending, 'skill')} without an author</span>
          </div>
        )}
      </>
    ) : (
      <div className="sk-empty">No skills found in ~/.claude/skills, plugins or ~/.codex/skills</div>
    );
  } else if (last.kind === 'origin') {
    const level = tree.levels.get(last.key)!;
    body = (
      <>
        {level.families.map((f) => <FolderRow key={f.prefix} label={f.prefix} count={f.skills.length} onOpen={() => go([...nav, { kind: 'family', origin: last.key, prefix: f.prefix }], 'in')} />)}
        {level.singles.map((s) => <SkillRow key={s.key} s={s} kids={kidsOf(s)} onOpen={() => go([...nav, { kind: 'skill', key: s.key }], 'in')} />)}
      </>
    );
  } else if (last.kind === 'family') {
    const fam = tree.levels.get(last.origin)!.families.find((f) => f.prefix === last.prefix)!;
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
          <button type="button" className="sk-suggest" onClick={suggest} disabled={!sessionId} aria-disabled={busy} aria-busy={busy}>
            <SparkIcon />{busy ? 'Suggesting…' : 'Suggest skills'}
          </button>
          <span className="sk-note">{sessionId ? 'Reads your draft and this chat' : 'Open a session to get suggestions'}</span>
        </div>
      </div>
      <div className="sk-scroll" ref={scrollRef}>
        <OrganizePanel org={org} pending={catalog?.authorsPending ?? 0} sessionId={sessionId} account={account} />
        {showSug && (
          <section className="sk-sug" aria-label="Suggested skills">
            <div className="sk-gh">
              <span>Suggested for this chat</span>
              {!busy && <button type="button" className="sk-x" aria-label="Dismiss suggestions" title="Dismiss" onClick={() => sessionId && putSug(sessionId, { busy: false, picks: null, error: null })}>×</button>}
            </div>
            {busy ? (
              <BusyLine count={catalog?.skills.length ?? 0} onStop={stop} />
            ) : sug.error ? (
              <div className="sk-err" role="alert">{sug.error}<button type="button" className="sk-link" onClick={suggest}>Try again</button></div>
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
              <div className="sk-empty">No skill stands out for this chat.</div>
            )}
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
          </nav>
        )}
        <div className="sk-view" key={results ? 'search' : (searching ? 'found>' : '') + stack.map((n) => (n.kind === 'family' ? n.prefix : n.key)).join('>')} data-dir={results ? 'none' : dir}>
          {body}
        </div>
      </div>
    </div>
  );
}
