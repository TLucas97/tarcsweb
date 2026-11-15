import type { CallMessage, ServerMessage } from '../../server/protocol.ts';
import type { CallView } from './call.ts';
import { send } from './socket.ts';
import { useSetup } from './setup.ts';
import { inTauri } from './tauri.ts';
import { sfx } from './Sounds.ts';
import { attachDraft } from './Composer.tsx';

type Ui = {
  get(): CallView | null;
  set(view: CallView | null): void;
  patch(view: Partial<CallView>): void;
};
type Levels = Extract<ServerMessage, { type: 'call-levels' }>;
const active = (v: CallView) => v.state === 'connecting' || v.state === 'live' || v.state === 'reconnecting';

export function helperEligible() {
  if (typeof RTCPeerConnection === 'function') return false;
  const shell = useSetup.getState().settings?.shell;
  return inTauri() && shell?.kind === 'tauri' && shell.os === 'linux';
}

export class CallHelper {
  private ui: Ui;
  private known = false;
  private orbOn = false;
  private samples: [number, number] = [0, 0];
  private samplesAt = 0;
  private seq = 0;
  private muteTimer = 0;
  private expectedOffer = 0;

  constructor(ui: Ui) { this.ui = ui; }

  selected() { return this.ui.get()?.transport === 'helper'; }

  async start(sessionId: string, name: string) {
    const previous = this.ui.get();
    if (previous && active(previous)) return;
    this.release();
    this.known = false;
    this.seq = 0;
    this.expectedOffer = 0;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const capability = useSetup.getState().settings?.shell?.voiceHelper;
    this.ui.set({
      id, sessionId, name, state: 'connecting', liveAt: null, muted: false, ending: false, error: null, file: null,
      report: null, full: true, busy: false, acts: [], usage: null, ...(capability?.available ? { transport: 'helper' } : {}),
    });
    if (!capability?.available) {
      this.ui.patch({ state: 'ended', noRtc: true, ...(capability?.reason === 'chrome-missing' ? { error: 'Chrome was not found.' } : {}) });
      return;
    }
    this.known = send({ type: 'call-helper-start', sessionId, callId: id });
    if (!this.known) return this.fail('Not connected to tarcsweb. Try again when the connection returns.');
    if (this.orbOn) send({ type: 'call-meter', callId: id, on: true });
  }

  meterActive(on: boolean) {
    if (this.orbOn === on) return;
    this.orbOn = on;
    this.samplesAt = 0;
    const v = this.ui.get();
    if (v && active(v) && !v.ending) send({ type: 'call-meter', callId: v.id, on });
  }

  levels(): [number, number] {
    const v = this.ui.get();
    return v && active(v) && !v.ending && this.orbOn && performance.now() - this.samplesAt <= 250 ? this.samples : [0, 0];
  }

  receiveLevels(m: Levels) {
    const v = this.ui.get();
    if (!v || !this.selected() || v.id !== m.callId || !active(v) || v.ending || !this.orbOn) return;
    this.samples = [m.mic, m.out];
    this.samplesAt = performance.now();
  }

  mute() {
    const v = this.ui.get();
    if (!v || !active(v) || v.mutePending || v.ending) return;
    const seq = ++this.seq;
    if (!send({ type: 'call-mute', callId: v.id, muted: !v.muted, seq })) return this.fail('The microphone control could not be sent.');
    this.ui.patch({ mutePending: true });
    this.muteTimer = window.setTimeout(() => {
      if (this.ui.get()?.id === v.id && this.ui.get()?.mutePending) this.fail('The microphone control was not confirmed. The call ended.');
    }, 5000);
  }

  end() {
    const v = this.ui.get();
    if (!v || !active(v) || v.ending) return;
    const asked = this.known && send({ type: 'call-stop', callId: v.id });
    this.release();
    this.ui.patch(asked ? { ending: true, mutePending: false } : { state: 'ended', ending: false, mutePending: false });
  }

  close() {
    const v = this.ui.get();
    if (!v) return;
    send({ type: 'call-dismiss', callId: v.id });
    this.release();
    this.ui.set(null);
  }

  private release() {
    clearTimeout(this.muteTimer);
    this.muteTimer = 0;
    this.samplesAt = 0;
  }

  private fail(error: string) {
    const v = this.ui.get();
    if (!v) return;
    if (this.known) send({ type: 'call-stop', callId: v.id });
    this.release();
    this.ui.patch({ state: 'error', error, ending: false, mutePending: false, fallback: 'browser' });
  }

  apply(m: CallMessage) {
    const v = this.ui.get();
    if (!v || m.callId !== v.id) return;
    const keep = v.state === 'ended' || v.state === 'error';
    if (m.helperOffer !== undefined) this.expectedOffer = Math.max(this.expectedOffer, m.helperOffer);
    const next: Partial<CallView> = keep ? {} : { state: m.state };
    if (m.fallback) next.fallback = m.fallback;
    if (m.media && (!v.media || m.media.offer >= v.media.offer)) {
      next.media = m.media;
      if (m.media.seq === this.seq) {
        clearTimeout(this.muteTimer);
        next.muted = m.media.muted;
        next.mutePending = false;
      }
    }
    const status = next.media ?? v.media;
    if (!keep && m.state === 'live') {
      const connected = this.expectedOffer > 0 && status?.offer === this.expectedOffer && status.peer === 'connected' && status.playback === 'playing';
      next.state = connected ? 'live' : v.liveAt ? 'reconnecting' : 'connecting';
      if (connected) next.liveAt = v.liveAt ?? Date.now();
    }
    if (m.busy !== undefined) next.busy = m.busy;
    if (m.chime) sfx('blip');
    if (m.activity) {
      const a = m.activity;
      const i = v.acts.findIndex(x => x.id === a.id);
      const acts = i < 0 ? [...v.acts, a] : v.acts.with(i, a);
      next.acts = (a.text ? acts : acts.filter(x => x.id !== a.id)).slice(-100);
    }
    if (m.busy === false) next.acts = (next.acts ?? v.acts).map(a => a.kind === 'step' && a.state === 'running' ? { ...a, state: 'done' } : a);
    if (m.state === 'ended' || m.state === 'error') {
      this.release();
      Object.assign(next, { ending: false, busy: false, mutePending: false });
    }
    if (m.file !== undefined) next.file = m.file;
    if (m.usage) next.usage = m.usage;
    if (m.error !== undefined) next.error = m.error;
    if (m.report) {
      next.report = m.report;
      if (m.report.state === 'ready') attachDraft(v.sessionId, m.report.text);
    }
    this.ui.patch(next);
  }

  socketLost() {
    const v = this.ui.get();
    if (!v) return;
    this.release();
    this.ui.patch({
      ...(active(v) ? { state: 'error', error: 'The connection to tarcsweb dropped, so the call ended.', fallback: 'browser' } : {}),
      ending: false, busy: false, mutePending: false, file: null,
      report: v.report?.state === 'working' ? { state: 'failed', error: 'The connection to tarcsweb dropped.' } : v.report,
    });
  }
}
