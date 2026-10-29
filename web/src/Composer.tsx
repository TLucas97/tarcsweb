import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { send } from './socket.ts';
import { submit as submitMessage, type SendMsg } from './outbox.ts';
import { currentSummary, sent, setPalette, useStore } from './store.ts';
import { McpMenu, ModeMenu, ModelMenu, MoreTools, PM, nextMode, useSettings } from './Menus.tsx';
import { Usage } from './Usage.tsx';
import { openText } from './Focus.tsx';
import { Markdown, typedMarkdown } from './Markdown.tsx';
import { readFiles, type Pending } from './attach.ts';
import { loadParked, park, type Paste } from './pending.ts';
import { MidCut, pref } from './bits.tsx';
import { Led } from './led.tsx';
import { openImage } from './openImage.ts';
import type { Attachment, TextLink, Upload } from '../../server/protocol.ts';
import { LinkTools, LinkedSpans, NumBadge, paintMirror, placeMirror, shiftLinks, tintOf, trimRange, withLink, type DraftLink, type TrayItem } from './links.tsx';
import { handoffLive, parseNote } from './handoff.ts';
import { useSlash } from './Slash.tsx';
import { SendImageBtn, setCommandSink, setComposerSink, setDraftSink, setTextSink } from './SendToChat.tsx';
import { keepImage, sizeOf, thumbUrl } from './LocalImage.tsx';
import { setLayoutVar } from './layoutVars.ts';
import { grow, useAutosize } from './autosize.ts';
import { getPref, usePref } from './prefs.ts';
import { endHold, isHolding, setDictationSink, startHold, useDictation, warmStt } from './dictation.ts';
import { markReported, seenSince } from './stretch/store.ts';
import { useClaudeReady } from './setup.ts';
import { SkillChip, splitSkills, withSkills, type SkillRef } from './skills/ref.tsx';
import { SkillsButton } from './skills/Entry.tsx';
import { ActiveSkills } from './skills/Active.tsx';
import { BoardButton } from './board/Entry.tsx';
import { useMention } from './mention/useMention.tsx';
import { mentionOf, mentionSpans } from './mention/token.tsx';
import { ClipMenu } from './mention/ClipMenu.tsx';
import { appCommandOf, runApp } from './appCommands.ts';

const NO_SKILLS: SkillRef[] = [];

const HOLD_TEXT = { writing: 'Writing the handoff', compacting: 'Compacting', handing: 'Handing over' } as const;

// "• item" and "1. item" lines; group 3 is the number of a numbered item.
const LIST = /^(\s*)(• |(\d+)\. )/;
const PASTE_CHARS = 1200;
const PASTE_LINES = 20;
const MAX_FILES = 10;

const lineCount = (t: string) => t.split('\n').length;

const KEYS = <><kbd>⇧↵</kbd> new line · <kbd>-</kbd> or <kbd>1.</kbd> list · <kbd>ctrl ↵</kbd> always sends</>;

// Typing hints stay behind the keyboard button at every toolbar width.
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
      <button type="button" ref={btnRef} className="seg hint-btn" popoverTarget="keyHints" aria-label="Typing shortcuts" title="Typing shortcuts">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
          <rect x="1.5" y="3.5" width="13" height="9" rx="2" /><path d="M4.5 6.5h.01M7 6.5h.01M9.5 6.5h.01M12 6.5h-.01M5.5 9.5h5" />
        </svg>
      </button>
      <div className="pop hint-pop" id="keyHints" popover="auto" ref={popRef} role="note">{KEYS}</div>
    </>
  );
}

// Unsent text per session, one localStorage key each so two windows never overwrite each other's drafts; the oldest drop off past the cap.
const DRAFTS_MAX = 40;
const DRAFT_KEY = 'cw:draft:';
type SavedDraft = { text: string; links?: DraftLink[]; skills?: SkillRef[]; at: number };
const drafts = new Map<string, string>();
// Each draft's links, saved with its text so their offsets stay in step; only drafts that exist keep them.
const draftLinks = new Map<string, DraftLink[]>();
// Skill chips waiting with a draft; a draft of chips alone is kept too.
const draftSkills = new Map<string, SkillRef[]>();
const validSkills = (v: unknown): SkillRef[] =>
  Array.isArray(v) ? v.filter((s): s is SkillRef => !!s && typeof s.name === 'string' && typeof s.path === 'string') : [];
