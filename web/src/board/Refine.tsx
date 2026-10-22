import { useEffect, useRef, useState, type FocusEvent, type FormEvent, type RefObject } from 'react';
import { create } from 'zustand';
import { BOARD_DEFAULT, FAST_TIER, PROMPT_MAX, PROVIDER_LABELS, type BoardModel } from '../../../server/board/api.ts';
import { pushEscape } from '../escape.ts';
import type { BoardEngine } from './engine.ts';
import { applyAnyway, dismissJob, jobBox, jobStarted, loadModels, refine, retryJob, selectionEmpty, type ModelPick } from './refineJob.ts';
import { notice, useBoard } from './store.ts';
import { downloadPicture, hasComposer, sendPicture, type Scope } from './toChat.ts';

type Props = { eng: RefObject<BoardEngine | null>; root: RefObject<HTMLDivElement | null> };

// Buttons never take focus from the board, so Space keeps panning.
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

const PICK_KEY = 'board-refine-pick';

function storedPick(): ModelPick {
  try {
    const v = JSON.parse(localStorage.getItem(PICK_KEY) ?? 'null') as Partial<ModelPick> | null;
    if (typeof v?.model === 'string' && typeof v.effort === 'string') return { model: v.model, effort: v.effort, fast: v.fast === true };
  } catch {}
  return { ...BOARD_DEFAULT, fast: false };
}

// The model list and the last pick, kept across selections; the pick survives reloads in localStorage.
const usePick = create<{ models: BoardModel[]; pick: ModelPick }>(() => ({ models: [], pick: storedPick() }));

// The catalog boots the board's Codex, so it loads only once the person reaches for the AI controls.
async function ensureModels() {
  const r = await loadModels();
  if (r.models.length && usePick.getState().models !== r.models) usePick.setState({ models: r.models, pick: fit(usePick.getState().pick, r.models, r.default) });
}

const offersFast = (m: BoardModel | undefined) => !!m?.tiers.includes(FAST_TIER);

// Models by provider, in the order the server listed them.
function groups(models: BoardModel[]) {
  const out = new Map<string, BoardModel[]>();
  for (const m of models) out.set(m.provider, [...(out.get(m.provider) ?? []), m]);
  return [...out];
}

function choose(pick: ModelPick) {
  usePick.setState({ pick });
  try {
    localStorage.setItem(PICK_KEY, JSON.stringify(pick));
  } catch {}
}

// The pick when the account offers it, else the server default, else the catalog default; effort clamped to the model.
function fit(p: ModelPick, models: BoardModel[], def: { model: string; effort: string }): ModelPick {
  const m = models.find((x) => x.id === p.model) ?? models.find((x) => x.id === def.model) ?? models.find((x) => x.isDefault) ?? models[0];
  if (!m) return p;
  return { model: m.id, effort: m.efforts.includes(p.effort) ? p.effort : m.efforts.includes(def.effort) ? def.effort : m.defaultEffort, fast: p.fast };
}

const elapsed = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// The refine field next to a selection, and the chip of a running job next to its region.
export function Refine({ eng, root }: Props) {
  const selection = useBoard((s) => s.selection);
  const tool = useBoard((s) => s.tool);
  const closed = useBoard((s) => s.refineClosed);
  const job = useBoard((s) => s.job);
  useEffect(() => {
    if (!selection) useBoard.setState({ refineClosed: false });
  }, [selection]);
  return (
    <>
      {selection && (tool === 'lasso' || tool === 'select') && !closed && !job && <RefineField eng={eng} root={root} />}
      {job && <JobChip eng={eng} />}
    </>
  );
}

