import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { DiffDetail } from '../../server/protocol.ts';
import { groupTools, lastRow, useStore, type ToolItem } from './store.ts';
import { send } from './socket.ts';
import { markOutputLoading, outKey, useToolOutput } from './toolOutput.ts';
import { FxBtn } from './Focus.tsx';
import { fenced, SendTextBtn } from './SendToChat.tsx';
import { ToolImage } from './LocalImage.tsx';
import { RecVideo } from './browser/Video.tsx';
import { Led } from './led.tsx';
import { MidCut } from './bits.tsx';
import { release } from './convWindow.ts';
import { heavy } from './perf.ts';

const ChevSmall = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5l-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

// Unified diff without hunk headers: the card keeps only the changed lines and their context, not line numbers.
function diffText(d: DiffDetail) {
  const body = [`--- ${d.created ? '/dev/null' : `a/${d.path}`}`, `+++ b/${d.path}`, ...d.lines.map(([k, t]) => `${k}${t}`), ...(d.more > 0 ? [`… ${d.more} more lines`] : [])];
  return `Diff of ${d.path} (+${d.add} −${d.rm}):\n${fenced(body.join('\n'), 'diff')}`;
}

// The mockup's file diff frame; tag says whether the change landed.
export function DiffFrame({ d, state }: { d: DiffDetail; state: 'applied' | 'failed' | null }) {
  return (
    <div className="frame dframe">
      <div className="fh">
        <span className="n mono">{d.path}</span>
        <span className="mono add">+{d.add}</span>
        <span className="mono rm">−{d.rm}</span>
        {state && <span className={`tag${state === 'failed' ? ' bad' : ''}`}>{state}</span>}
        <SendTextBtn text={() => diffText(d)} what="the diff" />
        <FxBtn label={d.path} />
      </div>
      <div className="diff mono">
        {d.lines.map(([k, t], i) => (
          <div key={i} className={k === '-' ? 'm' : k === '+' ? 'p' : 'c'}>{k === ' ' ? '  ' : `${k} `}{t}</div>
        ))}
        {d.more > 0 && <div className="c">  … {d.more} more lines</div>}
      </div>
    </div>
  );
}

type Cat = 'read' | 'edit' | 'run' | 'search' | 'other';
const catOf = (verb: string): Cat => (verb === 'read' ? 'read' : verb === 'edit' || verb === 'write' ? 'edit' : verb === 'run' || verb === 'background' ? 'run' : verb === 'search' ? 'search' : 'other');
// The folded summary only breathes: open rows carry the marker, and the Working line below plays the activity.
const LiveLed = ({ label = 'Running' }: { label?: string }) => (
  <span className="tled" role="img" aria-label={label}><Led size="sm" pattern="calm" /></span>
);

const GLYPHS = '░▒▓/\\<>+=*#%&@$0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const noise = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];
// Matches the .scr-o glow animation in styles.css.
const GLOW_MS = 650;

// A call that arrives during the turn resolves from noise into its text, then glows out.
// The real text stays underneath, hidden, so layout, copy and screen readers never see the noise.
function scrambleIn(el: HTMLElement): (() => void) | undefined {
  const text = el.textContent ?? '';
  if (heavy() || !text) return;
  const o = document.createElement('span');
  o.className = 'scr-o';
  o.ariaHidden = 'true';
  o.style.color = getComputedStyle(el).color;
  const cells = [...text.slice(0, 160)].map((ch, i) => {
    const c = o.appendChild(document.createElement('i'));
    c.textContent = ch === ' ' ? ' ' : noise();
    return { c, ch, left: 2 + ((Math.random() * 6) | 0) + Math.min((i / 4) | 0, 8) };
  });
  el.classList.add('scr');
  el.style.color = 'transparent';
  el.append(o);
  let pending = cells.length;
  let glow = 0;
  const done = () => {
    clearInterval(tick);
    clearTimeout(glow);
    o.remove();
    el.classList.remove('scr');
    el.style.color = '';
  };
  const tick = setInterval(() => {
    for (const x of cells) {
      if (x.left <= 0) continue;
      if (--x.left) {
        if (x.ch !== ' ') x.c.textContent = noise();
        continue;
      }
      x.c.textContent = x.ch;
      x.c.dataset.c = x.ch;
      x.c.className = 'on';
      pending--;
    }
    if (pending) return;
    clearInterval(tick);
    glow = window.setTimeout(done, GLOW_MS);
  }, 40);
  return done;
}

// The call still running reads in the present tense, so a long command never looks finished.
function liveOf(t: ToolItem, more: number): ReactNode {
  const cat = catOf(t.verb);
  const lead = t.result
    ? cat === 'run' ? 'Ran' : cat === 'read' ? 'Read' : cat === 'edit' ? (t.verb === 'write' ? 'Wrote' : 'Edited') : cat === 'search' ? 'Searched' : 'Used'
    : cat === 'run' ? 'Running' : cat === 'read' ? 'Reading' : cat === 'edit' ? (t.verb === 'write' ? 'Writing' : 'Editing') : cat === 'search' ? 'Searching' : 'Using';
  return <span className="live">{lead} <span className="mono t1">{cat === 'other' ? t.verb : t.summary}</span>{more > 0 && ` and ${more} more`}</span>;
}

