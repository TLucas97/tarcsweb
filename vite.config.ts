import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';

const target = `http://127.0.0.1:${process.env.CW_PORT || 24817}`;
const proxy = { '/ws': { target, ws: true }, '/files': { target }, '/api/board': { target } };

// Text size setting: px font sizes and line heights become calc(N * var(--ts,1)); --ts is set only where text scales (styles.css).
const scalePx = (v: string) => v.replace(/(^|[\s/])(\d*\.?\d+)px\b/g, (_, pre: string, n: string) => `${pre}calc(${n}px * var(--ts,1))`);
const textScale = {
  postcssPlugin: 'text-scale',
  Declaration(decl: { prop: string; value: string }) {
    if (decl.prop === 'font-size' || decl.prop === 'line-height' || decl.prop === 'font') decl.value = scalePx(decl.value);
  },
};

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true },
  css: { postcss: { plugins: [textScale] } },
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: { host: '127.0.0.1', port: 24816, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
});