function RefineField({ eng, root }: Props) {
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const offEsc = useRef<(() => void) | null>(null);
  const prompt = useBoard((s) => s.prompt);
  const models = usePick((s) => s.models);
  const pick = usePick((s) => s.pick);
  useEffect(() => {
    const e = eng.current, el = form.current;
    return e && el ? e.pin(el, () => e.selectionBox()) : undefined;
  }, [eng]);
  // Enter on the board jumps into the field; Enter on a focused control keeps its own meaning.
  useEffect(() => {
    const r = root.current;
    if (!r) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return;
      if (e.target instanceof Element && e.target.closest('button,a,input,textarea,select,[role=button],[contenteditable]')) return;
      e.preventDefault();
      input.current?.focus();
    };
    r.addEventListener('keydown', onKey);
    return () => r.removeEventListener('keydown', onKey);
  }, [root]);
  useEffect(() => () => offEsc.current?.(), []);
  const close = () => {
    useBoard.setState({ refineClosed: true });
    root.current?.focus({ preventScroll: true });
  };
  // While a control has focus, Esc closes the field instead of reaching the board, which would clear the selection.
  const onFocus = () => {
    offEsc.current ??= pushEscape(close);
    void ensureModels();
  };
  const onBlur = (e: FocusEvent) => {
    if (e.relatedTarget instanceof Node && form.current?.contains(e.relatedTarget)) return;
    offEsc.current?.();
    offEsc.current = null;
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const en = eng.current;
    if (!en) return;
    if (!prompt.trim() && selectionEmpty(en)) {
      notice('Describe what to draw in the empty selection');
      return input.current?.focus();
    }
    root.current?.focus({ preventScroll: true });
    useBoard.setState({ prompt: '' });
    // Submitting is intent too: the list is needed to know whether Fast applies to the picked model.
    const send = () => {
      const { models: list, pick: p } = usePick.getState();
      const m = list.find((x) => x.id === p.model);
      void refine(en, prompt, { ...p, fast: p.fast && offersFast(m), provider: m?.provider });
    };
    if (models.length) send();
    else void ensureModels().then(send);
  };
  const model = models.find((m) => m.id === pick.model);
  // A model with no effort levels gets no effort selector.
  const efforts = (model?.efforts ?? [pick.effort]).filter(Boolean);
  const pickModel = (id: string) => {
    const m = models.find((x) => x.id === id);
    if (m) choose({ model: m.id, effort: m.efforts.includes(pick.effort) ? pick.effort : m.defaultEffort, fast: pick.fast });
    input.current?.focus();
  };
  const pickEffort = (effort: string) => {
    choose({ ...pick, effort });
    input.current?.focus();
  };
  return (
    <form ref={form} className="bd-pin bd-refine" onSubmit={submit} onFocus={onFocus} onBlur={onBlur}>
      <input
        ref={input}
        className="bd-refine-in"
        value={prompt}
        maxLength={PROMPT_MAX}
        placeholder="What to draw, or empty to clean up"
        aria-label="Refine prompt"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => useBoard.setState({ prompt: e.target.value })}
      />
      <select className="bd-refine-sel" value={pick.model} aria-label="Model" title={model?.description ?? 'Model'} onChange={(e) => pickModel(e.target.value)}>
        {model ? groups(models).map(([p, list]) => (
          <optgroup key={p} label={PROVIDER_LABELS[p] ?? p}>
            {list.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </optgroup>
        )) : <option value={pick.model}>{pick.model}</option>}
      </select>
      {efforts.length > 0 && (
        <select className="bd-refine-sel" value={pick.effort} aria-label="Reasoning effort" title="Reasoning effort: higher is slower and more careful" onChange={(e) => pickEffort(e.target.value)}>
          {efforts.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      )}
      {offersFast(model) && (
        <button
          type="button"
          className="bd-refine-fast"
          aria-pressed={pick.fast}
          title="Fast: quicker answers, but uses more of your Codex limit"
          onMouseDown={keepFocus}
          onClick={() => choose({ ...pick, fast: !pick.fast })}
        >
          Fast
        </button>
      )}
      <SendButton eng={eng} scope="selection" />
      <button type="submit" className="bd-refine-go" title="Refine the selection (Enter)" onMouseDown={keepFocus}>
        Refine
      </button>
    </form>
  );
}

const SENT_MS = 1500;
const SEND_ERROR_MS = 3000;

const SEND_TEXT: Record<Scope, { label: string; what: string }> = {
  selection: { label: 'Send to chat', what: 'the selection' },
  board: { label: 'Send board', what: 'the whole board' },
};

// The selection or the whole board into the composer tray; the label reports the result.
// Without a composer (board.html) it downloads the PNG instead.
export function SendButton({ eng, scope, className = 'bd-job-btn' }: { eng: Props['eng']; scope: Scope; className?: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | { error: string }>('idle');
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const go = async () => {
    const en = eng.current;
    if (!en || state === 'busy') return;
    setState('busy');
    const error = await (hasComposer ? sendPicture(en, scope) : downloadPicture(en, scope)).catch(() => "Couldn't draw the picture");
    setState(error ? { error } : 'done');
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), error ? SEND_ERROR_MS : SENT_MS);
  };
  const { label: idle, what } = SEND_TEXT[scope];
  const label = typeof state === 'object' ? state.error : state === 'done' ? (hasComposer ? 'Added to chat' : 'Downloaded') : hasComposer ? idle : 'Download PNG';
  return (
    <button
      type="button"
      className={className}
      data-state={typeof state === 'object' ? 'error' : state}
      aria-busy={state === 'busy'}
      title={hasComposer ? `Attach ${what} to your message` : `Save ${what} as a PNG`}
      onMouseDown={keepFocus}
      onClick={go}
    >
      <span aria-live="polite">{label}</span>
    </button>
  );
}

// Seconds since the job was sent; mounted only while it runs.
function Elapsed() {
  const [t0] = useState(() => jobStarted() ?? Date.now());
  const [now, setNow] = useState(t0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="bd-job-time">{elapsed(now - t0)}</span>;
}

function JobChip({ eng }: { eng: Props['eng'] }) {
  const ref = useRef<HTMLDivElement>(null);
  const job = useBoard((s) => s.job);
  useEffect(() => {
    const e = eng.current, el = ref.current;
    return e && el ? e.pin(el, jobBox) : undefined;
  }, [eng]);
  if (!job) return null;
  return (
    <div ref={ref} className="bd-pin bd-job" data-phase={job.phase} role="status" onMouseDown={keepFocus}>
      {job.phase === 'running' && <span className="bd-job-dot" aria-hidden="true" />}
      <span className="bd-job-text">{job.text}</span>
      {job.phase === 'running' && <Elapsed />}
      {job.phase === 'running' && (
        <button type="button" className="bd-job-btn" onClick={dismissJob}>
          Cancel
        </button>
      )}
      {job.phase === 'stale' && (
        <>
          <button type="button" className="bd-job-btn bd-job-main" onClick={applyAnyway}>
            Apply anyway
          </button>
          <button type="button" className="bd-job-btn" onClick={dismissJob}>
            Discard
          </button>
        </>
      )}
      {job.phase === 'failed' && (
        <>
          <button type="button" className="bd-job-btn bd-job-main" title="Send the same prompt with the same model again" onClick={retryJob}>
            Retry
          </button>
          <button type="button" className="bd-job-btn" onClick={dismissJob}>
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