// "Read 6 files · Edited 2 · Ran pnpm lint", in the order the calls happened.
// tail: the newest call while the turn works on this list, named last instead of counted.
function summaryOf(tools: ToolItem[], tail?: ToolItem): ReactNode[] {
  const pending = tail ? tools.filter((t) => !t.result) : [];
  const failed = tools.filter((t) => t.result?.error).length;
  if (tail) tools = tools.filter((t) => t.result && t !== tail);
  const cats = new Map<Cat, ToolItem[]>();
  for (const t of tools) cats.set(catOf(t.verb), [...(cats.get(catOf(t.verb)) ?? []), t]);
  const parts: ReactNode[] = [];
  const one = (lead: string, t: ToolItem) => (
    <>{lead} {catOf(t.verb) === 'read' || catOf(t.verb) === 'edit' ? <MidCut text={t.summary} className="mono t1" /> : <span className="mono t1">{t.summary}</span>}</>
  );
  for (const [cat, list] of cats) {
    const n = list.length;
    const t = list[0];
    // Files count once however many calls touched them.
    const files = new Set(list.map((x) => x.summary)).size;
    if (cat === 'read') parts.push(files === 1 ? one('Read', t) : `Read ${files} files`);
    else if (cat === 'edit') {
      const add = list.reduce((k, x) => k + (x.diff?.add ?? 0), 0);
      const rm = list.reduce((k, x) => k + (x.diff?.rm ?? 0), 0);
      const lead = list.every((x) => x.verb === 'write') ? 'Wrote' : 'Edited';
      parts.push(files === 1 ? <>{one(lead, t)} <span className="mono add">+{add}</span> <span className="mono rm">−{rm}</span></> : `Edited ${files}`);
    } else if (cat === 'run') parts.push(n === 1 ? one('Ran', t) : `Ran ${n} commands`);
    else if (cat === 'search') parts.push(n === 1 ? one('Searched', t) : `Searched ${n} times`);
    else parts.push(n === 1 ? <>Used <span className="mono t1">{t.verb}</span></> : `Used ${n} tools`);
  }
  if (failed) parts.push(<span className="rm">{failed} failed</span>);
  // Idle with calls still open: the turn ended (stop, crash) before they answered.
  const stopped = tail ? 0 : tools.filter((t) => !t.result).length;
  if (stopped) parts.push(<span className="tst">{stopped} stopped</span>);
  if (tail) parts.push(liveOf(tail, pending.filter((t) => t !== tail).length));
  return parts.flatMap((p, i) => (i ? [<span key={`s${i}`} className="sep2"> · </span>, <span key={i}>{p}</span>] : [<span key={i}>{p}</span>]));
}

// A command's outcome on its own row, so a finished one never reads like it is still going.
// A background command follows its job in the Processes list, which answers long after the call.
function RunState({ t, live }: { t: ToolItem; live: boolean }) {
  const job = useStore((s) => (t.verb === 'background' && s.current ? s.panelIdx[s.current]?.procs[t.id] : undefined));
  if (live) return null;
  if (!t.result) return <span className="tst">stopped</span>;
  if (t.result.error || job === 'failed') return <span className="tst bad">failed</span>;
  if (job === 'stopped') return <span className="tst">stopped</span>;
  if (t.verb === 'background' && job !== 'done') return <span className="tst">{job === 'running' ? 'running · see Processes' : 'see Processes'}</span>;
  return (
    <span className="tst ok" aria-label="Done" title="Done">
      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 6.5 2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  );
}

// A failed command's last output lines, loaded from the server on the first open.
function FailedOutput({ id, command }: { id: string; command: string }) {
  const sid = useStore((s) => s.current);
  const key = sid ? outKey(sid, id) : '';
  const out = useToolOutput((s) => s[key]);
  const connected = useStore((s) => s.connected);
  // A reply lost to a reconnect asks again once the socket is back.
  useEffect(() => {
    const had = useToolOutput.getState()[key];
    if (!sid || !connected || (had && had !== 'loading')) return;
    if (send({ type: 'tool-output-load', sessionId: sid, id })) markOutputLoading(key);
  }, [key, connected]);
  if (!out || out === 'loading') return <div className="tout-note">Loading output…</div>;
  if (!out.lines) return <div className="tout-note">The full output is no longer kept.</div>;
  const lines = out.lines;
  const text = () => `Failed command:\n${fenced(`$ ${command}`, 'sh')}\n${out.more ? `Last ${lines.length} lines of output` : 'Output'}:\n${fenced(lines.join('\n'))}`;
  return (
    <>
      <div className="tout-note">
        {out.more ? `Last ${lines.length} lines` : 'Output'}
        <SendTextBtn text={text} what="the command and its output" className="btnx stc-txt tout-btn" />
      </div>
      <pre className="tout">{lines.join('\n')}</pre>
    </>
  );
}

