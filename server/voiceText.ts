// Compare spoken words, ignoring case and punctuation without accepting missing or rewritten words.
export function readingProgress(script: string, transcript: string): 'prefix' | 'complete' | 'mismatch' {
  const words = (s: string) => s.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const expected = words(script), actual = words(transcript);
  if (!expected.length || actual.length > expected.length || actual.some((w, i) => w !== expected[i])) return 'mismatch';
  return actual.length === expected.length ? 'complete' : 'prefix';
}

// Keep each recording within the transport's duration and upload limits without dropping text.
export function readingChunks(script: string): string[] {
  const chunks: string[] = [];
  const words = [...script.matchAll(/\S+/g)];
  let start = 0;
  while (start < words.length) {
    let end = start, boundary = start;
    while (end < words.length && end - start < 160) {
      const token = words[end]!;
      const offset = token.index + token[0].length;
      if (end > start && offset - words[start]!.index > 1200) break;
      const next = words[end + 1];
      if (/[.!?…]["'”’)\]]*$/u.test(token[0]) || next && /\n\s*\n/.test(script.slice(offset, next.index))) boundary = end + 1;
      end++;
    }
    if (end < words.length && boundary > start) end = boundary;
    chunks.push(script.slice(words[start]!.index, end < words.length ? words[end]!.index : script.length).trim());
    start = end;
  }
  return chunks;
}
