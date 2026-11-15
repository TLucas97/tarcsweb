import type { CallRtEvent, HelperMedia } from '../protocol.ts';

type Meter = {
  ctx: AudioContext; mic: AnalyserNode; out: AnalyserNode;
  micSrc: MediaStreamAudioSourceNode | null; outSrc: MediaStreamAudioSourceNode | null; buf: Float32Array<ArrayBuffer>;
};
type RtMeta = Omit<CallRtEvent, 'age'> & { at: number };
export type MediaCallbacks = {
  offer(sdp: string, offer: number): void;
  lost?(): void;
  state(media: HelperMedia): void;
  pause(): void;
  error(code: string, message: string): void;
  rt(events: CallRtEvent[]): void;
};
const DISCONNECT_GRACE_MS = 4000;
const PAUSE_MS = 1000;
const PAUSE_TICK_MS = 100;
const QUIET_LEVEL = 0.15;
const METER_SAMPLES = 1024;
const errText = (e: unknown) => e instanceof Error ? e.message : String(e);

function micError(e: unknown) {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access is blocked. Allow it for this page in the browser, then call again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found. Connect one, then call again.';
  if (name === 'NotReadableError') return 'The microphone is busy in another app or could not start.';
  return `The microphone could not start${e instanceof Error && e.message ? `: ${e.message}` : '.'}`;
}
function level(a: AnalyserNode, buf: Float32Array<ArrayBuffer>) {
  a.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  const rms = Math.sqrt(sum / buf.length);
  return rms < 0.004 ? 0 : Math.min(1, Math.sqrt(rms) * 1.8);
}

export class MediaCall {
  private callbacks: MediaCallbacks;
  private strictPlayback: boolean;
  private mic: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private audio: HTMLAudioElement | null = null;
  private meter: Meter | null = null;
  private offerNo = 0;
  private offering: Promise<void> = Promise.resolve();
  private graceTimer = 0;
  private pauseTimer = 0;
  private quietSince = 0;
  private orbOn = false;
  private waiting = false;
  private muted = false;
  private seq = 0;
  private disposed = false;
  private playback = false;
  private rtQueue: RtMeta[] = [];
  private rtDeltas = 0;
  private rtTimer = 0;

  constructor(callbacks: MediaCallbacks, strictPlayback = false) {
    this.callbacks = callbacks;
    this.strictPlayback = strictPlayback;
  }

