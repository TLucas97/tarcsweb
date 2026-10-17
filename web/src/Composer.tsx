import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { send } from './socket.ts';
import { track, type SendMsg } from './outbox.ts';
import { currentSummary, sent, setPalette, useStore } from './store.ts';
import { McpMenu, ModeMenu, ModelMenu, MoreTools, nextMode, useSettings } from './Menus.tsx';
import { Usage } from './Usage.tsx';
import { openText } from './Focus.tsx';
import { Markdown, typedMarkdown } from './Markdown.tsx';
import { readFiles, type Pending } from './attach.ts';
import { loadParked, park } from './pending.ts';
import { pref } from './bits.tsx';
import { Led } from './led.tsx';
import { openImage } from './ImageViewer.tsx';
import type { Attachment } from '../../server/protocol.ts';
import { handoffLive, parseNote } from './handoff.ts';
import { useSlash } from './Slash.tsx';
import { SendImageBtn, setComposerSink } from './SendToChat.tsx';
import { keepImage, sizeOf, thumbUrl } from './LocalImage.tsx';
import { setLayoutVar } from './layoutVars.ts';
import { getPref, usePref } from './prefs.ts';
import { endHold, isHolding, setDictationSink, startHold, useDictation, warmStt } from './dictation.ts';
import { markReported, seenSince } from './stretch/store.ts';
import { useClaudeReady } from './setup.ts';
import { SkillChip, splitSkills, withSkills, type SkillRef } from './skills/ref.tsx';
import { SkillsButton } from './skills/Entry.tsx';
import { ActiveSkills } from './skills/Active.tsx';

const NO_SKILLS: SkillRef[] = [];

const HOLD_TEXT = { writing: 'Writing the handoff', compacting: 'Compacting', handing: 'Handing over' } as const;

// "• item" and "1. item" lines; group 3 is the number of a numbered item.
const LIST = /^(\s*)(• |(\d+)\. )/;
const PASTE_CHARS = 1200;
const PASTE_LINES = 20;

const lineCount = (t: string) => t.split('\n').length;

const KEYS = <><kbd>⇧↵</kbd> new line · <kbd>-</kbd> or <kbd>1.</kbd> list · <kbd>ctrl ↵</kbd> always sends</>;

// Typing hints: one line when the toolbar has room, else a keyboard button that opens them above itself.
function KeyHints() {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pop = popRef.current!;
    const place = (e: Event) => {
      if ((e as ToggleEvent).newState !== 'open') return;
      const r = btnRef.current!.getBoundingClientRect();
      pop.style.left = Math.max(12, r.left) + 'px';
      pop.style.bottom = innerHeight - r.top + 10 + 'px';
    };
    pop.addEventListener('beforetoggle', place);
    return () => pop.removeEventListener('beforetoggle', place);
  }, []);
  return (
    <>
      <span className="hint">{KEYS}</span>
      <button type="button" ref={btnRef} className="seg hint-btn" popoverTarget="keyHints" aria-label="Typing shortcuts" title="Typing shortcuts">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
          <rect x="1.5" y="3.5" width="13" height="9" rx="2" /><path d="M4.5 6.5h.01M7 6.5h.01M9.5 6.5h.01M12 6.5h-.01M5.5 9.5h5" />
        </svg>
      </button>
      <div className="pop hint-pop" id="keyHints" popover="auto" ref={popRef} role="note">{KEYS}</div>
    </>
  );
}

// Unsent text per session, kept across reloads; the oldest drop off past the cap.
const DRAFTS_MAX = 40;
const drafts = new Map<string, string>(pref.get<[string, string][]>('drafts', []));
let draftTimer = 0;
function saveDraft(id: string, text: string) {
  drafts.delete(id);
  if (text.trim()) drafts.set(id, text);
  while (drafts.size > DRAFTS_MAX) drafts.delete(drafts.keys().next().value!);
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => pref.set('drafts', [...drafts]), 300);
}

// Typing tells the server to boot this session's CLI; repeated at most every 20 s so it stays warm while the user writes.
const WARM_EVERY_MS = 20_000;
let warmed = { id: '', at: 0 };
function warm(id: string) {
  const now = Date.now();
  if (warmed.id === id && now - warmed.at < WARM_EVERY_MS) return;
  if (send({ type: 'warm', sessionId: id })) warmed = { id, at: now };
}