// The text last read from or written to storage per session, so a sync from another window knows if this one typed since.
const synced = new Map<string, string>();

function readDraft(raw: string | null): SavedDraft | null {
  try {
    const v = raw ? (JSON.parse(raw) as SavedDraft) : null;
    return v && typeof v.text === 'string' ? v : null;
  } catch {
    return null;
  }
}

function putLocal(id: string, d: SavedDraft | null) {
  const text = d?.text.trim() ? d.text : '';
  if (text) drafts.set(id, text);
  else drafts.delete(id);
  if (text && d?.links?.length) draftLinks.set(id, d.links);
  else draftLinks.delete(id);
  const sk = validSkills(d?.skills);
  if (sk.length) draftSkills.set(id, sk);
  else draftSkills.delete(id);
  if (text) synced.set(id, text);
  else synced.delete(id);
}

function loadDrafts() {
  try {
    // Moves the old shared arrays, written whole by every window, to one key per session.
    const old = pref.get<[string, string][]>('drafts', []);
    const oldLinks = new Map(pref.get<[string, DraftLink[]][]>('draftLinks', []));
    old.forEach(([id, text], i) => {
      if (localStorage.getItem(DRAFT_KEY + id) === null) localStorage.setItem(DRAFT_KEY + id, JSON.stringify({ text, links: oldLinks.get(id), at: Date.now() - old.length + i }));
    });
    localStorage.removeItem('cw:drafts');
    localStorage.removeItem('cw:draftLinks');
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith(DRAFT_KEY)) putLocal(k.slice(DRAFT_KEY.length), readDraft(localStorage.getItem(k)));
    }
  } catch {}
}
loadDrafts();

// Only a new key can push the count past the cap, so the scan runs then and not on every save.
function capDrafts() {
  const all: [string, number][] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith(DRAFT_KEY)) all.push([k, readDraft(localStorage.getItem(k))?.at ?? 0]);
  }
  if (all.length <= DRAFTS_MAX) return;
  all.sort((a, b) => a[1] - b[1]);
  for (const [k] of all.slice(0, all.length - DRAFTS_MAX)) {
    localStorage.removeItem(k);
    putLocal(k.slice(DRAFT_KEY.length), null);
  }
}

const dirty = new Set<string>();
let draftTimer = 0;
function flushDrafts() {
  clearTimeout(draftTimer);
  let added = false;
  try {
    for (const id of dirty) {
      const text = drafts.get(id) ?? '';
      const skills = draftSkills.get(id);
      if (!text) synced.delete(id);
      else synced.set(id, text);
      if (!text && !skills) {
        localStorage.removeItem(DRAFT_KEY + id);
        continue;
      }
      added ||= localStorage.getItem(DRAFT_KEY + id) === null;
      localStorage.setItem(DRAFT_KEY + id, JSON.stringify({ text, links: draftLinks.get(id), skills, at: Date.now() }));
    }
    if (added) capDrafts();
  } catch {}
  dirty.clear();
}
addEventListener('pagehide', flushDrafts);

// Without links the saved ones stay, as when dictation adds text at the end of another tab's draft.
function saveDraft(id: string, text: string, links?: DraftLink[]) {
  if (text.trim()) drafts.set(id, text);
  else drafts.delete(id);
  if (links || !text.trim()) draftLinks.delete(id);
  if (links?.length && text.trim()) draftLinks.set(id, links);
  dirty.add(id);
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(flushDrafts, 300);
}

function saveDraftSkills(id: string, skills: SkillRef[]) {
  if (skills.length) draftSkills.set(id, skills);
  else draftSkills.delete(id);
  dirty.add(id);
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(flushDrafts, 300);
}

