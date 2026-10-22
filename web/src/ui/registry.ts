import { callout } from './callout.tsx';
import { chart } from './chart.tsx';
import { checklist } from './checklist.tsx';
import { compare } from './compare.tsx';
import type { UiDef } from './define.ts';
import { donut } from './donut.tsx';
import { heatmap } from './heatmap.tsx';
import { kv } from './kv.tsx';
import { progress } from './progress.tsx';
import { stats } from './stats.tsx';
import { steps } from './steps.tsx';
import { timeline } from './timeline.tsx';
import { proscons } from './proscons.tsx';
import { matrix } from './matrix.tsx';
import { diagram } from './diagram.tsx';
import { files } from './files.tsx';
import { beforeafter } from './beforeafter.tsx';
import { tree } from './tree.tsx';
import type { UiType } from './schemas.ts';

// `type` in a ```ui block → its component. Add a component: foo.schema.ts plus foo.tsx in ui/, a line here and in schemas.ts, a line in server/prompt.ts.
export const registry: Record<UiType, UiDef> = {
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
};
