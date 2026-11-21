import { useEffect, useState, type CSSProperties } from 'react';
import { create } from 'zustand';
import type { DesktopInstallState, DesktopShellMessage } from '../../server/protocol.ts';
import { inTauri, invoke, errorText, listenDesktopUpdate, installDesktopUpdate, type DesktopBuild, type DesktopUpdate } from './tauri.ts';
import { useLayoutVars } from './layoutVars.ts';
import { updateNoticeKind, useUpdate } from './releases.ts';

// shell: set when the server runs inside the desktop app, so this Chrome window offers its rebuild instead of an install.
const useDesktop = create<{ state: DesktopInstallState; dismissed: boolean; dismissing: boolean; shell: Omit<DesktopShellMessage, 'type'> | null }>(() => ({
  state: { phase: 'checking' }, dismissed: true, dismissing: false, shell: null,
}));
let socket: WebSocket | null = null;
let users = 0;
let retry = 0;

function connect() {
  if (socket || !users || inTauri()) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?desktop-install=1`);
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'desktop-install-status' }));
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'desktop-install') useDesktop.setState({ state: message.state, dismissed: message.dismissed, dismissing: false });
    if (message.type === 'desktop-shell') useDesktop.setState({ shell: { build: message.build, status: message.status } });
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    useDesktop.setState({ state: { phase: 'failed', message: 'The connection closed. Check that tarcsweb is running and try again.' }, dismissing: false });
    if (users) retry = window.setTimeout(connect, 3000);
  };
}

function useDesktopInstall() {
  useEffect(() => {
    if (inTauri()) return;
    users++;
    connect();
    return () => {
      if (--users) return;
      clearTimeout(retry);
      const ws = socket;
      socket = null;
      ws?.close();
    };
  }, []);
  return useDesktop();
}

function start() {
  const phase = useDesktop.getState().state.phase;
  if (phase === 'checking' || phase === 'downloading' || phase === 'opening' || phase === 'done' || phase === 'unavailable') return;
  if (socket?.readyState !== WebSocket.OPEN) {
    useDesktop.setState({ state: { phase: 'failed', message: 'Could not connect. Check that tarcsweb is running and try again.' } });
    connect();
    return;
  }
  useDesktop.setState({ state: { phase: 'downloading', progress: 0 } });
  socket.send(JSON.stringify({ type: 'desktop-install-start' }));
}

function dismiss() {
  if (useDesktop.getState().dismissing) return;
  if (socket?.readyState !== WebSocket.OPEN) {
    useDesktop.setState({ state: { phase: 'failed', message: 'Could not save this choice. Check that tarcsweb is running and try again.' } });
    return;
  }
  useDesktop.setState({ dismissing: true });
  socket.send(JSON.stringify({ type: 'desktop-install-dismiss' }));
}

const buttonStyle: CSSProperties = { width: 200, maxWidth: '100%', fontVariantNumeric: 'tabular-nums' };

function InstallButton({ state, notice = false }: { state: DesktopInstallState; notice?: boolean }) {
  const pending = state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'opening';
  const label = state.phase === 'checking' ? 'Checking release…'
    : state.phase === 'downloading' ? `Downloading… ${state.progress ?? 0}%`
      : state.phase === 'opening' ? 'Opening installer…'
        : state.phase === 'done' ? 'Installer opened'
          : state.phase === 'failed' ? 'Try again'
            : notice ? 'Install' : 'Install desktop app';
  return <button type="button" className="set-btn" style={buttonStyle} disabled={pending || state.phase === 'done'} aria-busy={pending} onClick={start}>{label}</button>;
}

function InstallFeedback({ state }: { state: DesktopInstallState }) {
  if (state.phase !== 'failed' && state.phase !== 'done' && state.phase !== 'unavailable') return null;
  const next = state.platform === 'macos' ? 'Drag tarcsweb to Applications, then open it.'
    : state.platform === 'wsl' ? 'Follow the installer, then open tarcsweb from the Start menu.'
      : 'Open tarcsweb from the app launcher.';
  return <p className={state.phase === 'failed' ? 'set-err' : 'set-hint'} style={{ marginTop: 8 }}>
    {state.message || (state.phase === 'done' ? next : state.phase === 'unavailable' ? 'The latest release has no desktop installer for this platform.' : 'Could not install the desktop app. Try again.')}
  </p>;
}

function rebuildFromChrome() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'desktop-shell-rebuild' }));
}

// The Tauri window's rebuild section, for a Chrome window the desktop app opened; the shell does the build.
function ShellRebuildSection({ shell }: { shell: NonNullable<ReturnType<typeof useDesktop.getState>['shell']> }) {
  const { build, status } = shell;
  const pending = status.phase === 'building' || status.phase === 'restarting';
  const label = status.phase === 'building' ? 'Rebuilding…' : status.phase === 'restarting' ? 'Restarting…'
    : status.phase === 'failed' ? 'Try again' : 'Rebuild from source';
  return <div className="set-f">
    <div className="set-card" aria-live="polite" aria-atomic="true">
      <p className="set-hint">{build.version ? `Version ${build.version}` : 'Desktop app'}</p>
      {build.canRebuild && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="set-btn" style={buttonStyle} disabled={pending} aria-busy={pending} onClick={rebuildFromChrome}>{label}</button>
        <span className="set-hint">{build.commit ?? 'Commit unavailable'}{build.dirty ? ' with local changes' : ''}</span>
      </div>}
      {status.phase === 'restarting' && <p className="set-hint">The desktop app is restarting with the new build.</p>}
      {status.message && <p className={status.phase === 'failed' ? 'set-err' : 'set-hint'} style={{ overflowWrap: 'anywhere' }}>{status.message}</p>}
      {status.logPath && <p className="set-hint" style={{ overflowWrap: 'anywhere' }}>Log: {status.logPath}</p>}
    </div>
  </div>;
}

export function DesktopInstallSection() {
  const { state, shell } = useDesktopInstall();
  if (inTauri()) return <DesktopUpdateSection />;
  if (shell) return <ShellRebuildSection shell={shell} />;
  return <div className="set-f" data-desktop-install={state.phase}>
    <div className="set-card" aria-live="polite" aria-atomic="true">
      {state.phase !== 'unavailable' && <InstallButton state={state} />}
      <InstallFeedback state={state} />
    </div>
  </div>;
}

const useDesktopUpdate = create<{ build: DesktopBuild | null; status: DesktopUpdate }>(() => ({
  build: null, status: { phase: 'idle' },
}));

function DesktopUpdateSection() {
  const { build, status } = useDesktopUpdate();
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenDesktopUpdate((status) => useDesktopUpdate.setState({ status })).then((stop) => {
      if (!active) stop();
      else unlisten = stop;
    });
    void Promise.all([invoke<DesktopBuild>('desktop_info'), invoke<DesktopUpdate | null>('update_status')])
      .then(([build, status]) => {
        if (active) useDesktopUpdate.setState({ build, status: status ?? { phase: 'idle' } });
      }).catch((error) => {
        if (active) useDesktopUpdate.setState({ status: { phase: 'failed', message: errorText(error, 'Could not read desktop build information') } });
      });
    return () => { active = false; unlisten?.(); };
  }, []);
  const pending = ['checking', 'building', 'downloading', 'installing', 'restarting'].includes(status.phase);
  const source = build?.kind === 'source';
  const label = status.phase === 'checking' ? 'Checking…'
    : status.phase === 'building' ? 'Rebuilding…'
      : status.phase === 'downloading' ? `Downloading…${status.progress == null ? '' : ` ${status.progress}%`}`
        : status.phase === 'installing' ? 'Installing…'
          : status.phase === 'restarting' ? 'Restarting…'
            : status.phase === 'available' ? 'Update and restart'
              : status.phase === 'failed' ? 'Try again'
                : source ? 'Rebuild from source' : 'Check for updates';
  const run = async () => {
    if (!build || pending) return;
    const install = status.phase === 'available';
    useDesktopUpdate.setState({ status: { phase: source ? 'building' : install ? 'downloading' : 'checking' } });
    try {
      if (source) {
        const current = await invoke<DesktopBuild>('desktop_info');
        useDesktopUpdate.setState({ build: current });
        await invoke('rebuild');
      } else if (install) await installDesktopUpdate();
      else await invoke('check_update');
    } catch (error) {
      useDesktopUpdate.setState({ status: { phase: 'failed', message: errorText(error, 'Could not update the desktop app') } });
    }
  };
  return <div className="set-f">
    <div className="set-card" aria-live="polite" aria-atomic="true">
      <p className="set-hint">{build ? `Version ${build.version}` : 'Desktop app'}</p>
      {build && (!source || build.canRebuild) && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="set-btn" style={buttonStyle} disabled={pending} aria-busy={pending} onClick={() => void run()}>{label}</button>
        {source && <span className="set-hint">{build.commit ?? 'Commit unavailable'}{build.dirty ? ' with local changes' : ''}</span>}
      </div>}
      {status.phase === 'available' && <p className="set-hint">Version {status.version} is available.</p>}
      {status.phase === 'latest' && <p className="set-hint">You have the latest version</p>}
      {status.message && <p className={status.phase === 'failed' ? 'set-err' : 'set-hint'} style={{ overflowWrap: 'anywhere' }}>{status.message}</p>}
      {status.logPath && <p className="set-hint" style={{ overflowWrap: 'anywhere' }}>Log: {status.logPath}</p>}
    </div>
  </div>;
}

export function DesktopInstallNotice() {
  const { state, dismissed, dismissing } = useDesktopInstall();
  const updateVisible = useUpdate((s) => updateNoticeKind(s) !== null);
  const [offered, setOffered] = useState(false);
  const notice = useLayoutVars<HTMLElement>();
  useEffect(() => {
    if (state.phase === 'ready' && !dismissed) setOffered(true);
  }, [state.phase, dismissed]);
  const visible = !inTauri() && !dismissed && offered && !updateVisible;
  if (!visible) return null;
  return <aside ref={notice} className="stale" aria-label="Desktop app" data-desktop-notice onKeyDown={(event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  }} style={{
    left: 'auto', top: 'auto', right: 20, bottom: 'calc(var(--ch,54px) + var(--gap) * 2 + 40px)', transform: 'none', zIndex: 2,
    width: 360, maxWidth: 'calc(100vw - 40px)', alignItems: 'stretch', flexDirection: 'column', padding: 14,
  }}>
    <p style={{ margin: 0 }}>Install tarcsweb as a desktop app. It stays available in Settings.</p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} aria-live="polite" aria-atomic="true">
      {state.phase !== 'unavailable' && <InstallButton state={state} notice />}
      <button type="button" disabled={dismissing} onClick={dismiss}>{dismissing ? 'Saving…' : 'Not now'}</button>
      <InstallFeedback state={state} />
    </div>
  </aside>;
}