// The composer showing a session takes a draft another window changed; before is the text synced until then.
let draftSync: ((id: string, before: string) => void) | null = null;
addEventListener('storage', (e) => {
  if (!e.key?.startsWith(DRAFT_KEY)) return;
  const id = e.key.slice(DRAFT_KEY.length);
  const before = synced.get(id) ?? '';
  // A local edit not written yet wins; it goes out on the next flush.
  if (dirty.has(id)) return;
  putLocal(id, readDraft(e.newValue));
  draftSync?.(id, before);
});

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
// num is the attachment number that linked text refers to; onInline (composer only) puts the text back in the message.
export function PasteChip({ text, num, onRemove, onEdit, onInline }: {
  text: string; num?: number; onRemove?: () => void; onEdit?: (text: string) => void; onInline?: () => void;
}) {
  const open = (el: Element) => openText(onEdit ? { paste: text, label: 'Edit pasted text', edit: onEdit } : { paste: text }, el);
  return (
    <span
      className="pchip" role="button" tabIndex={0} title={onEdit ? 'Edit the pasted text' : 'Open the pasted text'}
      aria-label={num === undefined ? undefined : `Attachment ${num}: pasted text, ${lineCount(text)} lines`}
      onClick={(e) => open(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        e.stopPropagation();
        open(e.currentTarget);
      }}
    >
      {num !== undefined && <NumBadge num={num} />}
      Pasted text<small>{lineCount(text)} lines · {text.length.toLocaleString('en-US')} chars</small>
      {onInline && (
        <button type="button" className="pin" title="Put the text in the message, where you pasted it" onClick={(e) => { e.stopPropagation(); onInline(); }}>Put in message</button>
      )}
      {onRemove && (
        <button type="button" className="x" aria-label="Remove pasted text" title="Remove" onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</button>
      )}
    </span>
  );
}

const KIND = { image: 'Image', pdf: 'PDF', text: 'Text' } as const;

// A tray picture opens whole in the viewer, not as its small thumb; built once per upload.
const fullSrc = new WeakMap<Upload, string>();
function fullOf(u: Upload) {
  let s = fullSrc.get(u);
  if (!s) fullSrc.set(u, (s = `data:${u.mime};base64,${u.data}`));
  return s;
}

