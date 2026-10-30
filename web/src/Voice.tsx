import { useEffect, useRef, useState } from 'react';
import { dismissRecap, openReplay, useStore, type VoiceTrack } from './store.ts';
import { openSession, send } from './socket.ts';
import { XIcon } from './bits.tsx';
import { useLite } from './perf.ts';
import { PREFS, getPref, setPref, usePref, type PrefValue } from './prefs.ts';

type Phase = VoiceTrack['phase'];
type Rate = PrefValue<'voiceRate'>;

const icon = (d: string, fill = false) => () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const PlayIcon = icon('M4.5 3v8l6.5-4z', true);
const PauseIcon = icon('M5 3.2v7.6M9 3.2v7.6');
const ReplayIcon = icon('M2.8 7a4.2 4.2 0 1 0 1.3-3M2.6 1.8v2.6h2.6');
const StopIcon = icon('M4 4h6v6H4z', true);
const SpeakerIcon = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" />
    <path d="M10.6 5.6a3.2 3.2 0 0 1 0 4.8M12.4 4a5.6 5.6 0 0 1 0 8" />
  </svg>
);

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const RATES = PREFS.voiceRate.values;
// Missing in some embedded browsers.
const media = typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null;

// One audio element for recaps and replay summaries, so only one voice ever speaks; the store holds what it plays.
let audio: HTMLAudioElement | null = null;

function setPhase(phase: Phase) {
  const t = useStore.getState().voiceTrack;
  if (!t) return;
  if (t.phase !== phase) useStore.setState({ voiceTrack: { ...t, phase } });
  if (media) media.playbackState = phase === 'playing' ? 'playing' : 'paused';
}

function player() {
  if (audio) return audio;
  const a = (audio = new Audio());
  a.addEventListener('play', () => setPhase('playing'));
  a.addEventListener('pause', () => !a.ended && setPhase('paused'));
  a.addEventListener('ended', () => setPhase('done'));
  a.addEventListener('error', () => a.getAttribute('src') && setPhase('failed'));
  // Headset and keyboard media keys, and the desktop's media controls.
  const on = (action: MediaSessionAction, fn: MediaSessionActionHandler) => {
    try {
      media?.setActionHandler(action, fn);
    } catch {}
  };
  on('play', () => useStore.getState().voiceTrack?.phase !== 'playing' && toggle());
  on('pause', () => a.pause());
  on('stop', () => closeTrack());
  on('seekbackward', (d) => seekTo(a.currentTime - (d.seekOffset ?? 10)));
  on('seekforward', (d) => seekTo(a.currentTime + (d.seekOffset ?? 10)));
  return a;
}

const applyRate = (a: HTMLAudioElement, rate: Rate = getPref('voiceRate')) => {
  a.defaultPlaybackRate = rate;
  a.playbackRate = rate;
};

// Autoplay can be refused when the clip lands long after the click; the player then waits for one.
const start = () => player().play().catch((err: unknown) => err instanceof DOMException && err.name === 'NotAllowedError' && setPhase('blocked'));

export function playTrack(t: Omit<VoiceTrack, 'phase'>) {
  const a = player();
  const prev = useStore.getState().voiceTrack;
  if (prev?.kind === 'recap' && prev.id !== t.id) dismissRecap(prev.id);
  useStore.setState({ voiceTrack: { ...t, phase: 'playing' } });
  if (a.getAttribute('src') !== t.url) a.src = t.url;
  else a.currentTime = 0;
  applyRate(a);
  if (media && typeof MediaMetadata === 'function') {
    const s = useStore.getState();
    const title = t.kind === 'replay' ? s.replays[t.id]?.title || 'Replay summary' : 'Recap';
    media.metadata = new MediaMetadata({ title, artist: s.roster.find((r) => r.id === t.sessionId)?.name ?? 'tarcsweb' });
  }
  void start();
}

export function closeTrack() {
  const t = useStore.getState().voiceTrack;
  if (!t) return;
  useStore.setState({ voiceTrack: null });
  if (t.kind === 'recap') dismissRecap(t.id);
  const a = player();
  a.pause();
  a.removeAttribute('src');
  a.load();
  if (media) {
    media.metadata = null;
    media.playbackState = 'none';
  }
}

function toggle() {
  const t = useStore.getState().voiceTrack;
  if (!t) return;
  const a = player();
  if (t.phase === 'playing') return a.pause();
  if (a.ended) a.currentTime = 0;
  void start();
}

function restart() {
  player().currentTime = 0;
  void start();
}

function seekTo(at: number) {
  const a = player();
  if (!a.duration) return;
  a.currentTime = Math.min(Math.max(0, at), a.duration);
  if (useStore.getState().voiceTrack?.phase === 'done') setPhase('paused');
}

