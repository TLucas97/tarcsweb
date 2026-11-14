import type { VoiceAudioMessage } from '../../server/protocol.ts';
import { readingProgress } from '../../server/voiceText.ts';
import { onVoiceAudio, send } from './socket.ts';

type Frame = { data: ArrayBuffer };
type Encoded = { readable: ReadableStream<Frame>; writable: WritableStream<Frame> };
type EncodedReceiver = RTCRtpReceiver & { createEncodedStreams(): Encoded };
type EncodedSender = RTCRtpSender & { createEncodedStreams(): Encoded };
type Samples = { sampleRate: number; numberOfFrames: number; copyTo(data: Float32Array, options: { planeIndex: number; format: string }): void; close(): void };
type Decoder = { state: string; configure(config: object): void; decode(chunk: unknown): void; flush(): Promise<void>; close(): void };
type NullContext = AudioContext & { sinkId?: string | { type: string } };
const native = globalThis as unknown as {
  AudioDecoder?: { new(options: { output: (data: Samples) => void; error: () => void }): Decoder; isConfigSupported(config: object): Promise<{ supported: boolean }> };
  EncodedAudioChunk?: new(options: { type: string; timestamp: number; data: ArrayBuffer }) => unknown;
};
const supported = () => typeof AudioContext !== 'undefined' && isSecureContext && 'sinkId' in AudioContext.prototype
  && typeof RTCPeerConnection !== 'undefined' && 'createEncodedStreams' in RTCRtpReceiver.prototype
  && 'createEncodedStreams' in RTCRtpSender.prototype && !!native.AudioDecoder && !!native.EncodedAudioChunk;

let warmed: NullContext | null = null;
let warmTimer: ReturnType<typeof setTimeout> | undefined;
let stop: (() => void) | null = null;
let answer: ((id: string, sdp: string) => void) | null = null;
let activeId: string | null = null;

function nullContext(): NullContext {
  const Constructor = AudioContext as unknown as new(options: object) => NullContext;
  const ctx = new Constructor({ sinkId: { type: 'none' } });
  if (typeof ctx.sinkId !== 'object' || ctx.sinkId?.type !== 'none') {
    void ctx.close();
    throw new Error('A nonaudible voice connection is unavailable.');
  }
  return ctx;
}

// Called from Listen's click, before script generation, to retain the browser's audio activation.
export function prepareVoiceCapture() {
  if (!supported() || warmed || activeId) return;
  try {
    warmed = nullContext();
    void warmed.resume().catch(() => { void warmed?.close(); warmed = null; });
    warmTimer = setTimeout(() => { void warmed?.close(); warmed = null; }, 120_000);
  } catch { onVoiceAudio(receive, false); }
}

