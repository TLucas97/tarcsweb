import type { MouseEvent } from 'react';
import { useStore } from './store.ts';

// Apart from ImageViewer.tsx so that viewer loads lazily on first open.
export function openImage(e: MouseEvent<HTMLImageElement>, full?: string) {
  const img = e.currentTarget;
  e.stopPropagation();
  useStore.setState({
    viewer: { src: img.currentSrc || img.src, full: full ?? null, alt: img.alt, from: img.getBoundingClientRect(), ratio: img.naturalWidth / img.naturalHeight || 1 },
  });
}