// Whole seconds only, so a label re-renders once a second at most.
function useClock(active: boolean) {
  const [at, setAt] = useState({ t: 0, d: 0 });
  useEffect(() => {
    if (!active) return;
    const a = player();
    const tick = () => setAt((x) => {
      const t = Math.floor(a.currentTime);
      const d = Math.floor(a.duration || 0);
      return x.t === t && x.d === d ? x : { t, d };
    });
    tick();
    a.addEventListener('timeupdate', tick);
    a.addEventListener('durationchange', tick);
    return () => {
      a.removeEventListener('timeupdate', tick);
      a.removeEventListener('durationchange', tick);
    };
  }, [active]);
  return at;
}

// Cycles 1× → 1.25× → 1.5× → 2× → 3×; kept in this browser for every clip.
function RateBtn({ className }: { className: string }) {
  const rate = usePref('voiceRate');
  const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length]!;
  const click = () => {
    setPref('voiceRate', next);
    if (audio) applyRate(audio, next);
  };
  return (
    <button type="button" className={`${className} vrate`} onClick={click} aria-label={`Speed ${rate}×, change to ${next}×`} title={`Speed: click for ${next}×`}>
      {rate}×
    </button>
  );
}

// Listen button of one finished reply: asks for its recap, or replays it while the player holds it.
export function ListenBtn({ id, text }: { id: string; text: string }) {
  const on = useStore((s) => s.voiceOn);
  const state = useStore((s) => (s.recaps.length ? s.recaps.find((r) => r.reply === id && r.sessionId === s.current)?.state : undefined));
  // The server refuses recaps in Lite.
  const lite = useLite();
  if (!on || lite) return null;
  const busy = state === 'preparing';
  const click = () => {
    if (busy) return;
    const s = useStore.getState();
    const clip = s.recaps.find((r) => r.reply === id && r.sessionId === s.current);
    if (clip && s.voiceTrack?.id === clip.id) return restart();
    if (clip || !s.current) return;
    // The request that led to this reply is the closest user message above it.
    let prompt = '';
    for (let i = s.order.indexOf(id) - 1; i >= 0; i--) {
      const item = s.items[s.order[i]!];
      if (item?.kind === 'user') {
        prompt = item.text;
        break;
      }
    }
    // Set after the send: the answer comes back on a later message, and a send that failed leaves no request.
    const sent = send({ type: 'voice-recap', sessionId: s.current, reply: id, prompt, text });
    useStore.setState({ recapWant: sent ? `${s.current}:${id}` : null });
  };
  return (
    <button
      type="button" className={`cpb${busy ? ' busy' : ''}`} aria-busy={busy} aria-label={busy ? 'Preparing recap' : state ? 'Replay recap' : 'Listen to a recap'}
      title={busy ? 'Preparing the recap…' : state ? 'Play the recap again' : 'Listen to a short spoken recap'} onClick={click}
    >
      {busy ? <span className="g spin"></span> : <SpeakerIcon size={13} />}
      <span>{busy ? 'Preparing' : state ? 'Replay' : 'Listen'}</span>
    </button>
  );
}

const STEP = { script: 'Writing the summary…', audio: 'Recording the voice…' } as const;

