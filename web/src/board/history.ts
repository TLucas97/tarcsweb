import type { El } from './types.ts';

// One gesture is one entry: the touched elements as they were and as they became. Absent from `before` means added.
export type Change = { before: readonly El[]; after: readonly El[] };
type Entry = Change & { bytes: number };

const MAX_ENTRIES = 100;
const MAX_BYTES = 16 * 1024 * 1024;

// Rough retained size, enough to enforce the byte cap.
function bytesOf(el: El) {
  switch (el.kind) {
    case 'stroke':
    case 'poly':
      return 96 + el.pts.length * 8;
    case 'text':
      return 160 + el.text.length * 2;
    case 'line':
    case 'arrow':
      return 160 + (el.pts?.length ?? 0) * 8;
    case 'rect':
    case 'ellipse':
      return 160 + (el.label?.text.length ?? 0) * 2;
    default:
      return 160;
  }
}

const sizeOf = (c: Change) => c.before.reduce((n, el) => n + bytesOf(el), 0) + c.after.reduce((n, el) => n + bytesOf(el), 0);

export class History {
  private done: Entry[] = [];
  private undone: Entry[] = [];
  private bytes = 0;

  get canUndo() {
    return this.done.length > 0;
  }

  get canRedo() {
    return this.undone.length > 0;
  }

  push(c: Change) {
    for (const e of this.undone) this.bytes -= e.bytes;
    this.undone = [];
    const entry = { ...c, bytes: sizeOf(c) };
    this.done.push(entry);
    this.bytes += entry.bytes;
    // Oldest go first. An entry over the whole budget evicts everything older and stays alone, so the latest gesture can still be undone.
    while (this.done.length > 1 && (this.done.length > MAX_ENTRIES || this.bytes > MAX_BYTES)) this.bytes -= this.done.shift()!.bytes;
  }

  // Every element an entry still holds, so resources they point at (pictures) stay alive.
  *elements(): Generator<El> {
    for (const e of [...this.done, ...this.undone]) yield* [...e.before, ...e.after];
  }

  // The change to apply to the scene, already reversed for undo.
  undo(): Change | null {
    const e = this.done.pop();
    if (!e) return null;
    this.undone.push(e);
    return { before: e.after, after: e.before };
  }

  redo(): Change | null {
    const e = this.undone.pop();
    if (!e) return null;
    this.done.push(e);
    return e;
  }
}
