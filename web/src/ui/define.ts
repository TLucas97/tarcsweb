import type { ComponentType } from 'react';
import { z } from 'zod';

// One inline ui component: `type` is the registry key, `label` shows while the block streams.
export type UiDef<T = unknown> = { schema: z.ZodType<T>; Component: ComponentType<{ b: T }>; label: string };

export function defineUi<S extends z.ZodType>(def: { schema: S; Component: ComponentType<{ b: z.output<S> }>; label: string }) {
  return def as unknown as UiDef;
}