// The replay viewer's Listen button: one spoken summary of the whole replay, made once by the server and cached per replay.
// It drives the shared player, so closing the viewer leaves the summary playing in the header.
export function ReplayListen({ replayKey }: { replayKey: string }) {
  const on = useStore((s) => s.voiceOn);
  const v = useStore((s) => s.replayVoices[replayKey]);
  const phase = useStore((s) => (s.voiceTrack?.id === replayKey ? s.voiceTrack.phase : null));
  const at = useClock(phase !== null);
  const lite = useLite();

  // Making it can pass a minute, so the wait shows its elapsed time.
  const preparing = v?.state === 'preparing';
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!preparing) return;
    const t0 = Date.now();
    setSecs(0);
    const timer = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [preparing]);

  if (on === null || lite) return null;
  const request = () => {
    if (phase) closeTrack();
    const cut = replayKey.indexOf(':');
    useStore.setState((s) => {
      const { [replayKey]: _old, ...rest } = s.replayVoices;
      return { replayVoices: rest, voiceWant: replayKey };
    });
    send({ type: 'replay-voice', sessionId: replayKey.slice(0, cut), id: replayKey.slice(cut + 1) });
  };
  const ask = () => (v?.state === 'ready' && v.url ? playTrack({ kind: 'replay', id: replayKey, sessionId: v.sessionId, url: v.url, text: v.text }) : request());

  if (preparing) {
    return (
      <button type="button" className="rp-say busy" aria-busy="true" aria-disabled="true" title="This takes up to a minute or two; you can keep reading or close the replay">
        <span className="spin" aria-hidden="true"></span>
        <span aria-live="polite">{STEP[v.step ?? 'script']}</span>
        {secs >= 10 && <span className="rp-say-t" aria-hidden="true">{clock(secs)}</span>}
      </button>
    );
  }
  if (phase === 'failed' || v?.state === 'failed') {
    return (
      <span className="rp-say-grp">
        <span className="rp-say-err" role="status">{phase === 'failed' ? 'The audio did not load' : v?.error || 'The summary failed'}</span>
        <button type="button" className="rp-say" onClick={request} title="Try the spoken summary again">Retry</button>
      </span>
    );
  }
  if (phase) {
    const label = phase === 'playing' ? 'Pause' : phase === 'done' ? 'Play again' : 'Resume';
    return (
      <span className="rp-say-grp" role="group" aria-label="Spoken summary">
        <button type="button" className="rp-say" onClick={toggle} aria-label={`${label} the summary`} title={`${label} the summary`}>
          {phase === 'playing' ? <PauseIcon /> : phase === 'done' ? <ReplayIcon /> : <PlayIcon />}
          <span>{phase === 'done' ? 'Play again' : at.d ? `${clock(at.t)} / ${clock(at.d)}` : label}</span>
        </button>
        <RateBtn className="rp-ic" />
        {phase !== 'done' && (
          <button type="button" className="rp-ic" onClick={closeTrack} aria-label="Stop the summary" title="Stop the summary"><StopIcon /></button>
        )}
      </span>
    );
  }
  return (
    <button type="button" className="rp-say" onClick={ask} title="Listen to a spoken summary of the whole replay">
      <SpeakerIcon size={14} />
      <span>Listen</span>
    </button>
  );
}

// The server keeps the switch and tells every client; Settings flips it.
export function setVoiceOn(on: boolean) {
  useStore.setState(on ? { voiceOn: on } : { voiceOn: on, recaps: [], recapWant: null });
  send({ type: 'voice-set', on });
}

// Feeds the player: ready recaps this client asked for, oldest first, and the replay summary the user asked for once it is made.
export function VoiceQueue() {
  const recaps = useStore((s) => s.recaps);
  const voiceOn = useStore((s) => s.voiceOn);
  const track = useStore((s) => s.voiceTrack);
  const want = useStore((s) => s.voiceWant);
  const wanted = useStore((s) => (s.voiceWant ? s.replayVoices[s.voiceWant] : undefined));
  // The server dropped the summary (cap or closed session).
  const replayGone = useStore((s) => s.voiceTrack?.kind === 'replay' && !s.replayVoices[s.voiceTrack.id]);

  useEffect(() => {
    if (!want || !wanted || wanted.state === 'preparing') return;
    useStore.setState({ voiceWant: null });
    if (wanted.state === 'ready' && wanted.url) return playTrack({ kind: 'replay', id: want, sessionId: wanted.sessionId, url: wanted.url, text: wanted.text });
    // The viewer shows its own error; with it closed the header says so.
    if (useStore.getState().replayView?.key !== want) useStore.setState({ notice: wanted.error || 'The spoken summary failed', noticeInfo: false });
  }, [want, wanted]);

  useEffect(() => {
    if (replayGone) closeTrack();
  }, [replayGone]);

  // A replay summary keeps the player until it ends; a new recap then takes over.
  useEffect(() => {
    if (!voiceOn) {
      if (track?.kind === 'recap') closeTrack();
      if (recaps.length) useStore.setState({ recaps: [] });
      return;
    }
    if (track?.kind === 'recap' && !recaps.some((r) => r.id === track.id)) return closeTrack();
    if (track && track.phase !== 'done' && track.phase !== 'failed') return;
    const next = recaps.find((r) => r.state === 'ready' && r.url && r.id !== track?.id);
    if (next?.url) playTrack({ kind: 'recap', id: next.id, sessionId: next.sessionId, url: next.url, text: next.text });
  }, [recaps, track, voiceOn]);

  return null;
}

