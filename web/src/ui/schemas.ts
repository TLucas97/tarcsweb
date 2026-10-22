import type { z } from 'zod';
import { schema as beforeafter } from './beforeafter.schema.ts';
import { schema as callout } from './callout.schema.ts';
import { schema as chart } from './chart.schema.ts';
import { schema as checklist } from './checklist.schema.ts';
import { schema as compare } from './compare.schema.ts';
import { schema as diagram } from './diagram.schema.ts';
import { schema as donut } from './donut.schema.ts';
import { schema as files } from './files.schema.ts';
import { schema as heatmap } from './heatmap.schema.ts';
import { schema as kv } from './kv.schema.ts';
import { schema as matrix } from './matrix.schema.ts';
import { schema as progress } from './progress.schema.ts';
import { schema as proscons } from './proscons.schema.ts';
import { schema as stats } from './stats.schema.ts';
import { schema as steps } from './steps.schema.ts';
import { schema as timeline } from './timeline.schema.ts';
import { schema as tree } from './tree.schema.ts';

// `type` in a ```ui block → its schema. React-free, so the server checks blocks with the same rules.
export const schemas = {
  chart,
  compare,
  stats,
  timeline,
  steps,
  checklist,
  callout,
  kv,
  donut,
  progress,
  heatmap,
  proscons,
  matrix,
  diagram,
  files,
  beforeafter,
  tree,
} satisfies Record<string, z.ZodType>;

export type UiType = keyof typeof schemas;