// Prompts sent in this session, oldest first, for ArrowUp recall.
const sentPrompts = () => {
  const s = useStore.getState();
  return s.order.flatMap((id) => {
    const it = s.items[id];
    return it?.kind === 'user' && it.text.trim() && !parseNote(it.text) ? [it.text] : [];
  });
};

// A long paste shown as one chip; it opens in the reader (editable when onEdit is set), and the × (composer only) drops it.
export function PasteChip({ text, onRemove, onEdit }: { text: string; onRemove?: () => void; onEdit?: (text: string) => void }) {
  const open = (el: Element) => openText(onEdit ? { paste: text, label: 'Edit pasted text', edit: onEdit } : { paste: text }, el);
  return (
    <span
      className="pchip" role="button" tabIndex={0} title={onEdit ? 'Edit the pasted text' : 'Open the pasted text'}
      onClick={(e) => open(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        e.stopPropagation();
        open(e.currentTarget);
      }}
    >
      Pasted text<small>{lineCount(text)} lines · {text.length.toLocaleString('en-US')} chars</small>
      {onRemove && (
        <button type="button" className="x" aria-label="Remove pasted text" title="Remove" onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</button>
      )}
    </span>
  );
}

const KIND = { image: 'Image', pdf: 'PDF', text: 'Text' } as const;

// A sent or waiting file: images show their picture, other files their name and type.
export function FileChip({ file, onRemove }: { file: Attachment; onRemove?: () => void }) {
  // The chip's width before the picture loads; matches `.fchip.img img` (composer) and `.me .fchip.img img` (sent).
  const size = sizeOf(file.src);
  const [h, maxW] = onRemove ? [54, 160] : [120, 280];
  const width = size ? Math.min(maxW, (h * size.w) / size.h) : undefined;
  // Resumed history has only the full picture; the chip shows the server's small copy of it.
  const shown = file.thumb ?? (file.src && thumbUrl(file.src));
  return (
    <span className={`fchip${shown ? ` img${onRemove ? '' : ' stc-host'}` : ''}`} title={file.name}>
      {shown
        ? <img src={shown} alt={file.name} style={width ? { width } : undefined} loading="lazy" decoding="async" onLoad={() => keepImage(shown)} onClick={(e) => openImage(e, file.src)} />
        : <span className="fn">{file.name}<small>{KIND[file.kind]}</small></span>}
      {!onRemove && (file.src || file.thumb) && <SendImageBtn src={(file.src ?? file.thumb)!} name={file.name} className="stc-float" />}
      {onRemove && (
        <button type="button" className="x" aria-label={`Remove ${file.name}`} title="Remove" onClick={onRemove}>×</button>
      )}
    </span>
  );
}

const MicIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" /><path d="M3.25 7.75a4.75 4.75 0 0 0 9.5 0M8 12.5v1.75" />
  </svg>
);

// A press shorter than this is a click, not a hold: it explains instead of recording a blip.
// The mic toggles: click to start talking, click again to transcribe. Space in the box is hold-to-talk.
function MicButton({ onStart }: { onStart: () => void }) {
  const { phase, by, engine, reason } = useDictation();
  const live = by === 'pointer' && phase !== 'idle';
  const title = engine === 'unavailable' && reason ? reason : live ? 'Click to stop and transcribe' : 'Click to dictate (or hold Space)';
  return (
    <button
      type="button" className="attach dict-mic" tabIndex={-1} aria-label={live ? 'Stop dictating' : 'Dictate'} title={title} aria-pressed={live}
      disabled={phase === 'transcribing' || (phase !== 'idle' && by === 'key')}
      // Keeps the caret in the box, where the text will land.
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        if (live) return endHold();
        warmStt();
        if (startHold('pointer')) onStart();
      }}
    >
      <MicIcon />
    </button>
  );
}

const DICT_TEXT = { waiting: 'Starting voice…', listening: 'Listening…', transcribing: 'Transcribing…' } as const;
const DICT_LED = { waiting: 'calm', listening: 'listen', transcribing: 'edit' } as const;

// The live state of a take; the composer's ring and the mic button carry the rest.
function DictationTag() {
  const { phase, by } = useDictation();
  if (phase === 'idle') return null;
  return (
    <span className="dict-tag" role="status" data-phase={phase}>
      <Led size="sm" pattern={DICT_LED[phase]} />
      {DICT_TEXT[phase]}
      {phase === 'listening' && <small>{by === 'key' ? 'release Space to stop' : 'click the mic to stop'}</small>}
    </span>
  );
}

const ClipIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13.2 7.6 8 12.8a3.2 3.2 0 0 1-4.6-4.6l5.5-5.5a2.1 2.1 0 0 1 3 3L6.4 11.2a1 1 0 0 1-1.5-1.5L10 4.6" />
  </svg>
);

// The sent bubble renders Markdown and keeps line breaks as typed; skill lines at the end show as chips.
export function UserText({ text }: { text: string }) {
  const { text: rest, skills } = splitSkills(text);
  return (
    <>
      {skills.length > 0 && <div className="sk-sent">{skills.map((s, i) => <SkillChip key={i} skill={s} />)}</div>}
      {(rest || !skills.length) && <Markdown text={typedMarkdown(rest)} typed />}
    </>
  );
}

export function Composer() {
  const formRef = useRef<HTMLFormElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [multi, setMulti] = useState(false);
  const [pastes, setPastes] = useState<string[]>([]);
  const [files, setFiles] = useState<Pending[]>([]);
  // Skill chips per session ('' before one exists); an entry goes away once it is empty or sent.
  const [skillsBy, setSkillsBy] = useState<Record<string, SkillRef[]>>({});
  const [dragging, setDragging] = useState(false);
  const pickRef = useRef<HTMLInputElement>(null);
  const slash = useSlash(promptRef);
  const current = useStore((s) => s.current);
  const [, apply] = useSettings();
  // Codex tabs have no slash commands or voice input yet.
  const slashOn = useStore((s) => currentSummary(s)?.caps?.slash !== false);
  const voiceCap = useStore((s) => currentSummary(s)?.caps?.voiceInput !== false);
  const voicePref = usePref('voiceInput');
  const claudeOk = useClaudeReady();
  const voiceInput = voicePref && voiceCap && claudeOk;
  const dictPhase = useDictation().phase;
  const skillKey = current ?? '';
  const skills = skillsBy[skillKey] ?? NO_SKILLS;
  const setSkills = (key: string, next: SkillRef[]) =>
    setSkillsBy(({ [key]: _old, ...rest }) => (next.length ? { ...rest, [key]: next } : rest));
  const toggleSkill = (r: SkillRef) =>
    setSkills(skillKey, skills.some((s) => s.path === r.path) ? skills.filter((s) => s.path !== r.path) : [...skills, r]);
  // Where the first Space of a possible hold went, and the session a take belongs to.
  const spaceAt = useRef<number | null>(null);
  const dictFor = useRef<string | null>(null);
  // While a handoff runs, a sent message waits on the server until it ends.
  const hold = useStore((s) => {
    const h = s.current ? s.maps[s.current]?.handoff : undefined;
    return h && handoffLive(h) ? HOLD_TEXT[h.phase as keyof typeof HOLD_TEXT] : null;
  });

  const attach = async (list: Iterable<File>) => {
    const { ok, skipped } = await readFiles(list);
    if (ok.length && current) warm(current);
    if (ok.length) setFiles((f) => [...f, ...ok].slice(0, 10));
    if (skipped.length) useStore.setState({ noticeInfo: false, notice: `Can't attach ${skipped.join(', ')}: only images, PDFs and text files` });
    promptRef.current?.focus();
  };

  // Images sent from the conversation land here like pasted ones.
  useEffect(() => {
    setComposerSink((p) => {
      if (files.length + p.length > 10) return false;
      setFiles((f) => [...f, ...p]);
      promptRef.current?.focus();
      return true;
    });
    return () => setComposerSink(null);
  }, [files.length]);

  // Files dropped anywhere on the page land in the composer.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (hasFiles(e) && --depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void attach(e.dataTransfer!.files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  // Wrap is measured in the one-line layout; reading it in the stacked layout (full width) flips it back every key.
  const sync = () => {
    const t = promptRef.current!;
    const form = formRef.current!;
    if (t.value.includes('\n')) return setMulti(true);
    const was = form.classList.contains('multi');
    form.classList.remove('multi');
    const wraps = t.scrollHeight > 30;
    if (was) form.classList.add('multi');
    setMulti(wraps);
  };

  // The conversation's bottom edge follows the composer height through --ch.
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setLayoutVar('--ch', Math.round(e.borderBoxSize[0].blockSize) + 'px'));
    ro.observe(formRef.current!);
    return () => ro.disconnect();
  }, []);

  // History recall: index into the sent prompts (null when not recalling) and the draft it replaced.
  const recall = useRef<{ i: number | null; draft: string }>({ i: null, draft: '' });
  const shownFor = useRef<string | null>(null);

  // Switching sessions stores this session's draft, brings back the other's, and keeps the prompt focused.
  useEffect(() => {
    const t = promptRef.current!;
    if (shownFor.current) saveDraft(shownFor.current, t.value);
    t.value = current ? drafts.get(current) ?? '' : '';
    shownFor.current = current;
    recall.current = { i: null, draft: '' };
    sync();
    t.focus({ preventScroll: true });
  }, [current]);

  // Attachments are parked per session like drafts; owner stays null until the session's saved set is back.
  const owner = useRef<string | null>(null);
  useEffect(() => {
    owner.current = null;
    setFiles([]);
    setPastes([]);
    if (!current) return;
    let live = true;
    void loadParked(current).then((p) => {
      if (!live) return;
      owner.current = current;
      // Anything attached while loading goes after the saved set; the new array also parks it.
      setFiles((f) => (p ? [...p.files, ...f].slice(0, 10) : [...f]));
      if (p) setPastes((x) => [...p.pastes, ...x]);
    });
    return () => {
      live = false;
    };
  }, [current]);

  useEffect(() => {
    if (owner.current) void park(owner.current, { files, pastes });
  }, [files, pastes]);

  // The reader can close after the session changed; then the edit goes to that session's parked set instead.
  const savePaste = (sid: string | null, i: number, before: string, next: string) => {
    if (next === before) return;
    const apply = (list: string[]) => {
      const k = list[i] === before ? i : list.indexOf(before);
      if (k < 0) return list;
      return next.trim() ? list.map((x, j) => (j === k ? next : x)) : list.filter((_, j) => j !== k);
    };
    if (sid === useStore.getState().current) setPastes(apply);
    else if (sid) void loadParked(sid).then((p) => p && park(sid, { ...p, pastes: apply(p.pastes) }));
    if (!next.trim()) promptRef.current?.focus();
  };

  const insertAt = (text: string, from: number, to: number) => {
    const t = promptRef.current!;
    if (!text && from === to) return;
    t.setSelectionRange(from, to);
    // execCommand keeps Ctrl+Z working; neither it nor setRangeText scrolls a box at max height to the caret, refocusing does.
    if (!document.execCommand(text ? 'insertText' : 'delete', false, text)) t.setRangeText(text, from, to, 'end');
    t.blur();
    t.focus();
    sync();
  };

  // A finished take lands at the caret, spaced from its neighbours; a take from another session goes to that session's draft.
  useEffect(() => {
    setDictationSink((text) => {
      const sid = dictFor.current;
      const now = useStore.getState().current;
      if (sid && sid !== now) {
        const d = drafts.get(sid) ?? '';
        return saveDraft(sid, d + (d && !/\s$/.test(d) ? ' ' : '') + text);
      }
      const t = promptRef.current!;
      const from = t.selectionStart;
      const to = t.selectionEnd;
      const before = t.value.slice(0, from);
      const after = t.value.slice(to);
      insertAt((before && !/\s$/.test(before) ? ' ' : '') + text + (after && !/^\s/.test(after) ? ' ' : ''), from, to);
      if (now) saveDraft(now, t.value);
    });
    return () => setDictationSink(null);
  }, []);

  const beginTake = () => {
    dictFor.current = useStore.getState().current;
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const t = promptRef.current!;
    const text = withSkills(t.value.trim(), skills);
    if (!text && !pastes.length && !files.length) return;
    // A take still running would land after the message left.
    if (dictPhase !== 'idle') return;
    // With no session yet, the text waits while a folder is picked.
    if (!current) return setPalette('folder');
    const extra = files.length ? { files: files.map((f) => f.upload), thumbs: files.map((f) => f.thumb) } : {};
    const st = useStore.getState();
    const seen = getPref('replyStyle') === 'stretch' ? seenSince(st.items, st.order) : null;
    const msg: SendMsg = { type: 'send', id: crypto.randomUUID(), sessionId: current, text, ...(pastes.length ? { pastes } : {}), ...extra, ...(seen ? { seen: seen.seen } : {}) };
    if (send(msg)) {
      if (seen) markReported(seen.ids);
      track(msg);
      sent();
      t.value = '';
      saveDraft(current, '');
      recall.current = { i: null, draft: '' };
      setPastes([]);
      setFiles([]);
      setSkills(current, []);
      sync();
    }
  };

  const onInput = (e: FormEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    const p = t.selectionStart;
    const ls = t.value.lastIndexOf('\n', p - 1) + 1;
    const line = t.value.slice(ls, p);
    // Markdown-style shortcut: "- " or "* " at the start of a line becomes a bullet.
    if ((e.nativeEvent as InputEvent).inputType === 'insertText' && /^\s*[-*] $/.test(line)) insertAt(line.replace(/[-*] $/, '• '), ls, p);
    else sync();
    recall.current.i = null;
    if (current) {
      saveDraft(current, t.value);
      warm(current);
    }
    if (voiceInput) warmStt();
    if (slashOn) slash.onInput();
  };

  // Hold Space to dictate: the first press types a space as usual; the first auto-repeat takes it back and starts a take.
  const dictateKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== ' ') {
      spaceAt.current = null;
      return false;
    }
    if (isHolding()) {
      e.preventDefault();
      return true;
    }
    const t = e.currentTarget;
    if (!voiceInput || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.nativeEvent.isComposing) return false;
    if (!e.repeat) {
      spaceAt.current = t.selectionStart === t.selectionEnd ? t.selectionStart : null;
      warmStt();
      return false;
    }
    const at = spaceAt.current;
    spaceAt.current = null;
    if (at === null || !startHold('key')) return false;
    e.preventDefault();
    beginTake();
    const end = t.selectionStart;
    if (end > at && end === t.selectionEnd && /^ +$/.test(t.value.slice(at, end))) {
      t.setSelectionRange(at, end);
      if (!document.execCommand('delete')) t.setRangeText('', at, end, 'end');
      sync();
    }
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (dictateKey(e)) return;
    if (slashOn && slash.onKeyDown(e)) return;
    // Shift+Tab cycles permission modes like the CLI; frequent, so no animation.
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      apply({ mode: nextMode(currentSummary(useStore.getState())?.mode ?? useStore.getState().defaults.mode) });
      return;
    }
    // ArrowUp on an empty box (or while recalling, on the first line) walks back through sent prompts; ArrowDown walks forward.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const t = e.currentTarget;
      const r = recall.current;
      const up = e.key === 'ArrowUp';
      const atEdge = up ? !t.value.slice(0, t.selectionStart).includes('\n') : !t.value.slice(t.selectionEnd).includes('\n');
      if ((r.i === null && (!up || t.value !== '')) || !atEdge) return;
      const list = sentPrompts();
      if (!list.length) return;
      e.preventDefault();
      if (r.i === null) r.draft = t.value;
      const next = (r.i ?? list.length) + (up ? -1 : 1);
      if (next < 0) return;
      r.i = next >= list.length ? null : next;
      t.value = r.i === null ? r.draft : list[r.i];
      // The caret lands on the edge facing the next press, so repeated presses keep walking.
      const at = up ? 0 : t.value.length;
      t.setSelectionRange(at, at);
      sync();
      return;
    }
    if (e.key !== 'Enter' && e.key !== 'Backspace') return;
    const t = e.currentTarget;
    const p = t.selectionStart;
    const ls = t.value.lastIndexOf('\n', p - 1) + 1;
    const nl = t.value.indexOf('\n', p);
    const le = nl < 0 ? t.value.length : nl;
    const line = t.value.slice(ls, le);
    const m = LIST.exec(line);
    // Backspace right after a marker removes the marker, not the line.
    if (e.key === 'Backspace') {
      if (m && p === ls + m[0].length && t.selectionEnd === p) {
        e.preventDefault();
        insertAt(m[1], ls, p);
      } else if (p === 0 && t.selectionEnd === 0 && skills.length) {
        // At the very start, Backspace takes the last skill chip as if it were text before the caret.
        e.preventDefault();
        setSkills(skillKey, skills.slice(0, -1));
      }
      return;
    }
    if (e.nativeEvent.isComposing) return;
    if (m && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      // An empty item ends the list; otherwise the next item gets the same marker (numbers count up).
      if (line.trim() === m[0].trim()) return insertAt('', ls, le);
      return insertAt('\n' + m[1] + (m[3] ? `${Number(m[3]) + 1}. ` : '• '), p, t.selectionEnd);
    }
    if (e.shiftKey) {
      setTimeout(sync);
      return;
    }
    e.preventDefault();
    // Stop here so the same Enter does not also approve a pending permission.
    if (t.value.trim() || pastes.length || files.length || skills.length) {
      e.stopPropagation();
      submit();
    }
  };

  // A huge paste becomes an attachment chip instead of flooding the box.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Copied images and files arrive as files; they win over the text a browser copies alongside them.
    if (e.clipboardData.files.length) {
      e.preventDefault();
      return void attach([...e.clipboardData.files]);
    }
    const t = e.clipboardData.getData('text');
    if (t.length < PASTE_CHARS && lineCount(t) < PASTE_LINES) return void setTimeout(sync);
    e.preventDefault();
    setPastes([...pastes, t]);
  };

  const isMulti = multi || pastes.length > 0 || files.length > 0 || skills.length > 0;
  return (
    <form className={`input rise${isMulti ? ' multi' : ''}${dragging ? ' drop' : ''}${hold ? ' held' : ''}`} ref={formRef} onSubmit={submit} data-dict={voiceInput && dictPhase !== 'idle' ? dictPhase : undefined}>
      {(pastes.length > 0 || files.length > 0 || skills.length > 0) && (
        <div className="pastes">
          {skills.map((s) => (
            <SkillChip key={s.path} skill={s} onRemove={() => { setSkills(skillKey, skills.filter((x) => x !== s)); promptRef.current!.focus(); }} />
          ))}
          {files.map((f) => (
            <FileChip key={f.key} file={{ name: f.upload.name, kind: f.upload.kind, ...(f.thumb ? { thumb: f.thumb } : {}) }} onRemove={() => { setFiles(files.filter((x) => x !== f)); promptRef.current!.focus(); }} />
          ))}
          {pastes.map((t, i) => <PasteChip key={i} text={t} onEdit={(next) => savePaste(current, i, t, next)} onRemove={() => { setPastes(pastes.filter((_, j) => j !== i)); promptRef.current!.focus(); }} />)}
        </div>
      )}
      <textarea ref={promptRef} rows={1} placeholder={hold ? `${hold}… your message will send after` : 'Ask anything'} autoComplete="off" aria-label="Message" autoFocus onInput={onInput} onKeyDown={onKeyDown} onPaste={onPaste} onPointerDown={voiceInput ? warmStt : undefined} />
      <div className="tools">
        {slashOn && slash.argHint}
        <button type="button" className="attach" aria-label="Attach files" title="Attach images, PDFs or text files" onClick={() => pickRef.current?.click()}>
          <ClipIcon />
        </button>
        <input
          ref={pickRef} type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.json,.ts,.tsx,.js,.jsx,.py,.rs,.go,.yaml,.yml,.toml,.csv,.log,.sh,.sql,.html,.css"
          onChange={(e) => {
            const list = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = '';
            void attach(list);
          }}
        />
        {voiceInput && <MicButton onStart={beginTake} />}
        <SkillsButton sessionId={current} chips={skills} onToggle={toggleSkill} draft={() => promptRef.current?.value ?? ''} slashOn={slashOn} />
        <ActiveSkills onAttach={(r) => !skills.some((s) => s.path === r.path) && toggleSkill(r)} />
        {slashOn && slash.button}
        {hold && <span className="holdtag" role="status"><Led size="sm" pattern="calm" />{hold}… your message will send after</span>}
        {voiceInput && <DictationTag />}
        <KeyHints />
        <span className="vr"></span>
        <McpMenu />
        <ModeMenu />
        <MoreTools>
          <ModelMenu />
          <span className="vr"></span>
          <Usage />
        </MoreTools>
        <button className="send" disabled={dictPhase !== 'idle'} aria-label={hold ? 'Send after the handoff' : 'Send'} title={hold ? 'Sends after the handoff' : 'Send'}>
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 12V2M3 6l4-4 4 4" fill="none" stroke="var(--on-fill,#fff)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      {slashOn && slash.panel}
    </form>
  );
}
