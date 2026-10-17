import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { HANDOFF_PREFIX, SUMMARY_PREFIX, type ActiveSkill, type ServerEvent } from './protocol.ts';

// The library chip's line (web/src/skills/ref.tsx) and a typed /command's name.
const CHIP = /^Use the skill "([^"\n]{1,120})": read and follow (\/.*SKILL\.md)$/gm;
const SLASH = /^\/([\w:.@-]+)/;
const MAX = 40;

type Entry = { name: string; how: ActiveSkill['how']; path?: string; kept?: true; lost?: true };

// The skills the main agent has in context, fed every main-agent event (live or resumed).
export class ActiveSkills {
  // Capped at MAX, like calls.
  private list: Entry[] = [];
  // Skill tool calls waiting for their result, so a failed one is taken back.
  private calls = new Map<string, string>();
  private view: ActiveSkill[] = [];
  private viewFrom: { list: Entry[]; cmds: SlashCommand[] | null } | null = null;

  // True when the list changed.
  note(e: ServerEvent): boolean {
    if (e.type === 'tool' && e.name === 'Skill' && !e.partial && e.summary) {
      this.calls.set(e.id, e.summary);
      if (this.calls.size > MAX) this.calls.delete(this.calls.keys().next().value!);
      return this.add({ name: e.summary, how: 'tool' });
    }
    if (e.type === 'tool-result') {
      const name = this.calls.get(e.id);
      if (name === undefined) return false;
      this.calls.delete(e.id);
      if (!e.error) return false;
      const before = this.list.length;
      this.list = this.list.filter((s) => !(s.name === name && s.how === 'tool'));
      return this.list.length !== before;
    }
    if (e.type !== 'user') return false;
    // A resumed transcript starts at the summary; a live compaction may also send it.
    if (e.text.startsWith(SUMMARY_PREFIX) || e.text.startsWith(HANDOFF_PREFIX)) return this.compacted();
    let changed = false;
    const slash = SLASH.exec(e.text)?.[1];
    if (slash) changed = this.add({ name: slash, how: 'slash' });
    for (const m of e.text.matchAll(CHIP)) changed = this.add({ name: m[1], how: 'chip', path: m[2] }) || changed;
    return changed;
  }

  // The CLI re-attaches skills it loaded (maybe shortened); a chip was a plain read, so it is gone.
  compacted(): boolean {
    if (!this.list.length || this.list.every((s) => s.kept || s.lost)) return false;
    this.list = this.list.map((s) => (s.how === 'chip' ? { ...s, lost: true as const } : { ...s, kept: true as const }));
    return true;
  }

  // A /command counts only once the command list knows it as a non-builtin one.
  snapshot(cmds: SlashCommand[] | null): ActiveSkill[] {
    if (this.viewFrom?.list === this.list && this.viewFrom.cmds === cmds) return this.view;
    const byName = new Map(cmds?.map((c) => [c.name, c]));
    this.view = this.list.flatMap((s) => {
      const c = byName.get(s.name);
      if (s.how === 'slash' && (!c || c.builtin)) return [];
      return [{ ...s, ...(c?.description ? { desc: c.description } : {}) }];
    });
    this.viewFrom = { list: this.list, cmds };
    return this.view;
  }

  private add(s: Entry): boolean {
    const old = this.list.find((x) => x.name === s.name);
    if (old && !old.kept && !old.lost && (old.how === s.how || s.how === 'slash')) return false;
    const rest = this.list.filter((x) => x !== old);
    // Past the cap, dropped skills go first, then the oldest.
    while (rest.length >= MAX) rest.splice(Math.max(0, rest.findIndex((x) => x.lost)), 1);
    this.list = [...rest, s];
    return true;
  }
}