async function capture(m: Extract<VoiceAudioMessage, { state: 'start' }>) {
  stop?.();
  const fail = () => { send({ type: 'voice-audio-failed', id: m.id, error: 'The reading could not be recorded.' }); dispose(); };
  let ctx: NullContext | null = null, peer: RTCPeerConnection | null = null, decoder: Decoder | null = null;
  let source: ConstantSourceNode | null = null, destination: MediaStreamAudioDestinationNode | null = null;
  let channel: RTCDataChannel | null = null, session = false, collecting = false, asked = false, finishing = false;
  let transcript = '', count = 0, frames = 0;
  const pcm: Float32Array[] = [], abort = new AbortController();
  let tail: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(fail, m.timeoutMs);
  const dispose = () => {
    if (activeId !== m.id) return;
    activeId = null; stop = null; answer = null; collecting = false;
    clearTimeout(timer); clearTimeout(tail); abort.abort();
    if (decoder && decoder.state !== 'closed') decoder.close();
    source?.stop(); source?.disconnect();
    destination?.stream.getTracks().forEach((t) => t.stop());
    if (channel) { channel.onmessage = channel.onopen = null; channel.close(); }
    if (peer) { peer.ontrack = peer.onconnectionstatechange = null; peer.getReceivers().forEach((r) => r.track.stop()); peer.close(); }
    void ctx?.close();
    pcm.length = 0;
  };
  activeId = m.id; stop = dispose;
  const ask = () => {
    if (asked || !session || !collecting || channel?.readyState !== 'open' || activeId !== m.id) return;
    asked = true;
    if (!send({ type: 'voice-audio-ready', id: m.id })) fail();
  };
  const upload = async () => {
    if (finishing || activeId !== m.id) return;
    finishing = true;
    try {
      collecting = false;
      await decoder!.flush();
      if (activeId !== m.id || !count) return fail();
      const wav = new ArrayBuffer(44 + count * 2), v = new DataView(wav);
      const text = (offset: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i)); };
      text(0, 'RIFF'); v.setUint32(4, wav.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 48000, true); v.setUint32(28, 96000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      text(36, 'data'); v.setUint32(40, count * 2, true);
      let offset = 44;
      for (const block of pcm) for (const f of block) { v.setInt16(offset, Math.round(Math.max(-1, Math.min(1, f)) * 32767), true); offset += 2; }
      const response = await fetch(`/files/voice-capture/${m.id}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Voice-Token': m.token }, body: wav, signal: abort.signal });
      if (!response.ok && activeId === m.id) fail();
    } catch { if (activeId === m.id) fail(); }
  };
  try {
    if (!supported()) throw new Error('Unsupported voice capture.');
    clearTimeout(warmTimer); ctx = warmed ?? nullContext(); warmed = null;
    await ctx.resume();
    if (activeId !== m.id) return;
    if (ctx.state !== 'running') throw new Error('Voice capture is suspended.');
    const config = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 };
    if (!(await native.AudioDecoder!.isConfigSupported(config)).supported) throw new Error('Unsupported voice codec.');
    if (activeId !== m.id) return;
    destination = ctx.createMediaStreamDestination(); source = ctx.createConstantSource(); source.offset.value = 0;
    source.connect(destination); source.connect(ctx.destination); source.start();
    peer = new RTCPeerConnection({ iceServers: [], encodedInsertableStreams: true } as RTCConfiguration);
    for (const t of destination.stream.getTracks()) {
      const s = peer.addTrack(t, destination.stream) as EncodedSender, encoded = s.createEncodedStreams();
      void encoded.readable.pipeTo(encoded.writable, { signal: abort.signal }).catch(() => { if (activeId === m.id) fail(); });
    }
    decoder = new native.AudioDecoder!({
      output: (data) => {
        if (activeId !== m.id) { data.close(); return; }
        if (data.sampleRate !== 48000 || (count + data.numberOfFrames) * 2 + 44 > m.maxBytes) { data.close(); fail(); return; }
        const block = new Float32Array(data.numberOfFrames);
        data.copyTo(block, { planeIndex: 0, format: 'f32-planar' }); data.close();
        count += block.length; pcm.push(block);
      }, error: fail,
    });
    decoder.configure(config);
    channel = peer.createDataChannel('oai-events');
    channel.onopen = ask;
    channel.onmessage = (event) => {
      let e: { type?: string; turn?: { role?: string; transcript?: string } };
      try { e = JSON.parse(String(event.data)); } catch { return; }
      if (e.type === 'session.started') { session = true; ask(); }
      if (e.type === 'error' || e.type === 'session.closed') return fail();
      if (e.type !== 'turn.done' || e.turn?.role !== 'assistant') return;
      transcript = `${transcript} ${e.turn.transcript ?? ''}`.trim();
      const progress = readingProgress(m.script, transcript);
      if (progress === 'mismatch') return fail();
      if (progress === 'complete' && !tail) tail = setTimeout(() => void upload(), m.tailMs);
    };
    peer.ontrack = (e) => {
      const streams = (e.receiver as EncodedReceiver).createEncodedStreams();
      collecting = true;
      void streams.readable.pipeThrough(new TransformStream<Frame, Frame>({ transform: (frame, controller) => {
        if (collecting && decoder?.state === 'configured') decoder.decode(new native.EncodedAudioChunk!({ type: 'key', timestamp: frames++ * 20_000, data: frame.data }));
        controller.enqueue(frame);
      } })).pipeTo(streams.writable, { signal: abort.signal }).catch(() => { if (activeId === m.id) fail(); });
      ask();
    };
    peer.onconnectionstatechange = () => { if (peer?.connectionState === 'failed' && activeId === m.id) fail(); };
    answer = (id, sdp) => { if (id === m.id && activeId === id) void peer!.setRemoteDescription({ type: 'answer', sdp }).catch(fail); };
    await peer.setLocalDescription(await peer.createOffer());
    if (activeId !== m.id) return;
    const sdp = peer.localDescription!.sdp.split('\r\n').filter((line) => !/^a=(candidate:|remote-candidates:)/.test(line)).join('\r\n');
    if (sdp.split('\r\n').some((line) => /^[oc]=/.test(line) && !/(?:0\.0\.0\.0|127\.0\.0\.1)\s*$/.test(line))) throw new Error('Unsupported private offer.');
    if (!send({ type: 'voice-audio-offer', id: m.id, sdp })) fail();
  } catch { if (activeId === m.id) fail(); }
}

function receive(m: VoiceAudioMessage | null) {
  if (!m) { stop?.(); return; }
  if (m.state === 'start') void capture(m);
  else if (m.state === 'answer') answer?.(m.id, m.sdp);
  else if (activeId === m.id) stop?.();
}

export function registerVoiceCapture() { onVoiceAudio(receive, supported()); }
export function stopVoiceCapture() {
  if (activeId) send({ type: 'voice-audio-failed', id: activeId, error: 'Voice stopped.' });
  stop?.(); clearTimeout(warmTimer); void warmed?.close(); warmed = null;
  onVoiceAudio(receive, false);
}