// A sent or waiting file: images show their picture, other files their name and type.
export function FileChip({ file, num, onRemove }: { file: Attachment; num?: number; onRemove?: () => void }) {
  // The chip's width before the picture loads; matches `.fchip.img img` (composer) and `.me .fchip.img img` (sent).
  const size = sizeOf(file.src);
  const [h, maxW] = onRemove ? [54, 160] : [120, 280];
  // The 64px floor keeps a very tall picture from becoming a sliver; object-fit crops it.
  const width = size ? Math.max(64, Math.min(maxW, (h * size.w) / size.h)) : undefined;
  // Resumed history has only the full picture; the chip shows the server's small copy of it.
  const shown = file.thumb ?? (file.src && thumbUrl(file.src));
  return (
    <span className={`fchip${shown ? ` img${onRemove ? '' : ' stc-host'}` : ''}`} title={num === undefined ? file.name : `Attachment ${num}: ${file.name}`}>
      {num !== undefined && <NumBadge num={num} />}
      {shown
        ? <img src={shown} alt={file.name} style={width ? { width } : undefined} loading="lazy" decoding="async" onLoad={() => keepImage(shown)} onClick={(e) => openImage(e, file.src)} />
        : <span className="fn"><MidCut text={file.name} title={false} /><small>{KIND[file.kind]}</small></span>}
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
// With links it shows the text as typed instead, so the linked spans can be marked.
export function UserText({ text, links }: { text: string; links?: TextLink[] }) {
  const { text: rest, skills } = splitSkills(text);
  return (
    <>
      {skills.length > 0 && <div className="sk-sent">{skills.map((s, i) => <SkillChip key={i} skill={s} />)}</div>}
      {links?.length ? <LinkedSpans text={rest} links={links} /> : (rest || !skills.length) && <Markdown text={typedMarkdown(rest)} typed />}
    </>
  );
}

// A sent prompt's attachments and text; a prompt with links numbers its chips like the tray did.
export function UserBody({ text, files, pastes, links }: { text: string; files?: Attachment[]; pastes?: string[]; links?: TextLink[] }) {
  const n = links?.length ? (files?.length ?? 0) : null;
  return (
    <>
      {files?.length ? <div className="mfiles">{files.map((f, i) => <FileChip key={i} file={f} num={n === null ? undefined : i + 1} />)}</div> : null}
      {pastes?.map((p, i) => <PasteChip key={i} text={p} num={n === null ? undefined : n + i + 1} />)}
      <UserText text={text} links={links} />
    </>
  );
}

export function Composer() {
  const formRef = useRef<HTMLFormElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [multi, setMulti] = useState(false);
  const [pastes, setPastes] = useState<Paste[]>([]);
  const [files, setFiles] = useState<Pending[]>([]);
  const fileCount = useRef(0);
  useEffect(() => {
    fileCount.current = files.length;
  }, [files]);
  // Why the last attach left files out; stays until dismissed, the next attach or a send.
  const [note, setNote] = useState<string | null>(null);
  // Text spans linked to tray items. The ref is what handlers read and write; the state redraws.
  const [links, setLinks] = useState<DraftLink[]>([]);
  const linksRef = useRef<DraftLink[]>([]);
  // The value the links were last fitted to, the base of the next edit's diff.
  const typedRef = useRef('');
  const mirrorRef = useRef<HTMLDivElement>(null);
  const pickSel = useRef<[number, number] | null>(null);
  // Skill chips per session ('' before one exists); an entry goes away once it is empty or sent.
  const [skillsBy, setSkillsBy] = useState<Record<string, SkillRef[]>>({});
  const [dragging, setDragging] = useState(false);
  const pickRef = useRef<HTMLInputElement>(null);
  const current = useStore((s) => s.current);
  const skillKey = current ?? '';
  // A session's chips live here once touched, else in its saved draft; every change is saved with the draft.
  const setSkills = (key: string, next: SkillRef[] | ((cur: SkillRef[]) => SkillRef[])) =>
    setSkillsBy(({ [key]: old, ...rest }) => {
      const cur = old ?? (key ? draftSkills.get(key) : undefined) ?? NO_SKILLS;
      const list = typeof next === 'function' ? next(cur) : next;
      if (key) saveDraftSkills(key, list);
      return list.length ? { ...rest, [key]: list } : rest;
    });
  const addSkill = (r: SkillRef) => setSkills(skillKey, (cur) => (cur.some((s) => s.path === r.path) ? cur : [...cur, r]));
  const slash = useSlash(promptRef, addSkill);
  const mention = useMention(promptRef);
  const working = useStore((s) => s.status === 'working');
  // Whether the box holds text; with nothing to send during a turn, the send button stops it instead.
  const [typed, setTyped] = useState(false);
  // The mode Shift+Tab picked, read out by screen readers.
  const [modeNote, setModeNote] = useState('');
  const [, apply] = useSettings();
  // Codex tabs have no slash commands or voice input yet.
  const slashOn = useStore((s) => currentSummary(s)?.caps?.slash !== false);
  const voiceCap = useStore((s) => currentSummary(s)?.caps?.voiceInput !== false);
  const voicePref = usePref('voiceInput');
  const claudeOk = useClaudeReady();
  const voiceInput = voicePref && voiceCap && claudeOk;
  const dictPhase = useDictation().phase;
  const skills = skillsBy[skillKey] ?? draftSkills.get(skillKey) ?? NO_SKILLS;
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

  // Tray numbers: files first, then text attachments, as the server counts them.
  const tray: TrayItem[] = [
    ...files.map((f) => ({ key: f.key, name: f.upload.name, thumb: f.thumb })),
    ...pastes.map((p) => ({ key: p.key, name: p.text.slice(0, 120).trim().split('\n')[0].replace(/^>\s?/, '') || 'Pasted text', thumb: null })),
  ].map((it, i) => ({ ...it, num: i + 1 }));

  const putLinks = (next: DraftLink[]) => {
    if (next === linksRef.current) return;
    linksRef.current = next;
    setLinks(next);
  };
  const relink = (next: DraftLink[]) => {
    putLinks(next);
    if (shownFor.current) saveDraft(shownFor.current, promptRef.current!.value, next);
  };
  const linkTo = (from: number, to: number, key: string) => {
    const t = promptRef.current!;
    const r = trimRange(t.value, from, to);
    if (!r) return;
    relink(withLink(linksRef.current, r[0], r[1], key));
    // A paste or drop leaves the linked text selected; the next key would replace it, so the caret moves past it.
    if (t.selectionStart < t.selectionEnd && t.selectionStart <= r[0] && t.selectionEnd >= r[1]) t.setSelectionRange(t.selectionEnd, t.selectionEnd);
  };
  // Redraws the mirror behind the textarea; spans whose attachment is not loaded yet stay plain.
  const paint = () => {
    const m = mirrorRef.current;
    const t = promptRef.current;
    if (!m || !t) return;
    const nums = new Map(tray.map((it) => [it.key, it.num]));
    const linked = linksRef.current.flatMap((l) => {
      const n = nums.get(l.key);
      return n ? [{ start: l.start, end: l.end, tint: tintOf(n) }] : [];
    });
    // @ mentions get their own mark; a linked span over one wins.
    const mentions = mentionSpans(t.value).filter(([s, e]) => !linked.some((l) => l.start < e && s < l.end)).map(([start, end]) => ({ start, end, cls: 'mn' }));
    paintMirror(m, t.value, mentions.length ? [...linked, ...mentions].sort((a, b) => a.start - b.start) : linked);
    m.scrollTop = t.scrollTop;
  };
  // The textarea's selection while it has focus; a selection left in a blurred box does not count.
  const liveSel = (): [number, number] | null => {
    const t = promptRef.current;
    if (!t || document.activeElement !== t || t.selectionStart === t.selectionEnd) return null;
    return trimRange(t.value, t.selectionStart, t.selectionEnd);
  };
  const addPaste = (text: string, sel: [number, number] | null = null) => {
    const key = crypto.randomUUID();
    setPastes((p) => [...p, { key, text }]);
    if (sel) linkTo(sel[0], sel[1], key);
  };

  // sel: text selected when the files came; it links to the first of them.
  const attach = async (list: Iterable<File>, sel: [number, number] | null = null) => {
    setNote(null);
    const sid = useStore.getState().current;
    const t = promptRef.current!;
    const want = sel && t.value.slice(sel[0], sel[1]);
    const { ok, skipped } = await readFiles(list);
    // The drop listener keeps the first render's closure, so the tray size comes from a ref.
    const added = ok.slice(0, Math.max(0, MAX_FILES - fileCount.current));
    fileCount.current += added.length;
    if (added.length && sid) warm(sid);
    if (added.length) setFiles((f) => [...f, ...added].slice(0, MAX_FILES));
    if (sel && added.length && useStore.getState().current === sid && t.value.slice(sel[0], sel[1]) === want) linkTo(sel[0], sel[1], added[0].key);
    const why = [
      ...(skipped.length ? [`Can't attach ${skipped.join(', ')}: only images, PDFs and text files upload. The paperclip's Reference file or folder gives the agent its path instead`] : []),
      ...(ok.length > added.length ? [`${MAX_FILES} files max, ${ok.length - added.length} not added`] : []),
    ];
    if (why.length) setNote(why.join('. '));
    promptRef.current?.focus();
  };

  // Explain's "Attach to chat" adds the excerpt as a text attachment; "Attach with text" also types the note at the end, linked to it.
  useEffect(() => {
    setTextSink((text, note) => {
      const key = crypto.randomUUID();
      setPastes((p) => [...p, { key, text }]);
      const t = promptRef.current!;
      const n = note?.trim();
      if (n) {
        // execCommand types into the focused element, which is still the note field in the selection bar.
        t.focus({ preventScroll: true });
        const end = t.value.length;
        const at = end + (t.value && !/\s$/.test(t.value) ? 1 : 0);
        insertAt(at > end ? `\n${n}` : n, end, end);
        linkTo(at, at + n.length, key);
      }
      t.focus();
    });
    return () => setTextSink(null);
  }, []);

  // Shortcuts elsewhere (the Browser panel) put a command in through the slash menu's own insert.
  useEffect(() => {
    setCommandSink(slash.put);
    return () => setCommandSink(null);
  }, [slash.put]);

  // The mirror follows the textarea's box (the form resizes as chips come and go above it) and its scroll.
  useLayoutEffect(() => {
    const t = promptRef.current!;
    const place = () => {
      if (mirrorRef.current && promptRef.current) placeMirror(mirrorRef.current, promptRef.current);
    };
    const onScroll = () => {
      if (mirrorRef.current && promptRef.current) mirrorRef.current.scrollTop = promptRef.current.scrollTop;
    };
    const ro = new ResizeObserver(place);
    ro.observe(t);
    ro.observe(formRef.current!);
    t.addEventListener('scroll', onScroll);
    return () => {
      ro.disconnect();
      t.removeEventListener('scroll', onScroll);
    };
  }, []);

  useLayoutEffect(paint, [links, files, pastes]);

  // A link whose attachment is gone (removed, or past the 10-file cap) goes too; the attachment never depends on it.
  useEffect(() => {
    if ((current && !owner.current) || !linksRef.current.length) return;
    const keys = new Set([...files.map((f) => f.key), ...pastes.map((p) => p.key)]);
    const next = linksRef.current.filter((l) => keys.has(l.key));
    if (next.length !== linksRef.current.length) relink(next);
  }, [files, pastes]);

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

  // Edit on an unsent message: its text goes after the draft and its attachments join the tray, links included.
  useEffect(() => {
    setDraftSink((d) => {
      if (files.length + d.files.length > 10) return false;
      const t = promptRef.current!;
      const keys = [...d.files.map((f) => f.key), ...d.pastes.map(() => crypto.randomUUID())];
      setFiles((f) => [...f, ...d.files]);
      setPastes((p) => [...p, ...d.pastes.map((text, i) => ({ key: keys[d.files.length + i]!, text }))]);
      const v = t.value;
      const gap = !v.trim() || v.endsWith('\n\n') ? '' : v.endsWith('\n') ? '\n' : '\n\n';
      const at = v.length + gap.length;
      t.focus();
      if (d.text) insertAt(gap + d.text, v.length, v.length);
      let next = linksRef.current;
      for (const l of d.links) if (keys[l.at]) next = withLink(next, at + l.start, at + l.end, keys[l.at]!);
      if (d.links.length) relink(next);
      return true;
    });
    return () => setDraftSink(null);
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
      // A drop zone in the conversation (ask_upload) took these files already.
      const taken = e.defaultPrevented;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (!taken) void attach(e.dataTransfer!.files, liveSel());
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
    setTyped(!!t.value.trim());
    grow(t);
    if (t.value.includes('\n')) return setMulti(true);
    const was = form.classList.contains('multi');
    form.classList.remove('multi');
    grow(t);
    const wraps = t.scrollHeight > 30;
    if (was) form.classList.add('multi');
    grow(t);
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
    if (shownFor.current) saveDraft(shownFor.current, t.value, linksRef.current);
    t.value = current ? drafts.get(current) ?? '' : '';
    shownFor.current = current;
    typedRef.current = t.value;
    putLinks(current ? draftLinks.get(current) ?? [] : []);
    recall.current = { i: null, draft: '' };
    setNote(null);
    sync();
    paint();
    t.focus({ preventScroll: true });
  }, [current]);

  // Another window changed this session's draft: taken unless this box is focused and was typed in since the last sync.
  useEffect(() => {
    draftSync = (id, before) => {
      const t = promptRef.current;
      if (!t || id !== shownFor.current) return;
      if (document.activeElement === t && t.value !== before) return;
      const text = drafts.get(id) ?? '';
      if (t.value === text) return;
      t.value = text;
      typedRef.current = text;
      putLinks(draftLinks.get(id) ?? []);
      recall.current = { i: null, draft: '' };
      sync();
    };
    return () => {
      draftSync = null;
    };
  }, []);

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

  // A send clears the tray at once but its parked copy only once the outbox has saved the message; parks counts
  // the parks since, so a later attachment is never wiped by that late clear.
  const holdPark = useRef(false);
  const parks = useRef(0);
  useEffect(() => {
    if (holdPark.current) return void (holdPark.current = false);
    parks.current++;
    if (owner.current) void park(owner.current, { files, pastes });
  }, [files, pastes]);

  // The reader can close after the session changed; then the edit goes to that session's parked set instead.
  const savePaste = (sid: string | null, key: string, before: string, next: string) => {
    if (next === before) return;
    const apply = (list: Paste[]) => (next.trim() ? list.map((p) => (p.key === key ? { ...p, text: next } : p)) : list.filter((p) => p.key !== key));
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
    // setRangeText fires no input event.
    fit();
    t.blur();
    t.focus();
    sync();
  };

  // Fits the links to the textarea's value after an edit; a no-op once the input handler has done it.
  const fit = () => {
    const t = promptRef.current!;
    const before = typedRef.current;
    if (before === t.value) return;
    typedRef.current = t.value;
    const had = linksRef.current.length > 0;
    putLinks(shiftLinks(linksRef.current, before, t.value, t.selectionEnd));
    if (had || t.value.includes('@') || before.includes('@')) paint();
  };

  // "Put in message": the paste goes where it was pasted, which is the caret unless it moved, or after the text it is linked to.
  const inlinePaste = (p: Paste) => {
    const t = promptRef.current!;
    const at = linksRef.current.find((l) => l.key === p.key)?.end ?? t.selectionEnd;
    insertAt(p.text, at, at);
    setPastes((ps) => ps.filter((x) => x.key !== p.key));
    if (current) saveDraft(current, t.value, linksRef.current);
  };

  // Picks from "Reference file or folder" go in at the caret as @ mentions, spaced from the text around them.
  const insertMentions = (paths: string[]) => {
    const t = promptRef.current!;
    const from = t.selectionStart;
    const to = t.selectionEnd;
    const before = t.value.slice(0, from);
    const after = t.value.slice(to);
    insertAt(`${before && !/\s$/.test(before) ? ' ' : ''}${paths.map(mentionOf).join(' ')}${/^\s/.test(after) ? '' : ' '}`, from, to);
    if (current) saveDraft(current, t.value, linksRef.current);
  };

  // "Move to attachment": the selected text leaves the box (undoable) and becomes a text attachment.
  const moveOut = (from: number, to: number) => {
    const text = promptRef.current!.value.slice(from, to).replace(/^\n+|\s+$/g, '');
    insertAt('', from, to);
    if (text) addPaste(text);
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
    const body = t.value.trim();
    const text = withSkills(body, skills);
    if (!text && !pastes.length && !files.length) return;
    // A take still running would land after the message left.
    if (dictPhase !== 'idle') return;
    // App commands (/rc, /model…) run here and never reach the model; attachments and chips stay for the next message.
    const app = slashOn ? appCommandOf(body) : null;
    if (app) {
      runApp(app.item, app.args);
      t.value = '';
      typedRef.current = '';
      putLinks([]);
      if (current) saveDraft(current, '');
      sync();
      paint();
      return;
    }
    // With no session yet, the text waits while a folder is picked.
    if (!current) return setPalette('folder');
    setNote(null);
    const extra = files.length ? { files: files.map((f) => f.upload), thumbs: files.map((f) => f.thumb) } : {};
    // Offsets move into the trimmed text; skill lines go after it, so they do not shift anything.
    const lead = t.value.length - t.value.trimStart().length;
    const order = tray.map((it) => it.key);
    const wire: TextLink[] = linksRef.current.flatMap((l) => {
      const at = order.indexOf(l.key);
      const start = Math.max(0, l.start - lead);
      const end = Math.min(body.length, l.end - lead);
      return at >= 0 && start < end ? [{ start, end, at }] : [];
    });
    const st = useStore.getState();
    const seen = getPref('replyStyle') === 'stretch' ? seenSince(st.items, st.order) : null;
    const msg: SendMsg = {
      type: 'send', id: crypto.randomUUID(), sessionId: current, text, ...(pastes.length ? { pastes: pastes.map((p) => p.text) } : {}), ...extra,
      ...(wire.length ? { links: wire } : {}), ...(seen ? { seen: seen.seen } : {}),
    };
    // Sent now or queued until the socket is back; either way the box clears.
    const saved = submitMessage(msg);
    if (seen) markReported(seen.ids);
    sent();
    t.value = '';
    typedRef.current = '';
    putLinks([]);
    recall.current = { i: null, draft: '' };
    // The saved draft and tray go only once the message itself is saved, so a reload in between loses nothing.
    const draft = drafts.get(current);
    const parksAt = parks.current;
    const parked = files.length > 0 || pastes.length > 0;
    if (parked && owner.current === current) holdPark.current = true;
    void saved.then(() => {
      if (drafts.get(current) === draft) saveDraft(current, '');
      if (parked && parks.current === parksAt) void park(current, { files: [], pastes: [] });
    });
    setPastes([]);
    setFiles([]);
    setSkills(current, []);
    sync();
  };

  const onInput = (e: FormEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    fit();
    const p = t.selectionStart;
    const ls = t.value.lastIndexOf('\n', p - 1) + 1;
    const line = t.value.slice(ls, p);
    // Markdown-style shortcut: "- " or "* " at the start of a line becomes a bullet.
    if ((e.nativeEvent as InputEvent).inputType === 'insertText' && /^\s*[-*] $/.test(line)) insertAt(line.replace(/[-*] $/, '• '), ls, p);
    else sync();
    recall.current.i = null;
    if (current) {
      saveDraft(current, t.value, linksRef.current);
      warm(current);
    }
    if (voiceInput) warmStt();
    if (slashOn) slash.onInput();
    mention.onInput();
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
    if (mention.onKeyDown(e)) return;
    if (slashOn && slash.onKeyDown(e)) return;
    // Shift+Tab cycles permission modes like the CLI; frequent, so no animation.
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const mode = nextMode(currentSummary(useStore.getState())?.mode ?? useStore.getState().defaults.mode);
      apply({ mode });
      setModeNote(`Permission mode: ${PM.find((x) => x[0] === mode)![1]}`);
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
      fit();
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
    // Text selected in the box stays and links to what was pasted.
    if (e.clipboardData.files.length) {
      e.preventDefault();
      return void attach([...e.clipboardData.files], liveSel());
    }
    const t = e.clipboardData.getData('text');
    if (t.length < PASTE_CHARS && lineCount(t) < PASTE_LINES) return void setTimeout(sync);
    e.preventDefault();
    addPaste(t, liveSel());
  };

  const isMulti = multi || pastes.length > 0 || files.length > 0 || skills.length > 0 || !!note;
  useAutosize(promptRef, isMulti);
  const stop = working && !hold && !typed && !pastes.length && !files.length && !skills.length;
  return (
    <form className={`input rise${isMulti ? ' multi' : ''}${dragging ? ' drop' : ''}${hold ? ' held' : ''}`} ref={formRef} onSubmit={submit} data-dict={voiceInput && dictPhase !== 'idle' ? dictPhase : undefined}>
      {(pastes.length > 0 || files.length > 0 || skills.length > 0) && (
        <div className="pastes">
          {skills.map((s) => (
            <SkillChip key={s.path} skill={s} onRemove={() => { setSkills(skillKey, skills.filter((x) => x !== s)); promptRef.current!.focus(); }} />
          ))}
          {files.map((f, i) => (
            <FileChip key={f.key} num={i + 1} file={{ name: f.upload.name, kind: f.upload.kind, ...(f.thumb ? { thumb: f.thumb, src: fullOf(f.upload) } : {}) }} onRemove={() => { setFiles(files.filter((x) => x !== f)); promptRef.current!.focus(); }} />
          ))}
          {pastes.map((p, i) => (
            <PasteChip
              key={p.key} num={files.length + i + 1} text={p.text} onEdit={(next) => savePaste(current, p.key, p.text, next)} onInline={() => inlinePaste(p)}
              onRemove={() => { setPastes(pastes.filter((x) => x !== p)); promptRef.current!.focus(); }}
            />
          ))}
        </div>
      )}
      {note && (
        <div className="cmp-note" role="status">
          <span>{note}</span>
          <button type="button" className="x" aria-label="Dismiss" title="Dismiss" onClick={() => { setNote(null); promptRef.current?.focus(); }}>×</button>
        </div>
      )}
      <div className="lk-mirror" ref={mirrorRef} aria-hidden="true" />
      <textarea ref={promptRef} rows={1} placeholder={hold ? `${hold}… your message will send after` : working ? 'Queue a message…' : 'Ask anything'} autoComplete="off" aria-label="Message" autoFocus onInput={onInput} onKeyDown={onKeyDown} onPaste={onPaste} onPointerDown={voiceInput ? warmStt : undefined} />
      <LinkTools
        promptRef={promptRef} mirrorRef={mirrorRef} links={links} tray={tray} paint={paint} onLink={linkTo} onMove={moveOut}
        onUnlink={(l) => relink(linksRef.current.filter((x) => x.key !== l.key || x.start !== l.start))}
      />
      <div className="tools">
        {slashOn && slash.argHint}
        <ClipMenu
          icon={<ClipIcon />} sessionId={current}
          // Text selected before the click links to the uploaded file.
          onArm={() => (pickSel.current = liveSel())}
          onUpload={() => pickRef.current?.click()}
          onPick={insertMentions}
        />
        <input
          ref={pickRef} type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.json,.ts,.tsx,.js,.jsx,.py,.rs,.go,.yaml,.yml,.toml,.csv,.log,.sh,.sql,.html,.css"
          onChange={(e) => {
            const list = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = '';
            void attach(list, pickSel.current);
            pickSel.current = null;
          }}
        />
        <BoardButton />
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
        {stop ? (
          <button type="button" className="send stop" aria-label="Stop" title="Stop (Esc)" data-robot-react="tense" onClick={() => current && send({ type: 'interrupt', sessionId: current })}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" fill="var(--on-fill,#fff)" /></svg>
          </button>
        ) : (
          <button type="submit" className="send" disabled={dictPhase !== 'idle'} data-robot-react="happy" aria-label={hold ? 'Send after the handoff' : 'Send'} title={hold ? 'Sends after the handoff' : 'Send'}>
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 12V2M3 6l4-4 4 4" fill="none" stroke="var(--on-fill,#fff)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
        <span className="sr" aria-live="polite">{modeNote}</span>
      </div>
      {slashOn && slash.panel}
      {mention.panel}
    </form>
  );
}
