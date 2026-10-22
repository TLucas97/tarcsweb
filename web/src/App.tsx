import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { currentSummary, setPalette, useStore } from './store.ts';
import { openSession, send, showStart } from './socket.ts';
import { closeByKey } from './actions.ts';
import { overlayOpen } from './escape.ts';
import { Conversation } from './Conversation.tsx';
import { Composer } from './Composer.tsx';
import { Dock, visibleTabs } from './Dock.tsx';
import { Agents } from './Agents.tsx';
import { SessionMap } from './SessionMap.tsx';
import { BranchIcon, HomeIcon, baseName } from './bits.tsx';
import { ImageViewer } from './ImageViewer.tsx';
import { FocusView, loadFocusBody } from './Focus.tsx';
import { VoicePlayer, VoiceQueue } from './Voice.tsx';
import { Toasts } from './HandoffCard.tsx';
import { HeadsUps } from './HeadsUps.tsx';
import { TurnStrip } from './Working.tsx';
import { loadUiDraw } from './UiBlock.tsx';
import { Backdrop } from './Backdrop.tsx';
import { ClickRipple } from './Ripple.tsx';
import { useDesktopNotices } from './Notify.ts';
import { FindTrigger } from './Find.tsx';
import { FilesTrigger } from './FileTree.tsx';
import { ConnectGate, SettingsButton } from './SettingsEntry.tsx';
import { useFavicon } from './favicon.ts';
import { Boot } from './Boot.tsx';
import { WatchMount, WatchTrigger } from './watch/Entry.tsx';
import { BrowserMount, BrowserTrigger } from './browser/Entry.tsx';
import { RemoteChip } from './Remote.tsx';
import { UpdateNotice } from './Update.tsx';
import { WidgetsMount } from './widgets/Entry.tsx';
import { TourMount } from './tour/Entry.tsx';
import { LiteSuggest } from './LiteEntry.tsx';
import { ChunkGuard, StaleBar } from './Stale.tsx';
import { answerAsk, isAnswering } from './answering.ts';

// Not on the first paint: these load after it, or on first use.
const loadPalette = () => import('./Palette.tsx');
const Palette = lazy(() => loadPalette().then((m) => ({ default: m.Palette })));
const ReplayViewer = lazy(() => import('./Replay.tsx').then((m) => ({ default: m.ReplayViewer })));
const ExplainPanel = lazy(() => import('./Explain.tsx').then((m) => ({ default: m.ExplainPanel })));
const ExplainButton = lazy(() => import('./Explain.tsx').then((m) => ({ default: m.ExplainButton })));

// Mounts its child the first time `on` is true and keeps it, so its close animation still plays.
function Later({ on, children }: { on: boolean; children: ReactNode }) {
  const [ever, setEver] = useState(on);
  if (on && !ever) setEver(true);
  return ever || on ? <ChunkGuard><Suspense fallback={null}>{children}</Suspense></ChunkGuard> : null;
}

function PaletteMount() {
  const on = useStore((s) => s.palette !== null);
  return <Later on={on}><Palette /></Later>;
}

function ReplayMount() {
  const on = useStore((s) => s.replayView !== null);
  return <Later on={on}><ReplayViewer /></Later>;
}

// Ctrl+K and the first reader or ui block should not wait on the network.
function usePreload() {
  useEffect(() => {
    const run = () => void Promise.all([loadPalette(), loadFocusBody(), loadUiDraw()]).catch(() => {});
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(run, { timeout: 4000 });
      return () => cancelIdleCallback(id);
    }
    const t = setTimeout(run, 1500);
    return () => clearTimeout(t);
  }, []);
}

// Its own component, so a favicon state change never re-renders the App tree.
function Favicon() {
  useFavicon();
  return null;
}

// Shown only while a session is on screen; the session keeps running after you leave it.
function HomeTrigger() {
  return (
    <button className="fnd-open" onClick={showStart} title="Back to Start" aria-label="Back to Start">
      <HomeIcon />
    </button>
  );
}

function Title() {
  const summary = useStore(currentSummary);
  const connected = useStore((s) => s.connected);
  // Errors from dock actions; the palette shows its own.
  const notice = useStore((s) => (s.palette ? null : s.notice));
  const info = useStore((s) => s.noticeInfo);
  const name = summary?.name;
  const folder = summary ? baseName(summary.cwd) : '';
  // A dot in the tab title when any session waits for an answer, so a background tab still says so.
  const waiting = useStore((s) => s.roster.some((r) => r.needsYou));

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => useStore.setState({ notice: null }), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    document.title = `${waiting ? '● ' : ''}${name ? `${name} · ${folder}` : 'agent'}`;
  }, [name, folder, waiting]);

  return (
    <div className="title rise">
      <VoicePlayer />
      {/* Its own row only while the voice player sits above it; otherwise display: contents. */}
      <div className="trow">
        {summary && (
          <>
            <b title={summary.name}>{summary.name}</b>
            {summary.branch && <span className="br mono" title={summary.branch}><BranchIcon /><span className="bt">{summary.branch}</span></span>}
            <RemoteChip />
            <FindTrigger />
            <FilesTrigger />
            <BrowserTrigger />
            <WatchTrigger />
            <HomeTrigger />
          </>
        )}
        {!summary && <BrowserTrigger />}
        <SettingsButton />
        {!connected && <span className="br">Reconnecting…</span>}
      </div>
      {notice && (info ? <span className="br tn" role="status" title={notice}>{notice}</span> : <span className="br tn bad" role="alert" title={notice}>{notice}</span>)}
    </div>
  );
}

