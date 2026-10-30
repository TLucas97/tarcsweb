// Stretchtext parser, adapted from cc-stretch: https://github.com/pro-vi/cc-stretch (hooks/parse.ts)
//
// MIT License
//
// Copyright (c) 2026 pro-vi
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// A reply is markdown in which `{{short|long}}` marks a stretch: the reader
// sees `short`, and opening it puts `long` in its place. `long` may hold
// further stretches. Code spans and fences are copied as written, so braces in
// code never open a stretch.

export type Segment = string | Stretch

export type Stretch = {
  /**
   * Names the stretch by its short form and its parents' (`cache › key`), so a
   * stretch added elsewhere in the reply leaves every other key as it was. A
   * short form repeated among siblings takes `~2`, `~3`.
   */
  key: string
  short: string
  /** Undefined when no `|` was written: then there is nothing to open, and `short` is plain text. */
  long: Segment[] | undefined
  /** False while the reply streams and the closing braces have not arrived. */
  isClosed: boolean
}

type Frame = { stretch: Stretch; siblings: Map<string, number> }

export const KEY_SEPARATOR = ' › '

export function isOpenable(stretch: Stretch): boolean {
  return stretch.isClosed && stretch.long !== undefined
}

/** Whether a stretch is drawn as a link: openable, with its short form on one line, as a link cannot span lines. */
export function isLinkable(stretch: Stretch): boolean {
  return isOpenable(stretch) && !stretch.short.includes('\n')
}

/**
 * An open stretch's long form followed by its `closer`, after a space, or after `gap` when the long
 * form ends in a line text after it would change: a rule, which then reads as plain dashes, or a code
 * fence, which then no longer closes.
 */
export function closeAfter(long: string, closer: string, gap: string): string {
  const trimmed = long.trimEnd()
  const last = trimmed.slice(trimmed.lastIndexOf('\n') + 1)
  const endsInBlock = isRule(last) || /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(last)

  return endsInBlock ? `${trimmed}${gap}${closer}` : `${trimmed} ${closer}`
}

/** Whether `line` is a rule: three or more of one of `-`, `*` and `_`, spaces between allowed. */
export function isRule(line: string): boolean {
  return /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)
}

/** Where the code span opening at `i` ends: past the next run of exactly as many backticks in the same paragraph; an unmatched run is literal text, as in CommonMark. */
export function codeSpanEnd(text: string, i: number): number {
  const run = /^`+/.exec(text.slice(i))?.[0] ?? '`'
  const closer = new RegExp(`(?<!\`)${run}(?!\`)`, 'g')
  closer.lastIndex = i + run.length
  const end = closer.exec(text)
  const paragraph = /\n[ \t]*\n/g
  paragraph.lastIndex = i
  const blank = paragraph.exec(text)
  return end && (!blank || end.index < blank.index) ? end.index + run.length : i + run.length
}

export function parse(text: string): Segment[] {
  const root: Segment[] = []
  const stack: Frame[] = []
  const rootSiblings = new Map<string, number>()

  const write = (chunk: string) => {
    const frame = stack.at(-1)
    if (frame && frame.stretch.long === undefined) {
      frame.stretch.short += chunk
      return
    }
    const segments = frame?.stretch.long ?? root
    const last = segments.at(-1)
    if (typeof last === 'string') segments[segments.length - 1] = last + chunk
    else segments.push(chunk)
  }

  let i = 0
  while (i < text.length) {
    const frame = stack.at(-1)
    const isInShort = frame !== undefined && frame.stretch.long === undefined

    const fenceStop = i === 0 || text[i - 1] === '\n' ? fenceEnd(text, i) : undefined
    if (fenceStop !== undefined) {
      write(text.slice(i, fenceStop))
      i = fenceStop
      continue
    }

    if (text[i] === '`') {
      const stop = codeSpanEnd(text, i)
      write(text.slice(i, stop))
      i = stop
      continue
    }

    if (text.startsWith('{{', i) && !isInShort) {
      const stretch: Stretch = {
        key: '',
        short: '',
        long: undefined,
        isClosed: false,
      }
      ;(frame?.stretch.long ?? root).push(stretch)
      stack.push({ stretch, siblings: new Map() })
      i += 2
      continue
    }

    if (isInShort && text[i] === '|') {
      frame.stretch.key = keyOf(frame.stretch.short, stack.at(-2), rootSiblings)
      frame.stretch.long = []
      i += 1
      continue
    }

    if (frame && text.startsWith('}}', i)) {
      frame.stretch.isClosed = true
      stack.pop()
      i += 2
      continue
    }

    write(text[i] ?? '')
    i += 1
  }

  return root
}