function ToolRow({ t, live, fresh }: { t: ToolItem; live: boolean; fresh: boolean }) {
  const [open, setOpen] = useState(false);
  const li = useRef<HTMLLIElement>(null);
  // Mount only, and only while the list is open; a folded list scrambles its summary instead.
  useEffect(() => {
    const el = li.current?.querySelector<HTMLElement>('.s');
    if (fresh && el && li.current?.closest('details')?.open) return scrambleIn(el);
  }, []);
  const [showOut, setShowOut] = useState(false);
  // Where the clicked row sat; the diff opening or closing below it must not move it on screen.
  const held = useRef<{ el: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const h = held.current;
    held.current = null;
    if (!h) return;
    const dy = h.el.getBoundingClientRect().top - h.top;
    const conv = h.el.closest<HTMLElement>('.conv');
    if (conv && Math.abs(dy) >= 1) conv.scrollTop += dy;
  }, [open]);
  const toggle = (el: HTMLElement) => {
    release();
    held.current = { el, top: el.getBoundingClientRect().top };
    setOpen(!open);
  };
  const d = t.diff;
  const err = t.result?.error;
  const run = catOf(t.verb) === 'run';
  const file = catOf(t.verb) === 'read' || catOf(t.verb) === 'edit';
  // Only failed live commands carry a brief, and only those keep their output on the server.
  const brief = err ? t.result?.brief : undefined;
  return (
    <li ref={li} className={err ? 'bad' : live ? 'live' : undefined} aria-current={live ? 'step' : undefined} data-id={t.id}>
      {d ? (
        <button className="trow" aria-expanded={open} onClick={(e) => toggle(e.currentTarget)} title={open ? 'Hide the diff' : 'Show the diff'}>
          <span className="v">{t.verb}</span>{file ? <MidCut text={t.summary} className="s" title={false} /> : <span className="s">{t.summary}</span>}
          <span className="add">+{d.add}</span><span className="rm">−{d.rm}</span><ChevSmall />
        </button>
      ) : (
        <div className="trow">
          <span className="v">{t.verb}</span>{file ? <MidCut text={t.summary} className="s" /> : <span className="s" title={t.summary}>{t.summary}</span>}
          {run && <RunState t={t} live={live} />}
        </div>
      )}
      {err && (
        <div className="terr" title={brief ? err : undefined}>
          {brief || err}
          {run && brief !== undefined && (
            <button type="button" className="btnx tout-btn" aria-expanded={showOut} onClick={() => setShowOut(!showOut)}>{showOut ? 'Hide output' : 'Show output'}</button>
          )}
        </div>
      )}
      {showOut && <FailedOutput id={t.id} command={t.summary} />}
      {t.note && <div className="tnote">{t.note}</div>}
      {open && d && <DiffFrame d={d} state={t.result ? (err ? 'failed' : 'applied') : null} />}
    </li>
  );
}

// The mockup's collapsible tool list: a summary line that opens into one row per call.
export function ToolGroup({ id }: { id: string }) {
  const tools = useStore((s) => groupTools(s, id));
  const working = useStore((s) => s.status === 'working');
  // Error notes sit under the folded summary; an open list shows them under their own row.
  const [open, setOpen] = useState(false);
  // Calls already here when the list mounted (history, remounts) show as they are; later ones scramble in.
  const [born] = useState(() => new Set(tools.map((t) => t.id)));
  const sum = useRef<HTMLSpanElement>(null);
  const last = useStore((s) => s.status === 'working' && lastRow(s)?.id === id);
  const newest = working ? tools.findLast((t) => !t.result) : undefined;
  const busy = !!newest;
  // The newest call stays named until the next one or the turn's next row, so a call that answers at once never blinks in and out.
  const tail = newest ?? (last ? tools.at(-1) : undefined);
  useEffect(() => {
    const el = sum.current?.querySelector<HTMLElement>('.live .t1');
    if (el && !open && tail && !born.has(tail.id)) return scrambleIn(el);
  }, [tail?.id]);
  if (!tools.length) return null;
  return (
    <>
      <details className="acts tlist" data-id={id} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <ChevSmall />
          <span className="sum" ref={sum}>{summaryOf(tools, tail)}</span>
          {tail && <LiveLed />}
        </summary>
        <ul className={busy ? 'mono busy' : 'mono'}>{tools.map((t) => <ToolRow key={t.id} t={t} live={busy && !t.result} fresh={working && !born.has(t.id)} />)}</ul>
      </details>
      {!open && tools.map((t) => t.note && <div key={`n:${t.id}`} className="tnote out"><span className="mono" title={t.summary}>{t.summary}</span>{t.note}</div>)}
      {tools.map((t) => t.result?.img && <div key={t.id} className="timg"><ToolImage src={t.result.img} alt={t.summary} /></div>)}
      {tools.map((t) => t.result?.video && <div key={`v:${t.id}`} className="timg"><RecVideo v={t.result.video} /></div>)}
    </>
  );
}
