import { useRef, useState } from 'react';
import type { UpdateStatus, UpdateStep } from '../../server/protocol.ts';
import { Check, FOSI, XIcon, reduceMotion } from './bits.tsx';
import { useStore } from './store.ts';
import { ACTIVE_STEPS, closeUpdated, doneRun, failedRun, isActive, startUpdate, updateLater, useUpdate } from './releases.ts';

export const STEP_TEXT: Record<UpdateStep, string> = {
  downloading: 'Downloading…',
  installing: 'Installing…',
  checking: 'Checking that it starts…',
  restarting: 'Restarting…',
  done: 'Done',
  failed: 'Failed',
};
const STEP_NAME: Record<string, string> = { downloading: 'Download', installing: 'Install and build', checking: 'Test start', restarting: 'Restart' };

const LinkIcon = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 2.5h5v5M9.5 2.5 3 9" /></svg>
);

export const notesUrl = (s: UpdateStatus, tag: string) => (s.latest?.tag === tag ? s.latest.url : `https://github.com/${s.repo}/releases/tag/${tag}`);

// Sessions a restart would stop: turns in progress and background agents.
export const useBusySessions = () => useStore((s) => s.roster.reduce((n, r) => n + (r.state === 'working' || r.background ? 1 : 0), 0));
export const busyText = (n: number) => (n === 1 ? '1 session is working; the restart stops it.' : `${n} sessions are working; the restart stops them.`);

// The four steps of a run: finished ones keep their check, the current one names what it does.
export function UpdateSteps({ step }: { step: UpdateStep }) {
  const at = ACTIVE_STEPS.indexOf(step);
  return (
    <ol className="upd-steps">
      {ACTIVE_STEPS.map((k, i) => (
        <li key={k} data-s={i < at ? 'done' : i === at ? 'now' : 'next'} aria-current={i === at ? 'step' : undefined}>
          <span className="upd-mk" aria-hidden="true">{i < at ? <Check /> : i === at ? <span className="spin"></span> : null}</span>
          {i === at ? STEP_TEXT[k] : STEP_NAME[k]}
        </li>
      ))}
    </ol>
  );
}

type Kind = 'offer' | 'failed' | 'active' | 'done';

// A small card under the gear: a newer release, an update in progress, or the one that just finished. Never blocks the app.
export function UpdateNotice() {
  const s = useUpdate((x) => x.status);
  const later = useUpdate((x) => x.later);
  const seen = useUpdate((x) => x.seen);
  const busy = useBusySessions();
  const ref = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  if (!s) return null;

  const active = isActive(s.run) ? s.run : null;
  const done = doneRun(s);
  const failed = failedRun(s);
  const offered = s.available && s.latest && later !== s.latest.tag ? s.latest : null;
  const kind: Kind | null = active ? 'active' : done && seen !== done.tag ? 'done' : offered ? (failed ? 'failed' : 'offer') : null;
  if (!kind) return null;

  // Leaves faster than it came, then hides for good.
  const leave = (commit: () => void) => {
    if (leaving) return;
    setLeaving(true);
    const el = ref.current;
    const end = () => {
      setLeaving(false);
      commit();
    };
    if (!el) return end();
    const to = reduceMotion() ? { opacity: 0 } : { opacity: 0, transform: 'translateY(-4px) scale(.98)' };
    el.animate([{ opacity: 1, transform: 'none' }, to], { duration: 140, easing: FOSI, fill: 'forwards' }).finished.then(end, end);
  };

  const tag = active?.tag ?? done?.tag ?? offered!.tag;
  const title = kind === 'active' ? `Updating to ${tag}` : kind === 'done' ? `Updated to ${tag}` : kind === 'failed' ? `Update to ${tag} failed` : `tarcsweb ${tag} is available`;
  const sub = kind === 'active' ? null
    : kind === 'done' ? "You're on the new version."
    : kind === 'failed' ? `${failed!.message || 'It stopped early.'} You're still on v${s.current}.`
    : !s.canUpdate ? s.why
    : busy ? busyText(busy)
    : `You have v${s.current}. The app restarts to finish.`;

  return (
    <div className="upd" ref={ref} data-kind={kind} role="status" aria-busy={kind === 'active'}>
      <div className="upd-head">
        <span className="upd-dot" aria-hidden="true"></span>
        <b>{title}</b>
        {kind === 'done' && (
          <button type="button" className="upd-x" aria-label="Close" title="Close" onClick={() => leave(() => closeUpdated(tag))}><XIcon /></button>
        )}
      </div>
      {kind === 'active' ? (
        <p className="upd-sub upd-now"><span className="spin" aria-hidden="true"></span>{STEP_TEXT[active!.step]}<span className="upd-of">{ACTIVE_STEPS.indexOf(active!.step) + 1} of 4</span></p>
      ) : sub && <p className={`upd-sub${kind === 'failed' ? ' bad' : ''}`}>{sub}</p>}
      {kind !== 'active' && (
        <div className="upd-acts">
          <a className="upd-link" href={notesUrl(s, tag)} target="_blank" rel="noreferrer">What's new<LinkIcon /></a>
          {kind !== 'done' && <button type="button" className="upd-ghost" onClick={() => leave(() => updateLater(tag))}>Later</button>}
          {kind !== 'done' && s.canUpdate && (
            <button type="button" className="upd-go" onClick={() => startUpdate(tag)}>{kind === 'failed' ? 'Try again' : 'Update'}</button>
          )}
        </div>
      )}
    </div>
  );
}