function keyOf(short: string, parent: Frame | undefined, rootSiblings: Map<string, number>): string {
  const name = short.trim()
  const siblings = parent?.siblings ?? rootSiblings
  const seen = (siblings.get(name) ?? 0) + 1
  siblings.set(name, seen)
  const own = seen === 1 ? name : `${name}~${seen}`

  return parent ? `${parent.stretch.key}${KEY_SEPARATOR}${own}` : own
}

/** Where a fenced code block opening at `start` ends (past its closing line), or undefined when no fence opens there. */
function fenceEnd(text: string, start: number): number | undefined {
  const lineEnd = (from: number) => {
    const end = text.indexOf('\n', from)
    return end === -1 ? text.length : end
  }
  const opening = /^[ \t]*(`{3,}|~{3,})/.exec(text.slice(start, lineEnd(start)))?.[1]
  if (opening === undefined) return undefined

  for (let at = lineEnd(start) + 1; at < text.length; at = lineEnd(at) + 1) {
    const line = text.slice(at, lineEnd(at)).trim()
    if (line.length >= opening.length && [...line].every(c => c === opening[0])) return Math.min(lineEnd(at) + 1, text.length)
  }

  return text.length
}

/** Every stretch, outermost first, in the order the reply writes them. */
export function stretches(segments: Segment[]): Stretch[] {
  return segments.flatMap(segment =>
    typeof segment === 'string' ? [] : [segment, ...stretches(segment.long ?? [])],
  )
}

/** How many stretches stand open after `line`, given `depth` open before it; code spans are skipped. */
export function depthAfter(line: string, depth: number): number {
  let open = depth
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '`') {
      i = codeSpanEnd(line, i) - 1
    } else if (line.startsWith('{{', i)) {
      open += 1
      i += 1
    } else if (open > 0 && line.startsWith('}}', i)) {
      open -= 1
      i += 1
    }
  }

  return open
}

/** A stretch as it was written, braces and all: one without `|`, or one the reply never closed. */
export function verbatim(stretch: Stretch): string {
  const long = stretch.long === undefined ? '' : `|${stretch.long.map(part => (typeof part === 'string' ? part : verbatim(part))).join('')}`
  return `{{${stretch.short}${long}${stretch.isClosed ? '}}' : ''}`
}

/** The reply with every stretch drawn as `pick` chooses, or verbatim when it is not a stretch. */
function flatten(segments: Segment[], pick: (stretch: Stretch) => 'short' | 'long'): string {
  return segments
    .map(part => {
      if (typeof part === 'string') return part
      if (!isOpenable(part) || part.long === undefined) return verbatim(part)
      // A short form over several lines is always drawn open.
      return pick(part) === 'long' || !isLinkable(part) ? flatten(part.long, pick) : part.short
    })
    .join('')
}

/** The full reply with the markup gone, every long form in place: for anything that feeds a model. */
export function fullText(text: string): string {
  return text.includes('{{') ? flatten(parse(text), () => 'long') : text
}

/** A streaming reply's tail, short forms only: a stretch still open, or cut off at the tail's start, is left out. */
export function previewTail(tail: string, cut: boolean): string {
  let from = 0
  let depth = 0
  let openAt = -1
  let pipe = false
  let i = 0
  while (i < tail.length) {
    const fenceStop = i === 0 || tail[i - 1] === '\n' ? fenceEnd(tail, i) : undefined
    if (fenceStop !== undefined) {
      i = fenceStop
    } else if (tail[i] === '`') {
      i = codeSpanEnd(tail, i)
    } else if (tail.startsWith('{{', i)) {
      if (depth++ === 0) openAt = i
      i += 2
    } else if (tail.startsWith('}}', i)) {
      // An unmatched `}}` closes a stretch cut off at the start when the tail lost its beginning or a `|` came first; else it is literal, as in JSON.
      if (depth > 0) depth--
      else if (cut || pipe) {
        from = i + 2
        pipe = false
      }
      i += 2
    } else {
      if (depth === 0 && tail[i] === '|') pipe = true
      i += 1
    }
  }
  return shownText(tail.slice(from, depth > 0 ? openAt : undefined), () => false)
}

/** The reply with the stretches in `open` (by key) drawn long. */
export function shownText(text: string, open: (stretch: Stretch) => boolean): string {
  return text.includes('{{') ? flatten(parse(text), stretch => (open(stretch) ? 'long' : 'short')) : text
}
