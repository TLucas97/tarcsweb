import { useState, type KeyboardEvent } from 'react';
import type { AskReply, Mode } from '../../server/protocol.ts';
import { useStore, type Item } from './store.ts';
import { send } from './socket.ts';
import { Markdown } from './Markdown.tsx';
import { PM } from './Menus.tsx';

type Perm = Extract<Item, { kind: 'permission' }>;
const OTHER = '\0other';

function useAnswer(id: string) {
  const current = useStore((s) => s.current);
  return (allow: boolean, reply?: AskReply) => current && send({ type: 'permission-answer', sessionId: current, id, allow, ...(reply ? { reply } : {}) });
}

// Keeps Enter and n here from also reaching the global permission keys or the composer.
const fence = (e: KeyboardEvent) => e.stopPropagation();

// AskUserQuestion: every question gets its options plus a free "Other" answer, sent back in one reply.
export function QuestionCard({ item }: { item: Perm }) {
  const qs = item.questions!;
  const answer = useAnswer(item.id);
  const [picks, setPicks] = useState<string[][]>(() => qs.map((q) => (q.multiSelect || !q.options[0] ? [] : [q.options[0].label])));
  const [other, setOther] = useState<string[]>(() => qs.map(() => ''));

  if (item.answer !== null) {
    const got = item.reply?.answers;
    return (
      <div className="say old aqd" data-id={item.id}>
        {item.elsewhere ? <span className="pick-none">You answered on your phone.</span>
          : !item.answer ? <span className="pick-none">You skipped the question.</span>
          : got ? qs.map((q, i) => <div key={i}>{q.header || q.question} <b className="pick">{got[q.question] ?? '—'}</b></div>)
          : 'You answered.'}
      </div>
    );
  }

  const valueOf = (i: number) => picks[i].map((l) => (l === OTHER ? other[i].trim() : l)).filter(Boolean).join(', ');
  const ready = qs.every((_, i) => valueOf(i));
  const pick = (i: number, label: string, multi: boolean) =>
    setPicks((p) => p.map((cur, k) => (k !== i ? cur : !multi ? [label] : cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label])));
  const typeOther = (i: number, text: string) => {
    setOther((o) => o.map((t, k) => (k === i ? text : t)));
    if (!picks[i].includes(OTHER)) pick(i, OTHER, qs[i].multiSelect);
  };
  const submit = () => ready && answer(true, { answers: Object.fromEntries(qs.map((q, i) => [q.question, valueOf(i)])) });

  return (
    <form className="frame choice aq" data-id={item.id} onKeyDown={fence} onSubmit={(e) => (e.preventDefault(), submit())}>
      {qs.map((q, i) => {
        const shown = q.options.find((o) => o.preview && picks[i].includes(o.label));
        return (
          <fieldset key={i}>
            <div className="fh">{q.header && <span className="aqh">{q.header}</span>}<span className="n">{q.question}</span></div>
            {q.options.map((o) => (
              <label key={o.label} className="co">
                <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`aq-${item.id}-${i}`} checked={picks[i].includes(o.label)} onChange={() => pick(i, o.label, q.multiSelect)} />
                <span><b>{o.label}</b>{o.description && <small>{o.description}</small>}</span>
              </label>
            ))}
            <label className="co">
              <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`aq-${item.id}-${i}`} checked={picks[i].includes(OTHER)} onChange={() => pick(i, OTHER, q.multiSelect)} />
              <input className="aqo" placeholder="Other: type your answer" value={other[i]} onChange={(e) => typeOther(i, e.target.value)} />
            </label>
            {shown && <pre className="aqp mono">{shown.preview}</pre>}
          </fieldset>
        );
      })}
      <div className="cf">
        <button type="button" className="opt" onClick={() => answer(false)}>Skip</button>
        <button className="go2" type="submit" disabled={!ready}>Send<kbd>↵</kbd></button>
      </div>
    </form>
  );
}

const THEN = PM.filter(([m]) => m !== 'plan');

// ExitPlanMode: approve back into the mode the session had before planning, or send the plan back with notes.
export function PlanCard({ item }: { item: Perm }) {
  const answer = useAnswer(item.id);
  const [mode, setMode] = useState<Mode>(item.back ?? 'default');
  const [notes, setNotes] = useState<string | null>(null);
  const done = item.answer !== null;
  const ran = THEN.find(([m]) => m === item.reply?.mode)?.[1];

  return (
    <div className={`frame plc${done ? ' done' : ''}`} data-id={item.id} onKeyDown={fence}>
      <div className="fh"><span className="n">Plan</span>{done && <span className="end">{item.elsewhere ? 'Answered on your phone' : item.answer ?`Approved${ran ? ` · ${ran}` : ''}` : item.reply?.feedback ? 'Sent back with notes' : 'Not approved'}</span>}</div>
      <div className="plcb">{item.plan ? <Markdown text={item.plan} /> : <span className="pick-none">The plan text did not come through.</span>}</div>
      {!done && notes === null && (
        <div className="cf">
          <button className="opt" onClick={() => setNotes('')}>Keep planning</button>
          <span className="plct">
            <label>Then
              <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                {THEN.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
              </select>
            </label>
            <button className="go2" onClick={() => answer(true, { mode })}>Approve</button>
          </span>
        </div>
      )}
      {!done && notes !== null && (
        <form className="plcn" onSubmit={(e) => (e.preventDefault(), answer(false, notes.trim() ? { feedback: notes.trim() } : undefined))}>
          <textarea autoFocus rows={3} placeholder="What should change in the plan?" value={notes} onChange={(e) => setNotes(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.currentTarget.form?.requestSubmit()} />
          <div className="cf">
            <button type="button" className="opt" onClick={() => setNotes(null)}>Cancel</button>
            <button className="go2" type="submit">Send back<kbd>Ctrl ↵</kbd></button>
          </div>
        </form>
      )}
    </div>
  );
}
