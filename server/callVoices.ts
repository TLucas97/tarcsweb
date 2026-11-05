import { CALL_VOICES } from './protocol.ts';
import { callCodex } from './voiceCall.ts';
import type { Method } from './codex/types.ts';

const TTL_MS = 10 * 60_000;
let cached: { voices: string[]; at: number } | null = null;
let inflight: Promise<string[] | null> | null = null;

// The voices the installed Codex accepts: its v3 list, else v1. Loaded on request (it can boot the call's app-server) and cached for TTL_MS.
// A failed load is not cached; the v1 voices every version takes stand in.
export async function callVoices(): Promise<string[]> {
  return (await known()) ?? [...CALL_VOICES];
}

// null when the installed Codex could not be asked.
function known(): Promise<string[] | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.voices);
  inflight ??= load().finally(() => { inflight = null; });
  return inflight;
}

async function load(): Promise<string[] | null> {
  try {
    // Not in the typed request map (server/codex/types.ts), so the call is cast.
    const r = (await callCodex.peek('thread/realtime/listVoices' as Method, {} as never)) as unknown as { voices?: { v1?: string[]; v3?: string[] } };
    const voices = r.voices?.v3 ?? r.voices?.v1;
    if (!Array.isArray(voices) || !voices.length) return null;
    cached = { voices, at: Date.now() };
    return voices;
  } catch {
    return null;
  }
}

// Without a list from Codex, any well-formed name passes (settings.ts checks the shape) instead of refusing a voice Codex takes.
export async function unknownCallVoice(voice: unknown): Promise<string | null> {
  if (voice === undefined || voice === null) return null;
  const list = await known();
  return !list || list.includes(voice as string) ? null : 'Unknown call voice';
}