// The oldest open permission whose card is on screen in the conversation; questions and plans answer from their own card.
function visibleAsk(s: ReturnType<typeof useStore.getState>) {
  if (!s.asks) return null;
  const conv = document.querySelector('.conv')?.getBoundingClientRect();
  if (!conv) return null;
  for (const k of s.order) {
    const it = s.items[k];
    if (it?.kind !== 'permission' || it.answer !== null || it.questions || it.plan !== undefined) continue;
    const id = CSS.escape(it.id);
    const el = document.querySelector(`.conv .ask[data-id="${id}"], .conv .askd[data-id="${id}"] > .ask`);
    const r = el?.getBoundingClientRect();
    // Skipped while an answer is on its way or the Deny… reason box is open.
    if (r && r.bottom > conv.top && r.top < conv.bottom) return isAnswering(it.id) || el!.querySelector('.ask-why') ? null : it;
  }
  return null;
}

// Alt+1…9 picks a dock tab, Alt+[ / Alt+] the one beside the current, Alt+` the session shown before it. True when it acted.
function dockKey(e: KeyboardEvent, current: string | null, recent: string[]) {
  const tabs = visibleTabs();
  const go = (id: string | undefined) => {
    if (id && id !== current) openSession(id);
    return true;
  };
  // macOS Option+digit types a character (¡, ™…); only the plain digit or a non-printing key counts.
  if (/^Digit[1-9]$/.test(e.code) && (e.key === e.code[5] || e.key.length !== 1)) return go(tabs[Number(e.code[5]) - 1]);
  if (e.key === '`' || (e.key.length !== 1 && e.code === 'Backquote')) return go(recent.find((id) => id !== current));
  const dir = e.key === '[' || (e.key.length !== 1 && e.code === 'BracketLeft') ? -1 : e.key === ']' || (e.key.length !== 1 && e.code === 'BracketRight') ? 1 : 0;
  if (!dir || !tabs.length) return false;
  const i = current ? tabs.indexOf(current) : -1;
  return go(tabs[i < 0 ? (dir > 0 ? 0 : tabs.length - 1) : (i + dir + tabs.length) % tabs.length]);
}

// Ctrl/Cmd+K switches, Alt+N starts a session, Alt+W closes it; Enter allows and n denies a visible ask; Esc stops a turn.
function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        return setPalette(s.palette ? null : 'switch');
      }
      if (e.altKey && (e.key.toLowerCase() === 'n' || e.code === 'KeyN')) {
        e.preventDefault();
        return setPalette('folder');
      }
      if (s.palette || s.replayView || document.querySelector(':popover-open')) return;
      const covered = () => e.defaultPrevented || !!s.viewer || overlayOpen() || !!document.querySelector('[aria-modal="true"]');
      if (e.altKey && !e.ctrlKey && !e.metaKey && !covered() && dockKey(e, s.current, s.recent)) return e.preventDefault();
      if (!s.current) return;
      if (e.key === 'Escape' && s.status === 'working') return void send({ type: 'interrupt', sessionId: s.current });
      // Not Ctrl+W: the browser closes the tab on that.
      if (e.altKey && e.code === 'KeyW') {
        e.preventDefault();
        return closeByKey(s.current);
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const prompt = document.querySelector<HTMLTextAreaElement>('.input textarea');
      const active = document.activeElement;
      if (active !== document.body && active !== prompt) return;
      const ask = (e.key === 'Enter' || e.key === 'n') && !prompt?.value && !document.querySelector('.input .pchip') ? visibleAsk(s) : null;
      if (ask && e.key === 'Enter' && !ask.defaultToNo) {
        e.preventDefault();
        return void answerAsk(s.current, ask.id, true);
      }
      if (ask && e.key === 'n' && active !== prompt) {
        e.preventDefault();
        return void answerAsk(s.current, ask.id, false);
      }
      // Typing with nothing focused goes to the message box. Space stays a page key.
      if (active === document.body && prompt && e.key.length === 1 && e.key !== ' ' && !covered()) {
        e.preventDefault();
        prompt.focus();
        prompt.setSelectionRange(prompt.value.length, prompt.value.length);
        // execCommand fires the input event the composer saves drafts from, and keeps Ctrl+Z.
        if (!document.execCommand('insertText', false, e.key)) {
          prompt.setRangeText(e.key, prompt.value.length, prompt.value.length, 'end');
          prompt.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  useGlobalKeys();
  useDesktopNotices();
  usePreload();
  return (
    <>
      <Backdrop />
      <ClickRipple />
      <Dock />
      <Title />
      <Conversation />
      <Agents />
      <SessionMap />
      <VoiceQueue />
      <Toasts />
      <UpdateNotice />
      <LiteSuggest />
      <HeadsUps />
      <TurnStrip />
      <ChunkGuard>
        <Suspense fallback={null}>
          <ExplainPanel />
          <ExplainButton />
        </Suspense>
      </ChunkGuard>
      <WidgetsMount />
      <Composer />
      <PaletteMount />
      <ReplayMount />
      <FocusView />
      <ImageViewer />
      <WatchMount />
      <BrowserMount />
      <ConnectGate />
      <TourMount />
      <Favicon />
      <StaleBar />
      <Boot />
    </>
  );
}
