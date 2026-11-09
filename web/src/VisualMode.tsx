import { useId, useState } from 'react';
import { ROUND_CANCELLED, type RichDetail, type VisualKind, type VisualModeAnswer, type VisualWhere } from '../../server/protocol.ts';
import { pickChoiceLocal, useStore, type RichItem } from './store.ts';
import { send } from './socket.ts';

const NOUN: Record<VisualKind, string> = { render_ui: 'picture', ask_prototype: 'prototype', replay: 'replay' };
const WHERE: Record<VisualWhere, string> = { here: 'In the conversation', background: 'In the background' };
// Ticked "Remember" boxes survive a remount or session switch until the card is answered; oldest dropped past the cap.
const ticked = new Set<string>();
const TICKED_MAX = 20;

function VisualModeDone({ id, what, answer, fresh }: { id: string; what: string; answer: VisualModeAnswer | null; fresh: boolean }) {
  return (
    <div className={`say old aqd rnd-done${fresh ? ' in' : ''}`} data-id={id}>
      <div className="rnd-t">
        {what} · {answer ? <b className="pick">{WHERE[answer.where]}</b> : <span className="pick-none">Not answered</span>}
        {answer?.figure !== undefined && <> · <b className="pick">{answer.figure ? 'With 3D figure' : 'No 3D figure'}</b></>}
        {/* The local pick has no saved yet; the server's result says whether the config file took it. */}
        {answer?.remember && <span className="pick-none" role="status"> · {answer.saved === undefined ? 'Saving…' : answer.saved ? 'Saved in Settings' : 'Not saved'}</span>}
      </div>
      {answer?.saveError && <div className="rnd-err">{answer.saveError}</div>}
    </div>
  );
}

// visual_mode: pick where the next visual is built; the box saves the pick as the Build visuals setting.
export function VisualMode({ item }: { item: RichItem }) {
  const mode = (item.detail as Extract<RichDetail, { kind: 'visual-mode' }>).mode;
  const sessionId = useStore((s) => s.current);
  const [remember, setRemember] = useState(() => ticked.has(item.id));
  const [figure, setFigure] = useState(false);
  const [fresh, setFresh] = useState(false);
  const qid = useId();
  const noun = NOUN[mode.visual] ?? 'visual';
  const what = mode.title ? `The ${noun} “${mode.title}”` : `The ${noun}`;
  const r = item.result;
  if (r) return <VisualModeDone id={item.id} what={what} answer={r.error ? null : (r.visualMode ?? null)} fresh={fresh && r.error !== ROUND_CANCELLED} />;

  const flip = (on: boolean) => {
    setRemember(on);
    ticked.delete(item.id);
    if (on) ticked.add(item.id);
    if (ticked.size > TICKED_MAX) ticked.delete(ticked.values().next().value!);
  };
  const pick = (where: VisualWhere, withFigure = figure) => {
    if (!sessionId) return;
    const answer = { where, remember: !mode.fixed && remember, ...(mode.figure ? { figure: withFigure } : {}) };
    if (!send({ type: 'visual-mode-answer', sessionId, id: item.id, ...answer })) return;
    ticked.delete(item.id);
    setFresh(true);
    pickChoiceLocal(item.id, answer);
  };

  // Where is saved in Settings, so the card only asks about the offered figure.
  if (mode.fixed) {
    const where = mode.fixed;
    return (
      <div className="frame choice aq vmd" data-id={item.id} role="group" aria-labelledby={qid} onKeyDown={(e) => e.stopPropagation()}>
        <div className="vmd-body">
          <p className="vmd-q" id={qid}>Use an isometric 3D figure in {mode.title ? <>the {noun} <b>“{mode.title}”</b></> : `the ${noun}`}?</p>
          <p className="vmd-s">It explains the idea as a small 3D object. Built {where === 'here' ? 'in the conversation' : 'in the background'}, as set in Settings.</p>
        </div>
        <div className="cf">
          <span className="rnd-acts">
            <button type="button" className="vmd-b" onClick={() => pick(where, false)}>Without figure</button>
            <button type="button" className="vmd-b" onClick={() => pick(where, true)}>With 3D figure</button>
          </span>
        </div>
      </div>
    );
  }

  return (
    // Keeps Enter and Space here from also answering a permission or sending the composer.
    <div className="frame choice aq vmd" data-id={item.id} role="group" aria-labelledby={qid} onKeyDown={(e) => e.stopPropagation()}>
      <div className="vmd-body">
        <p className="vmd-q" id={qid}>Build {mode.title ? <>the {noun} <b>“{mode.title}”</b></> : `the ${noun}`} here or in the background?</p>
        <p className="vmd-s">In the background, a subagent builds it and the chat stays free.</p>
        {mode.figure && (
          <label className="vmd-rm vmd-fig">
            <input type="checkbox" checked={figure} onChange={(e) => setFigure(e.target.checked)} />
            Use an isometric 3D figure
          </label>
        )}
      </div>
      <div className="cf">
        <label className="vmd-rm">
          <input type="checkbox" checked={remember} onChange={(e) => flip(e.target.checked)} />
          Remember my choice
        </label>
        <span className="rnd-acts">
          <button type="button" className="vmd-b" onClick={() => pick('here')}>Build it here</button>
          <button type="button" className="vmd-b" onClick={() => pick('background')}>Build in background</button>
        </span>
      </div>
    </div>
  );
}
