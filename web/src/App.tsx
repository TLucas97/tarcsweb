import { useEffect } from 'react';
import { currentSummary, setPalette, useStore } from './store.ts';
import { send, showStart } from './socket.ts';
import { closeSession } from './actions.ts';
import { Conversation } from './Conversation.tsx';
import { Composer } from './Composer.tsx';
import { Dock } from './Dock.tsx';
import { Palette } from './Palette.tsx';
import { Agents } from './Agents.tsx';
import { SessionMap } from './SessionMap.tsx';
import { BranchIcon, HomeIcon, baseName } from './bits.tsx';
import { ReplayViewer } from './Replay.tsx';
import { ImageViewer } from './ImageViewer.tsx';
import { FocusView } from './Focus.tsx';
import { VoicePlayer, VoiceQueue } from './Voice.tsx';
import { Toasts } from './HandoffCard.tsx';
import { HeadsUps } from './HeadsUps.tsx';
import { TurnStrip } from './Working.tsx';
import { ExplainButton, ExplainPanel } from './Explain.tsx';
import { Backdrop } from './Backdrop.tsx';
import { ClickRipple } from './Ripple.tsx';
import { useDesktopNotices } from './Notify.ts';
import { FindTrigger } from './Find.tsx';
import { FilesTrigger } from './FileTree.tsx';
import { ConnectGate, SettingsButton } from './SettingsEntry.tsx';
import { useFavicon } from './favicon.ts';
import { Boot } from './Boot.tsx';
import { WatchMount, WatchTrigger } from './watch/Entry.tsx';
import { RemoteChip } from './Remote.tsx';
import { UpdateNotice } from './Update.tsx';
import { WidgetsMount } from './widgets/Entry.tsx';
import { TourMount } from './tour/Entry.tsx';

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
            <WatchTrigger />
            <HomeTrigger />
          </>
        )}
        <SettingsButton />
        {!connected && <span className="br">Reconnecting…</span>}
      </div>
      {notice && (info ? <span className="br tn" role="status" title={notice}>{notice}</span> : <span className="br tn bad" role="alert" title={notice}>{notice}</span>)}
    </div>
  );
}

// Ctrl/Cmd+K switches, Alt+N starts a session, Alt+W closes it; Enter allows and n denies the oldest ask; Esc stops a turn.
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
      if (s.palette || s.replayView || document.querySelector(':popover-open') || !s.current) return;
      if (e.key === 'Escape' && s.status === 'working') return void send({ type: 'interrupt', sessionId: s.current });
      // Not Ctrl+W: the browser closes the tab on that.
      if (e.altKey && e.code === 'KeyW') {
        e.preventDefault();
        return closeSession(s.current);
      }
      const prompt = document.querySelector<HTMLTextAreaElement>('.input textarea');
      const active = document.activeElement;
      if (active !== document.body && active !== prompt) return;
      if (prompt?.value || document.querySelector('.input .pchip')) return;
      const id = s.order.find((i) => { const it = s.items[i]; return it.kind === 'permission' && it.answer === null; });
      const ask = id ? s.items[id] : null;
      // Questions and plans take their answer from their own card.
      if (!ask || ask.kind !== 'permission' || ask.questions || ask.plan !== undefined) return;
      if (e.key === 'Enter' && !ask.defaultToNo) {
        e.preventDefault();
        send({ type: 'permission-answer', sessionId: s.current, id: ask.id, allow: true });
      }
      if (e.key === 'n' && active !== prompt) send({ type: 'permission-answer', sessionId: s.current, id: ask.id, allow: false });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  useGlobalKeys();
  useDesktopNotices();
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
      <HeadsUps />
      <TurnStrip />
      <ExplainPanel />
      <ExplainButton />
      <WidgetsMount />
      <Composer />
      <Palette />
      <ReplayViewer />
      <FocusView />
      <ImageViewer />
      <WatchMount />
      <ConnectGate />
      <TourMount />
      <Favicon />
      <Boot />
    </>
  );
}
