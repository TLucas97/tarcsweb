import { useState, type KeyboardEvent } from 'react';
import { ROUND_CANCELLED, type ChecklistAnswer, type ChecklistSpec, type RichDetail } from '../../server/protocol.ts';
import { pickChoiceLocal, useStore, type RichItem } from './store.ts';
import { send } from './socket.ts';
import { SendTextBtn } from './SendToChat.tsx';

const cancelled = (e: string) => e === ROUND_CANCELLED || /interrupt/i.test(e);
// Unsent ticks and notes survive a remount or session switch; dropped on send, oldest first past the cap.
const drafts = new Map<string, ChecklistAnswer>();
const DRAFTS_MAX = 20;

function remember(id: string, next: ChecklistAnswer) {
  drafts.delete(id);
  drafts.set(id, next);
  if (drafts.size > DRAFTS_MAX) drafts.delete(drafts.keys().next().value!);
}

// "[x] 1. Label — note" per item, then the note.
function checklistText(spec: ChecklistSpec, ticked: number[], note: string) {
  const on = new Set(ticked);
  const lines = spec.items.map((it, i) => `[${on.has(i) ? 'x' : ' '}] ${i + 1}. ${it.label}${it.note ? ` — ${it.note}` : ''}`);
  return `${spec.title ? `Checklist "${spec.title}"` : 'Checklist'}, my picks:\n${lines.join('\n')}${note ? `\n\nNote: ${note}` : ''}`;
}

// The sent checklist: ticked items marked, the rest dimmed; history keeps only this form.
function ChecklistDone({ id, spec, answer, fresh, error }: { id: string; spec: ChecklistSpec; answer: ChecklistAnswer | null; fresh: boolean; error: string | null }) {
  if (error) {
    return (
      <div className="say old aqd rnd-done" data-id={id}>
        <div className="rnd-t">{spec.title}{spec.title ? ' · ' : ''}<span className="rnd-err">{error}</span></div>
      </div>
    );
  }
  if (answer && !answer.ticked.length && !answer.note) {
    return (
      <div className={`say old aqd rnd-done${fresh ? ' in' : ''}`} data-id={id}>
        <div className="rnd-t">{spec.title}<span className="pick-none">{spec.title ? ' · ' : ''}Closed to reply in chat</span></div>
      </div>
    );
  }
  const on = new Set(answer?.ticked ?? []);
  return (
    <div className={`say old aqd rnd-done ckl-done${fresh ? ' in' : ''}`} data-id={id}>
      {(spec.title || !answer) && <div className="rnd-t">{spec.title}{!answer && <span className="pick-none">{spec.title ? ' · ' : ''}Checklist cancelled</span>}</div>}
      <ul className="ckl-sent">
        {spec.items.map((it, i) => (
          <li key={i} className={on.has(i) ? 'on' : undefined}>
            <span className="ckl-mk" role="img" aria-label={on.has(i) ? 'Ticked' : 'Not ticked'}>{on.has(i) ? '✓' : '·'}</span>
            {on.has(i) ? <b className="pick">{it.label}</b> : <span className="pick-none">{it.label}</span>}
          </li>
        ))}
      </ul>
      {answer?.note && <div className="rnd-ex">{answer.note}</div>}
      {answer && <SendTextBtn text={() => checklistText(spec, answer.ticked, answer.note)} what="the checklist and your picks" />}
    </div>
  );
}

// ask_checklist: tick any number of items, add a note, and send them with one click.
export function Checklist({ item }: { item: RichItem }) {
  const spec = (item.detail as Extract<RichDetail, { kind: 'checklist' }>).checklist;
  const sessionId = useStore((s) => s.current);
  const [ticked, setTicked] = useState<number[]>(() => drafts.get(item.id)?.ticked ?? []);
  const [note, setNote] = useState(() => drafts.get(item.id)?.note ?? '');
  const [fresh, setFresh] = useState(false);
  const r = item.result;
  if (r) {
    return <ChecklistDone id={item.id} spec={spec} answer={r.error ? null : (r.checklist ?? null)} fresh={fresh} error={r.error && !cancelled(r.error) ? r.error : null} />;
  }

  const update = (next: number[]) => {
    const sorted = [...next].sort((a, b) => a - b);
    setTicked(sorted);
    remember(item.id, { ticked: sorted, note });
  };
  const toggle = (i: number) => update(ticked.includes(i) ? ticked.filter((k) => k !== i) : [...ticked, i]);
  const changeNote = (text: string) => {
    setNote(text);
    remember(item.id, { ticked, note: text });
  };
  const recs = spec.items.flatMap((it, i) => (it.recommended ? [i] : []));
  const allRec = recs.length > 0 && recs.every((i) => ticked.includes(i));
  const total = spec.items.length;

  // Nothing ticked and no note tells the model to stop and wait for a chat message.
  const submit = (skip = false) => {
    if (item.partial || !sessionId || (!skip && !ticked.length && !note.trim())) return;
    const answer = skip ? { ticked: [], note: '' } : { ticked, note: note.trim() };
    if (!send({ type: 'checklist-answer', sessionId, id: item.id, ...answer })) return;
    drafts.delete(item.id);
    setFresh(true);
    pickChoiceLocal(item.id, answer);
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
    <form className="frame choice aq ckl" data-id={item.id} onSubmit={(e) => (e.preventDefault(), submit())} onKeyDown={onKey}>
      <div className="fh">
        <span className="n">{spec.title || (total === 1 ? '1 item' : `${total} items`)}</span>
        {!item.partial && <SendTextBtn text={() => checklistText(spec, ticked, note.trim())} what="the checklist and your current picks" />}
      </div>
      <div className="ckl-items">
        {spec.items.map((it, i) => (
          <label key={i} className={`co${it.recommended ? ' rec' : ''}`}>
            <input type="checkbox" checked={ticked.includes(i)} onChange={() => toggle(i)} />
            <span>
              <b>{it.label}</b>{it.recommended && <span className="rnd-badge">recommended</span>}
              {it.note && <small>{it.note}</small>}
            </span>
          </label>
        ))}
      </div>
      <div className="rnd-x">
        <textarea className="aqo" rows={1} aria-label="Note" placeholder="Note (optional), e.g. do 2 first"
          value={note} onChange={(e) => changeNote(e.target.value)} />
      </div>
      <div className="cf">
        <span className="rnd-count">{ticked.length} of {total} ticked</span>
        <span className="rnd-acts">
          <button type="button" className="opt" disabled={item.partial} onClick={() => submit(true)}>Reply in chat</button>
          {recs.length > 0 && <button type="button" className="opt rnd-acc" disabled={allRec} onClick={() => update([...new Set([...ticked, ...recs])])}>{allRec ? 'Recommended ticked' : 'Tick recommended'}</button>}
          <button className="go2" type="submit" disabled={item.partial || (!ticked.length && !note.trim())} data-robot-react="happy">Send<kbd aria-hidden="true">Ctrl ↵</kbd></button>
        </span>
      </div>
    </form>
  );
}
