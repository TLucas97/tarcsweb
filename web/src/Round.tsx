import { useState, type KeyboardEvent } from 'react';
import type { RichDetail, RoundPick, RoundSpec } from '../../server/protocol.ts';
import { pickChoiceLocal, useStore, type RichItem } from './store.ts';
import { send } from './socket.ts';

const EMPTY: RoundPick = { option: null, note: '' };
// Unsent answers survive a session switch; dropped on submit, oldest first past the cap.
const drafts = new Map<string, RoundPick[]>();
const DRAFTS_MAX = 20;

const isAnswered = (p: RoundPick) => p.option !== null || !!p.note.trim();

// The submitted round as one line per question; history keeps only this form.
function RoundDone({ id, spec, picks, fresh }: { id: string; spec: RoundSpec; picks: RoundPick[] | null; fresh: boolean }) {
  const skipped = !!picks && spec.questions.every((_, i) => !isAnswered(picks[i] ?? EMPTY));
  if (skipped) {
    return (
      <div className={`say old aqd rnd-done${fresh ? ' in' : ''}`} data-id={id}>
        <div className="rnd-t">{spec.title}<span className="pick-none">{spec.title ? ' · ' : ''}Closed to reply in chat</span></div>
      </div>
    );
  }
  return (
    <div className={`say old aqd rnd-done${fresh ? ' in' : ''}`} data-id={id}>
      {(spec.title || !picks) && <div className="rnd-t">{spec.title}{!picks && <span className="pick-none">{spec.title ? ' · ' : ''}Round cancelled</span>}</div>}
      {spec.questions.map((q, i) => {
        const p = picks?.[i] ?? EMPTY;
        const label = p.option !== null ? q.options[p.option]?.label : null;
        const note = p.note.trim();
        return (
          <div key={i}>
            {q.title} <span className="rnd-to" aria-hidden="true">→</span>{' '}
            {label ? <b className="pick">{label}</b> : note ? <b className="pick">{note}</b> : <span className="pick-none">no answer</span>}
            {label && note && <span className="rnd-nt"> · {note}</span>}
          </div>
        );
      })}
    </div>
  );
}

// ask_round: up to 5 questions answered together and sent with one click.
export function Round({ item }: { item: RichItem }) {
  const spec = (item.detail as Extract<RichDetail, { kind: 'round' }>).round;
  const sessionId = useStore((s) => s.current);
  const [picks, setPicks] = useState<RoundPick[]>(() => drafts.get(item.id) ?? spec.questions.map(() => EMPTY));
  const [fresh, setFresh] = useState(false);
  const r = item.result;
  if (r) return <RoundDone id={item.id} spec={spec} picks={r.error ? null : (r.round ?? null)} fresh={fresh} />;

  const update = (next: RoundPick[]) => {
    setPicks(next);
    drafts.delete(item.id);
    drafts.set(item.id, next);
    if (drafts.size > DRAFTS_MAX) drafts.delete(drafts.keys().next().value!);
  };
  const setAt = (i: number, patch: Partial<RoundPick>) => update(picks.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const recs = spec.questions.filter((q) => q.recommended !== null).length;
  const allRec = recs > 0 && spec.questions.every((q, i) => q.recommended === null || picks[i].option === q.recommended);
  const acceptAll = () => update(picks.map((p, i) => (spec.questions[i].recommended !== null ? { ...p, option: spec.questions[i].recommended } : p)));
  const done = picks.filter(isAnswered).length;
  const total = spec.questions.length;

  // An empty round tells the model to stop and wait for a chat message.
  const submit = (skip = false) => {
    if (item.partial || !sessionId) return;
    const answers = skip ? picks.map(() => EMPTY) : picks.map((p) => ({ option: p.option, note: p.note.trim() }));
    if (!send({ type: 'round-answer', sessionId, id: item.id, answers })) return;
    drafts.delete(item.id);
    setFresh(true);
    pickChoiceLocal(item.id, answers);
  };
  const onKey = (e: KeyboardEvent) => {
    // Keeps Enter here from also answering a permission or sending the composer.
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      submit();
    } else if (!(e.target instanceof HTMLTextAreaElement)) e.preventDefault();
  };

  return (
    <form className="frame choice aq rnd" data-id={item.id} onSubmit={(e) => (e.preventDefault(), submit())} onKeyDown={onKey}>
      <div className="fh"><span className="n">{spec.title || (total === 1 ? '1 question' : `${total} questions`)}</span></div>
      {spec.questions.map((q, i) => {
        const p = picks[i];
        const head = `rd-${item.id}-${i}`;
        return (
          <fieldset key={i} aria-labelledby={head}>
            <div className="rnd-h">
              <span className="aqh">{i + 1}</span>
              <b id={head}>{q.title}</b>
              {/* Kept in the layout while hidden, so picking an option never shifts the header. */}
              <button type="button" className="opt rnd-clr" disabled={p.option === null} onClick={() => setAt(i, { option: null })}>Clear</button>
            </div>
            {q.setup && <p className="rnd-setup">{q.setup}</p>}
            {q.options.map((o, k) => (
              <label key={k} className={`co${k === q.recommended ? ' rec' : ''}`}>
                <input type="radio" name={head} checked={p.option === k} onChange={() => setAt(i, { option: k })} onClick={() => p.option === k && setAt(i, { option: null })} />
                <span>
                  <b>{o.label}</b>{k === q.recommended && <span className="rnd-badge">recommended</span>}
                  {o.description && <small>{o.description}</small>}
                  {k === q.recommended && q.why && <small className="rnd-why">{q.why}</small>}
                </span>
              </label>
            ))}
            <div className="rnd-n">
              <textarea className="aqo" rows={1} aria-label={`Note for: ${q.title}`} placeholder="Note, or your own answer"
                value={p.note} onChange={(e) => setAt(i, { note: e.target.value })} />
            </div>
          </fieldset>
        );
      })}
      <div className="cf">
        <span className="rnd-count">{done} of {total} answered</span>
        <span className="rnd-acts">
          <button type="button" className="opt" disabled={item.partial} onClick={() => submit(true)}>Reply in chat</button>
          {recs > 0 && <button type="button" className="opt rnd-acc" disabled={allRec} onClick={acceptAll}>{allRec ? 'Recommendations accepted' : 'Accept all recommendations'}</button>}
          <button className="go2" type="submit" disabled={item.partial}>Send round<kbd>Ctrl ↵</kbd></button>
        </span>
      </div>
    </form>
  );
}
