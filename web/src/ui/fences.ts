// Keep raw line indexes intact for the streaming Markdown cache.
export function repairUiFenceLines(lines: string[]): string[] {
  let close: RegExp | null = null;
  let inline: RegExp | null = null;
  let indent = '';
  let body: string[] = [];
  return lines.map((line) => {
    if (!close) {
      const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (!m || (m[2][0] === '`' && m[3].includes('`'))) return line;
      close = new RegExp(`^ {0,3}${m[2][0]}{${m[2].length},}[ \\t\\r]*$`);
      inline = m[3].trim() === 'ui' ? new RegExp(`${m[2][0]}{${m[2].length},}[ \\t\\r]*$`) : null;
      indent = m[1];
      body = [];
      return line;
    }
    if (close.test(line)) {
      close = inline = null;
      return line;
    }
    if (!inline) return line;
    const end = inline.exec(line);
    if (end) {
      const head = line.slice(0, end.index);
      try {
        const value: unknown = JSON.parse([...body, head].join('\n'));
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          close = inline = null;
          return `${head}\n${indent}${end[0].trim()}`;
        }
      } catch {
        // A fence-like string inside JSON is not a closing delimiter.
      }
    }
    body.push(line);
    return line;
  });
}