// The player in the header: it takes the top spot while anything is loaded and stays until closed.
export function VoicePlayer() {
  const track = useStore((s) => s.voiceTrack);
  const recaps = useStore((s) => s.recaps);
  const summaryPrep = useStore((s) => !!s.voiceWant && s.replayVoices[s.voiceWant]?.state === 'preparing');
  const recapPrep = track ? undefined : recaps.find((r) => r.state === 'preparing');
  if (!track && !recapPrep && !summaryPrep) return null;
  return (
    <div className={`hpl ${track ? track.phase : 'prep'}`} role="region" aria-label="Voice player">
      {track ? (
        <TrackRow key={track.id} track={track} waiting={recaps.filter((r) => r.id !== track.id).length} />
      ) : (
        <div className="hpl-row">
          <span className="hpl-b"><span className="g spin"></span></span>
          <span className="hpl-lab"><b aria-live="polite">{recapPrep ? 'Preparing recap…' : 'Preparing summary…'}</b></span>
          <button
            type="button" className="hpl-b" aria-label={recapPrep ? 'Skip this recap' : 'Do not play the summary'} title={recapPrep ? 'Skip this recap' : 'Do not play the summary'}
            onClick={() => (recapPrep ? dismissRecap(recapPrep.id) : useStore.setState({ voiceWant: null }))}
          >
            <XIcon />
          </button>
        </div>
      )}
    </div>
  );
}

function TrackRow({ track, waiting }: { track: VoiceTrack; waiting: number }) {
  const current = useStore((s) => s.current);
  const name = useStore((s) => s.roster.find((r) => r.id === track.sessionId)?.name);
  const replayTitle = useStore((s) => (track.kind === 'replay' ? s.replays[track.id]?.title : undefined));
  const [showText, setShowText] = useState(false);
  const fill = useRef<HTMLElement>(null);
  const range = useRef<HTMLInputElement>(null);
  // While the seek handle is dragged, playback must not move it.
  const held = useRef(false);
  const at = useClock(true);
  const { phase } = track;

  // timeupdate fires only while audio plays, so a paused player costs nothing.
  useEffect(() => {
    const a = player();
    const sync = () => {
      const d = a.duration || 0;
      if (fill.current) fill.current.style.transform = `scaleX(${d ? Math.min(1, a.currentTime / d) : 0})`;
      const r = range.current;
      if (r && !held.current) {
        r.max = String(d);
        r.value = String(a.currentTime);
      }
    };
    sync();
    a.addEventListener('timeupdate', sync);
    a.addEventListener('durationchange', sync);
    return () => {
      a.removeEventListener('timeupdate', sync);
      a.removeEventListener('durationchange', sync);
    };
  }, []);

  const other = track.kind === 'recap' && track.sessionId !== current ? name : undefined;
  const status = phase === 'blocked' ? 'Tap to play' : phase === 'failed' ? 'Audio did not load' : at.d ? `${clock(at.t)} / ${clock(at.d)}` : '';
  const main = phase === 'playing' ? 'Pause' : 'Play';
  const release = () => (held.current = false);

  return (
    <>
      <div className="hpl-row">
        <button type="button" className="hpl-b main" aria-label={main} title={main} onClick={toggle} disabled={phase === 'failed'}>
          {phase === 'playing' ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button" className="hpl-lab" aria-expanded={track.text ? showText : undefined} disabled={!track.text}
          title={track.text ? (showText ? 'Hide the text' : 'Show the text') : undefined} onClick={() => setShowText(!showText)}
        >
          <b>{track.kind === 'recap' ? 'Recap' : 'Summary'}</b>
          {status && <span className="hpl-t" role={phase === 'blocked' || phase === 'failed' ? 'status' : undefined}>{status}</span>}
          {waiting > 0 && <span className="hpl-t" title={`${waiting} more waiting`}>+{waiting}</span>}
        </button>
        {track.kind === 'replay' && replayTitle && (
          <button type="button" className="hpl-ses" title={`Open the replay: ${replayTitle}`} onClick={() => openReplay({ key: track.id, page: 0 })}>{replayTitle}</button>
        )}
        {other && (
          <button type="button" className="hpl-ses" title={`Go to ${other}`} onClick={() => openSession(track.sessionId)}>{other}</button>
        )}
        <RateBtn className="hpl-b" />
        <button type="button" className="hpl-b hpl-re" aria-label="Play from the start" title="Play from the start" onClick={restart} disabled={phase === 'failed'}><ReplayIcon /></button>
        <button type="button" className="hpl-b" aria-label="Stop and close" title="Stop and close" onClick={closeTrack}><XIcon /></button>
      </div>
      <div className="hpl-bar">
        <i ref={fill}></i>
        <input
          ref={range} type="range" min={0} step="any" defaultValue={0} aria-label="Position" aria-valuetext={`${clock(at.t)} of ${clock(at.d)}`} disabled={phase === 'failed'}
          onPointerDown={() => (held.current = true)} onPointerUp={release} onPointerCancel={release} onInput={(e) => seekTo(Number(e.currentTarget.value))}
        />
      </div>
      {showText && <p className="hpl-text">{track.text}</p>}
    </>
  );
}
