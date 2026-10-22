import { blockTypeOf, checkUi, squash, uiFences } from '../web/src/ui/check.ts';

// A reply longer than this is not checked; the client still reports what it fails to draw.
const SCAN_MAX = 200_000;

// The turn's latest reply item, checked at turn end for ```ui blocks that would not draw.
export class UiReplyCheck {
  private id: string | null = null;
  private text = '';
  private over = false;

  // Fed the same deltas the client appends, so fence indexes match its report.
  add(id: string, delta: string) {
    if (id !== this.id) {
      this.id = id;
      this.text = '';
      this.over = false;
    }
    if (this.over) return;
    if (this.text.length + delta.length > SCAN_MAX) {
      this.over = true;
      this.text = '';
    } else this.text += delta;
  }

  // Reports by the client's key (itemId#index) and wording; identical bodies count once, as the client's index does.
  flush(report: (itemId: string, index: number, type: string, why: string) => void) {
    const { id, text } = this;
    this.id = null;
    this.text = '';
    this.over = false;
    if (!id || !/^\s*(`{3,}|~{3,})\s*ui\s*$/m.test(text)) return;
    const seen = new Set<string>();
    uiFences(text).forEach((src, index) => {
      const key = squash(src);
      if (seen.has(key)) return;
      seen.add(key);
      const r = checkUi(src);
      if (!r.ok) report(id, index, blockTypeOf(src), r.why);
    });
  }
}