  async start(meterOn = this.orbOn) {
    if (!navigator.mediaDevices?.getUserMedia) return this.callbacks.error('microphone', 'The microphone needs a secure page: open tarcsweb on localhost or over https.');
    if (meterOn) this.openMeter();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      if (!this.disposed) this.callbacks.error('microphone', micError(e));
      return;
    }
    if (this.disposed) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.mic = stream;
    this.mute(this.muted);
    this.meterIn();
    this.audio = new Audio();
    this.audio.autoplay = true;
    if (this.waiting) this.held(true);
    await this.redial();
  }

  private openMeter(): Meter {
    if (this.meter) return this.meter;
    const ctx = new AudioContext();
    void ctx.resume().catch((e: unknown) => this.playbackError(e));
    const analyser = () => Object.assign(ctx.createAnalyser(), { fftSize: METER_SAMPLES, smoothingTimeConstant: 0 });
    this.meter = { ctx, mic: analyser(), out: analyser(), micSrc: null, outSrc: null, buf: new Float32Array(METER_SAMPLES) };
    this.meterIn();
    this.meterOut();
    return this.meter;
  }

  private playbackError(e: unknown) {
    if (this.strictPlayback && !this.disposed) {
      this.callbacks.state({ offer: this.offerNo, peer: this.pc?.connectionState ?? 'new', playback: 'blocked', muted: this.muted, seq: this.seq });
      this.callbacks.error('playback-blocked', `Audio playback could not start: ${errText(e)}`);
    }
  }

  private meterIn() {
    const m = this.meter;
    if (!m || m.micSrc || !this.mic) return;
    m.micSrc = m.ctx.createMediaStreamSource(this.mic);
    m.micSrc.connect(m.mic);
  }

  private meterOut() {
    const m = this.meter;
    if (!m) return;
    m.outSrc?.disconnect();
    const s = this.audio?.srcObject;
    m.outSrc = s instanceof MediaStream && s.getAudioTracks().length ? m.ctx.createMediaStreamSource(s) : null;
    m.outSrc?.connect(m.out);
  }

  meterActive(on: boolean) {
    this.orbOn = on;
    this.meterRun();
  }

  private meterRun() {
    if (this.meter) void (this.orbOn || this.pauseTimer ? this.meter.ctx.resume() : this.meter.ctx.suspend()).catch((e: unknown) => this.playbackError(e));
  }

  held(on: boolean) {
    this.waiting = on;
    clearInterval(this.pauseTimer);
    this.pauseTimer = 0;
    if (on && this.mic && !this.disposed) {
      const m = this.openMeter();
      this.quietSince = performance.now();
      this.pauseTimer = window.setInterval(() => {
        const now = performance.now();
        if (level(m.mic, m.buf) >= QUIET_LEVEL) this.quietSince = now;
        else if (now - this.quietSince >= PAUSE_MS) {
          this.quietSince = now;
          this.callbacks.pause();
        }
      }, PAUSE_TICK_MS);
    }
    this.meterRun();
  }

  levels(): { mic: number; out: number } {
    if (!this.mic) return { mic: 0, out: 0 };
    const m = this.openMeter();
    return { mic: level(m.mic, m.buf), out: level(m.out, m.buf) };
  }

  mute(muted: boolean, seq = this.seq) {
    if (seq < this.seq) return;
    this.muted = muted;
    this.seq = seq;
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !muted;
    if (this.mic) this.notifyPeer();
  }

  private closePeer() {
    clearTimeout(this.graceTimer);
    if (!this.pc) return;
    this.pc.onconnectionstatechange = this.pc.ontrack = null;
    this.pc.close();
    this.pc = null;
  }

  dispose() {
    this.disposed = true;
    this.closePeer();
    clearInterval(this.pauseTimer);
    clearTimeout(this.rtTimer);
    this.pauseTimer = this.rtTimer = 0;
    this.rtQueue = [];
    void this.meter?.ctx.close().catch(() => {});
    this.meter = null;
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.mic = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio = null;
    }
  }

  get offerNumber() { return this.offerNo; }

  async answer(sdp: string, offer: number): Promise<void> {
    const peer = this.pc;
    if (offer !== this.offerNo || !peer) return;
    await peer.setRemoteDescription({ type: 'answer', sdp }).catch((e: unknown) => {
      if (peer === this.pc) this.callbacks.error('connection', `The call could not connect: ${errText(e)}`);
    });
  }

  redial(offer?: number) {
    if (offer !== undefined && offer < this.offerNo) return this.offering;
    return this.offering = this.offering.then(() => offer !== undefined && offer < this.offerNo ? undefined : this.dial()).catch((e: unknown) => {
      if (!this.disposed) this.callbacks.error('connection', `The call link could not start: ${errText(e)}`);
    });
  }

  private async dial() {
    if (this.disposed || !this.mic) return;
    this.closePeer();
    const no = ++this.offerNo;
    const peer = new RTCPeerConnection();
    this.pc = peer;
    this.playback = false;
    if (this.strictPlayback) this.notifyPeer(peer);
    for (const t of this.mic.getAudioTracks()) peer.addTrack(t, this.mic);
    const events = peer.createDataChannel('oai-events');
    events.onmessage = (e) => { if (peer === this.pc) this.rtEvent(e.data); };
    peer.ontrack = (e) => {
      if (!this.audio) return;
      this.audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      this.meterOut();
      if (this.strictPlayback) void this.audio.play().then(() => {
        if (peer !== this.pc || this.disposed) return;
        this.playback = true;
        this.notifyPeer(peer);
      }).catch((e: unknown) => {
        if (peer === this.pc && !this.disposed) this.playbackError(e);
      });
    };
    peer.onconnectionstatechange = () => this.watch(peer);
    await peer.setLocalDescription(await peer.createOffer());
    if (peer === this.pc && !this.disposed) this.callbacks.offer(peer.localDescription!.sdp, no);
  }

  private notifyPeer(peer = this.pc) {
    this.callbacks.state({ offer: this.offerNo, peer: peer?.connectionState ?? 'new', playback: this.playback ? 'playing' : 'pending', muted: this.muted, seq: this.seq });
  }

  private linkLost(peer: RTCPeerConnection) {
    if (peer !== this.pc || this.disposed) return;
    if (this.callbacks.lost) this.callbacks.lost();
    else void this.redial(this.offerNo);
  }

  private watch(peer: RTCPeerConnection) {
    if (peer !== this.pc) return;
    this.notifyPeer(peer);
    clearTimeout(this.graceTimer);
    if (peer.connectionState === 'failed') this.linkLost(peer);
    else if (peer.connectionState === 'disconnected') this.graceTimer = window.setTimeout(() => this.linkLost(peer), DISCONNECT_GRACE_MS);
  }

  private rtEvent(data: unknown) {
    let e: Record<string, unknown>;
    try { e = JSON.parse(String(data)) as Record<string, unknown>; } catch { return; }
    const type = typeof e.type === 'string' ? e.type : '';
    if (!type) return;
    if (type.endsWith('.delta')) return void this.rtDeltas++;
    const obj = (v: unknown) => v && typeof v === 'object' ? v as Record<string, unknown> : undefined;
    const s = (v: unknown) => typeof v === 'string' ? v.slice(0, 64) : undefined;
    const r = obj(e.response);
    const item = obj(e.item);
    const details = obj(r?.status_details);
    const m: RtMeta = { at: performance.now(), type, deltas: this.rtDeltas || undefined };
    this.rtDeltas = 0;
    if (r) {
      m.response = s(r.id)?.slice(-8);
      m.status = s(r.status);
      m.reason = s(details?.reason) ?? s(details?.type);
      if (Array.isArray(r.output)) m.items = r.output.map((o) => { const x = obj(o); return [s(x?.type), s(x?.name)].filter(Boolean).join(':'); });
    }
    if (item) {
      m.item = s(item.type);
      m.role = s(item.role);
      m.name = s(item.name);
      m.status ??= s(item.status);
    }
    if (typeof e.response_id === 'string') m.response ??= e.response_id.slice(-8);
    if (type.includes('function_call')) m.name ??= s(e.name);
    const err = obj(e.error);
    if (err) m.code = s(err.code) ?? s(err.type);
    if (this.rtQueue.length < 100) this.rtQueue.push(m);
    if (!this.rtTimer) this.rtTimer = window.setTimeout(() => {
      this.rtTimer = 0;
      const now = performance.now();
      const batch = this.rtQueue.splice(0, 100).map(({ at, ...x }) => ({ ...x, age: Math.round(now - at) }));
      this.callbacks.rt(batch);
    }, 250);
  }
}
