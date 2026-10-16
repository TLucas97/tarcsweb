import type { ComponentType } from 'react';
import { z } from 'zod';

// One inline ui component: `type` is the registry key, `label` shows while the block streams.
export type UiDef<T = unknown> = { schema: z.ZodType<T>; Component: ComponentType<{ b: T }>; label: string };

export function defineUi<S extends z.ZodType>(def: { schema: S; Component: ComponentType<{ b: z.output<S> }>; label: string }) {
  return def as unknown as UiDef;
}

// Models often write numbers or booleans where text is expected; accept them as text.
export const text = z.union([z.string(), z.number()]).transform(String);
export const fact = z.union([z.string(), z.number(), z.boolean()]).transform((v) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)));
