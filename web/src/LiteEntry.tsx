import { Suspense, lazy } from 'react';
import { useSuggestion } from './machine.ts';

const Card = lazy(() => import('./LiteSuggest.tsx'));

export function LiteSuggest() {
  const reason = useSuggestion();
  return reason ? <Suspense fallback={null}><Card reason={reason} /></Suspense> : null;
}
