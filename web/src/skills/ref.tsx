// A skill attached to a message: the agent gets its SKILL.md path, the bubble shows a chip with the name.
export type SkillRef = { name: string; path: string };

// Plain text either agent can act on; the client parses the same line back into a chip.
const LINE = /^Use the skill "([^"\n]{1,120})": read and follow (\/.*SKILL\.md)$/;
const lineOf = (s: SkillRef) => `Use the skill "${s.name.replace(/"/g, "'")}": read and follow ${s.path}`;

// The typed text, then one line per skill after a blank line.
export function withSkills(text: string, skills: SkillRef[]) {
  if (!skills.length) return text;
  return [text, skills.map(lineOf).join('\n')].filter(Boolean).join('\n\n');
}

// The reverse for sent bubbles and saved transcripts: trailing skill lines become chips.
export function splitSkills(text: string): { text: string; skills: SkillRef[] } {
  if (!text.includes('Use the skill "')) return { text, skills: [] };
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  const skills: SkillRef[] = [];
  for (let m; end > 0 && (m = LINE.exec(lines[end - 1])); end--) skills.unshift({ name: m[1], path: m[2] });
  return skills.length ? { text: lines.slice(0, end).join('\n').trimEnd(), skills } : { text, skills };
}

export const SkillIcon = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 3.25a1.5 1.5 0 0 1 1.5-1.5h7.75v10H4.5A1.5 1.5 0 0 0 3 13.25z" /><path d="M3 13.25a1.5 1.5 0 0 0 1.5 1.5h7.75v-3" /><path d="m7.6 4.6.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z" />
  </svg>
);

// The composer's chip has an ×; the sent one shows the path on hover.
export function SkillChip({ skill, onRemove }: { skill: SkillRef; onRemove?: () => void }) {
  return (
    <span className="sk-chip" title={skill.path}>
      <SkillIcon size={13} />
      <span className="sk-chip-n">{skill.name}</span>
      {onRemove && <button type="button" className="x" aria-label={`Remove skill ${skill.name}`} title="Remove" onClick={onRemove}>×</button>}
    </span>
  );
}
