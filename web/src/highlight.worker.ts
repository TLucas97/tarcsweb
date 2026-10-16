// Shiki runs here, off the main thread: one long minified line can take hundreds of ms to tokenize.
import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemeRegistration } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
// Static imports keep the worker a single bundle in any worker output format.
import typescript from 'shiki/dist/langs/typescript.mjs';
import tsx from 'shiki/dist/langs/tsx.mjs';
import javascript from 'shiki/dist/langs/javascript.mjs';
import jsx from 'shiki/dist/langs/jsx.mjs';
import json from 'shiki/dist/langs/json.mjs';
import shellscript from 'shiki/dist/langs/shellscript.mjs';
import css from 'shiki/dist/langs/css.mjs';
import html from 'shiki/dist/langs/html.mjs';
import python from 'shiki/dist/langs/python.mjs';
import rust from 'shiki/dist/langs/rust.mjs';
import go from 'shiki/dist/langs/go.mjs';
import yaml from 'shiki/dist/langs/yaml.mjs';
import toml from 'shiki/dist/langs/toml.mjs';
import sql from 'shiki/dist/langs/sql.mjs';
import diff from 'shiki/dist/langs/diff.mjs';
import markdown from 'shiki/dist/langs/markdown.mjs';
import docker from 'shiki/dist/langs/docker.mjs';
import type { Token } from './highlight.ts';

const GRAMMARS: Record<string, LanguageRegistration[]> = {
  typescript, tsx, javascript, jsx, json, shellscript, css, html, python, rust, go, yaml, toml, sql, diff, markdown, docker,
};

// The mockup's code colors: keywords purple, strings green, functions blue, comments faint.
// Colors are CSS vars (Shiki passes non-hex colors through), so a theme switch recolors cached tokens with no re-tokenizing.
const THEME: ThemeRegistration = {
  name: 'claude',
  type: 'light',
  colors: { 'editor.background': '#ffffff', 'editor.foreground': 'var(--ink)' },
  tokenColors: [
    { settings: { foreground: 'var(--ink)' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: 'var(--faint)' } },
    { scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'constant.language', 'variable.language', 'entity.name.tag', 'keyword.operator.new', 'keyword.operator.expression', 'support.type.primitive'], settings: { foreground: 'var(--tk-kw,#8a4f9e)' } },
    { scope: ['keyword.operator', 'punctuation'], settings: { foreground: 'var(--muted)' } },
    { scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string', 'markup.inserted', 'constant.other.symbol'], settings: { foreground: 'var(--green)' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function', 'entity.other.attribute-name', 'support.type.property-name', 'meta.object-literal.key'], settings: { foreground: 'var(--tk-fn,#2f6690)' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.class', 'support.type', 'entity.other.inherited-class'], settings: { foreground: 'var(--tk-fn,#2f6690)' } },
    { scope: ['constant.numeric', 'constant.character.escape', 'markup.deleted'], settings: { foreground: 'var(--red)' } },
    { scope: ['markup.heading', 'markup.bold'], settings: { foreground: 'var(--ink)', fontStyle: 'bold' } },
  ],
};

export type HighlightRequest = { id: number; code: string; lang: string };
export type HighlightReply = { id: number; lines: Token[][] | null };

let core: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

async function tokenize(code: string, lang: string): Promise<Token[][] | null> {
  if (!GRAMMARS[lang]) return null;
  core ??= createHighlighterCore({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  const h = await core;
  if (!loaded.has(lang)) {
    await h.loadLanguage(...GRAMMARS[lang]);
    loaded.add(lang);
  }
  return h.codeToTokens(code, { lang, theme: 'claude' }).tokens.map((line) => line.map((t) => ({ content: t.content, color: t.color })));
}

self.addEventListener('message', (e: MessageEvent<HighlightRequest>) => {
  const { id, code, lang } = e.data;
  tokenize(code, lang).then(
    (lines) => self.postMessage({ id, lines } satisfies HighlightReply),
    () => self.postMessage({ id, lines: null } satisfies HighlightReply),
  );
});
