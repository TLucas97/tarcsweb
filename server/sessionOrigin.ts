import { z } from 'zod';
import type { SessionOrigin } from './protocol.ts';

const schema = z.object({ sessionId: z.string().min(1).max(200), role: z.enum(['main', 'child', 'peer']), actor: z.enum(['user', 'agent']) });
const PREFIX = '[tarcsweb-session-origin:';
// The provider saves this envelope; history restores the same typed provenance as live events.
export const originText = (text: string, origin: SessionOrigin) => `${PREFIX}${JSON.stringify(origin)}]\n\n${text}`;
export function readOrigin(text: string): { text: string; origin?: SessionOrigin } {
  if (!text.startsWith(PREFIX)) return { text };
  const end = text.indexOf(']\n\n');
  if (end < 0) return { text };
  try {
    const parsed = schema.safeParse(JSON.parse(text.slice(PREFIX.length, end)));
    return parsed.success ? { text: text.slice(end + 3), origin: parsed.data } : { text };
  } catch { return { text }; }
}
