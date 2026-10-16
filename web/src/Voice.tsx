import { useEffect, useRef, useState } from 'react';
import { dismissRecap, useStore, type Recap } from './store.ts';
import { openSession, send } from './socket.ts';
import { XIcon } from './bits.tsx';
import { useLayoutVars } from './layoutVars.ts';

type Phase = 'playing' | 'paused' | 'blocked' | 'done';
type Active = { id: string; phase: Phase };

// One audio element per browser, so only one recap ever speaks.
let audio: HTMLAudioElement | null = null;
const player = () => (audio ??= new Audio());

const icon = (d: string, fill = false) => () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const PlayIcon = icon('M4.5 3v8l6.5-4z', true);
const PauseIcon = icon('M5 3.2v7.6M9 3.2v7.6');
const ReplayIcon = icon('M2.8 7a4.2 4.2 0 1 0 1.3-3M2.6 1.8v2.6h2.6');
const SpeakerIcon = ({ off, size = 15 }: { off: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" />
    {off ? <path d="M11 6l3 4M14 6l-3 4" /> : <path d="M10.6 5.6a3.2 3.2 0 0 1 0 4.8M12.4 4a5.6 5.6 0 0 1 0 8" />}
  </svg>
);

const LABEL: Record<Phase, string> = { playing: 'Speaking', paused: 'Paused', blocked: 'Tap to play', done: 'Done' };

// The recap id the shared player holds, so a Listen click can replay it without the bar's state.
let loaded: string | null = null;

// Listen button of one finished reply: asks for its recap, or replays it while it is still in the queue.
export function ListenBtn({ id, text }: { id: string; text: string }) {
  const on = useStore((s) => s.voiceOn);
  const state = useStore((s) => (s.recaps.length ? s.recaps.find((r) => r.reply === id)?.state : undefined));
  if (!on) return null;
  const busy = state === 'preparing';
  const click = () => {
    if (busy) return;
    const s = useStore.getState();
    const clip = s.recaps.find((r) => r.reply === id);
    if (clip && loaded === clip.id) {
      const a = player();
      a.currentTime = 0;
      void a.play().catch(() => {});
      return;
    }
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
    send({ type: 'voice-recap', sessionId: s.current, reply: id, prompt, text });
  };
  return (
    <button
      type="button" className={`cpb${busy ? ' busy' : ''}`} aria-busy={busy} aria-label={busy ? 'Preparing recap' : state ? 'Replay recap' : 'Listen to a recap'}
      title={busy ? 'Preparing the recap…' : state ? 'Play the recap again' : 'Listen to a short spoken recap'} onClick={click}
    >
      {busy ? <span className="g spin"></span> : <SpeakerIcon off={false} size={13} />}
      <span>{busy ? 'Preparing' : state ? 'Replay' : 'Listen'}</span>
    </button>
  );
}

// The replay summary has its own element, so the recap bar never reacts to it; whichever starts last silences the other.
let sayAudio: HTMLAudioElement | null = null;
const sayPlayer = () => (sayAudio ??= new Audio());
const STEP = { script: 'Writing the summary…', audio: 'Recording the voice…' } as const;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const StopIcon = icon('M4 4h6v6H4z', true);

// The replay viewer's Listen button: one spoken summary of the whole replay, made once by the server and cached per replay.
export function ReplayListen({ replayKey }: { replayKey: string }) {
  const on = useStore((s) => s.voiceOn);
  const v = useStore((s) => s.replayVoices[replayKey]);
  const [phase, setPhase] = useState<'playing' | 'paused' | 'done' | null>(null);
  const [want, setWant] = useState(false);
  const [broken, setBroken] = useState(false);
  const [at, setAt] = useState({ t: 0, d: 0 });
  // Stop pauses too; its pause event must land as idle, not paused.
  const halted = useRef(false);

  // Mounted per open replay: closing the viewer or switching replays silences it.
  useEffect(() => {
    const a = sayPlayer();
    const rec = player();
    const onPlay = () => {
      setPhase('playing');
      if (!rec.paused) rec.pause();
    };
    const onPause = () => {
      if (halted.current) setPhase(null);
      else setPhase(a.ended ? 'done' : 'paused');
      halted.current = false;
    };
    // Whole seconds only, so the label re-renders once a second at most.
    const onTime = () => setAt((x) => (Math.floor(a.currentTime) === x.t && Math.floor(a.duration || 0) === x.d ? x : { t: Math.floor(a.currentTime), d: Math.floor(a.duration || 0) }));
    const onError = () => {
      if (!a.getAttribute('src')) return;
      setBroken(true);
      setPhase(null);
    };
    const onRecap = () => !a.paused && a.pause();
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('error', onError);
    rec.addEventListener('play', onRecap);
    return () => {
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('error', onError);
      rec.removeEventListener('play', onRecap);
      a.pause();
      a.removeAttribute('src');
      a.load();
    };
  }, []);

  const start = (url: string) => {
    const a = sayPlayer();
    if (a.getAttribute('src') !== url) a.src = url;
    a.currentTime = 0;
    // Autoplay can be refused when the summary lands long after the click; Play then waits for one.
    a.play().catch((err: unknown) => err instanceof DOMException && err.name === 'NotAllowedError' && setPhase('paused'));
  };

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

  useEffect(() => {
    if (!want || !v || v.state === 'preparing') return;
    setWant(false);
    if (v?.state === 'ready' && v.url) start(v.url);
  }, [want, v]);

  if (on === null) return null;
  const cut = replayKey.indexOf(':');
  const ask = () => {
    setBroken(false);
    setWant(true);
    if (v?.state === 'ready' && v.url && !broken) return;
    if (broken) sayPlayer().removeAttribute('src');
    useStore.setState((s) => {
      const { [replayKey]: _old, ...rest } = s.replayVoices;
      return { replayVoices: rest };
    });
    send({ type: 'replay-voice', sessionId: replayKey.slice(0, cut), id: replayKey.slice(cut + 1) });
  };
  const stop = () => {
    const a = sayPlayer();
    halted.current = !a.paused;
    a.pause();
    a.currentTime = 0;
    setPhase(null);
  };

  if (v?.state === 'preparing') {
    return (
      <button type="button" className="rp-say busy" aria-busy="true" aria-disabled="true" title="This takes up to a minute or two; you can keep reading or close the replay">
        <span className="spin" aria-hidden="true"></span>
        <span aria-live="polite">{STEP[v.step ?? 'script']}</span>
        {secs >= 10 && <span className="rp-say-t" aria-hidden="true">{clock(secs)}</span>}
      </button>
    );
  }
  if (v?.state === 'failed' || broken) {
    return (
      <span className="rp-say-grp">
        <span className="rp-say-err" role="status">{broken ? 'The audio did not load' : v?.error || 'The summary failed'}</span>
        <button type="button" className="rp-say" onClick={ask} title="Try the spoken summary again">Retry</button>
      </span>
    );
  }
  if (phase) {
    const a = sayPlayer();
    const main = phase === 'playing' ? () => a.pause() : phase === 'paused' ? () => void a.play().catch(() => {}) : () => v?.url && start(v.url);
    const label = phase === 'playing' ? 'Pause' : phase === 'paused' ? 'Resume' : 'Play again';
    return (
      <span className="rp-say-grp" role="group" aria-label="Spoken summary">
        <button type="button" className="rp-say" onClick={main} aria-label={`${label} the summary`} title={`${label} the summary`}>
          {phase === 'playing' ? <PauseIcon /> : phase === 'paused' ? <PlayIcon /> : <ReplayIcon />}
          <span>{phase === 'done' ? 'Play again' : at.d ? `${clock(at.t)} / ${clock(at.d)}` : label}</span>
        </button>
        {phase !== 'done' && (
          <button type="button" className="rp-ic" onClick={stop} aria-label="Stop the summary" title="Stop the summary"><StopIcon /></button>
        )}
      </span>
    );
  }
  return (
    <button type="button" className="rp-say" onClick={ask} title="Listen to a spoken summary of the whole replay">
      <SpeakerIcon off={false} size={14} />
      <span>Listen</span>
    </button>
  );
}

// The server keeps the switch and tells every client; the composer toggle and Settings share it.
export function setVoiceOn(on: boolean) {
  useStore.setState({ voiceOn: on });
  send({ type: 'voice-set', on });
}

export function VoiceToggle() {
  const on = useStore((s) => s.voiceOn);
  const flip = () => setVoiceOn(!on);
  if (on === null) return null;
  return (
    <button
      type="button" className={`seg vtog${on ? '' : ' off'}`} aria-pressed={on} aria-label="Listen buttons"
      title={on ? 'Listen buttons on: replies can be read aloud as a short recap' : 'Listen buttons off'} onClick={flip}
    >
      <SpeakerIcon off={!on} />
    </button>
  );
}

// Plays recaps one at a time, oldest ready first; docked above the session map card.
export function VoiceBar() {
  const barEl = useLayoutVars();
  const recaps = useStore((s) => s.recaps);
  const voiceOn = useStore((s) => s.voiceOn);
  const roster = useStore((s) => s.roster);
  const current = useStore((s) => s.current);
  const [active, setActive] = useState<Active | null>(null);
  const [showText, setShowText] = useState(false);
  const fillRef = useRef<HTMLElement>(null);

  const setFill = (v: number, instant = false) => {
    const el = fillRef.current;
    if (!el) return;
    if (instant) el.style.transition = 'none';
    el.style.transform = `scaleX(${Math.min(1, Math.max(0, v))})`;
    if (instant) {
      void el.offsetWidth;
      el.style.transition = '';
    }
  };

  // timeupdate fires only while audio plays, so a paused bar costs nothing.
  useEffect(() => {
    const a = player();
    const onTime = () => a.duration && setFill(a.currentTime / a.duration);
    const onPlay = () => setActive((x) => x && { ...x, phase: 'playing' });
    const onPause = () => setActive((x) => (x && !a.ended ? { ...x, phase: 'paused' } : x));
    const onEnded = () => {
      setFill(1);
      setActive((x) => x && { ...x, phase: 'done' });
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onEnded);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onEnded);
    };
  }, []);

  const play = (id: string) => {
    // Autoplay can be refused before the page got a click; the bar then asks for one.
    player().play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'NotAllowedError') setActive((x) => (x?.id === id ? { id, phase: 'blocked' } : x));
    });
  };

  const stop = () => {
    const a = player();
    a.pause();
    a.removeAttribute('src');
    a.load();
    loaded = null;
  };

  // The queue: drop what the server dropped, move on when the current clip is done, stale ones go when their session works again.
  useEffect(() => {
    if (!voiceOn) {
      if (active) stop();
      if (active) setActive(null);
      if (recaps.length) useStore.setState({ recaps: [] });
      return;
    }
    const cur = active ? recaps.find((r) => r.id === active.id) : undefined;
    if (active && !cur) {
      stop();
      setActive(null);
      return;
    }
    const idle = !active || active.phase === 'done' || active.phase === 'blocked';
    if (cur && idle && roster.find((r) => r.id === cur.sessionId)?.state === 'working') return dismissRecap(cur.id);
    const next = recaps.find((r) => r.state === 'ready' && r.url && r.id !== active?.id);
    if (!next?.url || (active && active.phase !== 'done')) return;
    if (active) dismissRecap(active.id);
    const a = player();
    a.src = next.url;
    loaded = next.id;
    setFill(0, true);
    setShowText(false);
    setActive({ id: next.id, phase: 'playing' });
    play(next.id);
  }, [recaps, active, voiceOn, roster]);

  const cur = active ? recaps.find((r) => r.id === active.id) : undefined;
  const shown: Recap | undefined = cur ?? recaps.find((r) => r.state === 'preparing');
  if (!shown) return null;
  const phase = cur && active ? active.phase : null;
  const waiting = recaps.length - 1;
  const other = shown.sessionId !== current ? roster.find((r) => r.id === shown.sessionId)?.name : undefined;

  const toggle = () => {
    if (!cur || !active) return;
    const a = player();
    if (active.phase === 'playing') return a.pause();
    if (active.phase === 'done') {
      a.currentTime = 0;
      setFill(0, true);
    }
    play(cur.id);
  };
  const replay = () => {
    if (!cur) return;
    player().currentTime = 0;
    setFill(0, true);
    play(cur.id);
  };
  const close = () => {
    if (cur) stop();
    if (cur) setActive(null);
    dismissRecap(shown.id);
  };

  return (
    <div className={`vbar${phase ? ` ${phase}` : ' prep'}`} ref={barEl} role="region" aria-label="Voice recap">
      <div className="vrow">
        {phase ? (
          <button type="button" className="vb main" aria-label={phase === 'playing' ? 'Pause' : 'Play'} title={phase === 'playing' ? 'Pause' : 'Play'} onClick={toggle}>
            {phase === 'playing' ? <PauseIcon /> : <PlayIcon />}
          </button>
        ) : (
          <span className="vb"><span className="g spin"></span></span>
        )}
        <button
          type="button" className="vlab" aria-expanded={shown.text ? showText : undefined} disabled={!shown.text}
          title={shown.text ? (showText ? 'Hide the recap text' : 'Show the recap text') : undefined} onClick={() => setShowText(!showText)}
        >
          <b aria-live="polite">{phase ? LABEL[phase] : 'Preparing recap…'}</b>
          {waiting > 0 && <span>+{waiting}</span>}
        </button>
        {other && (
          <button type="button" className="vses" title={`Go to ${other}`} onClick={() => openSession(shown.sessionId)}>{other}</button>
        )}
        {phase && (
          <button type="button" className="vb" aria-label="Replay" title="Replay" onClick={replay}><ReplayIcon /></button>
        )}
        <button type="button" className="vb" aria-label={phase ? 'Stop and close' : 'Skip this recap'} title={phase ? 'Stop and close' : 'Skip this recap'} onClick={close}>
          <XIcon />
        </button>
      </div>
      {phase && <div className="vprog"><i ref={fillRef}></i></div>}
      {showText && shown.text && <p className="vtext">{shown.text}</p>}
    </div>
  );
}
