import { Suspense, lazy } from 'react';
import { useWidgets } from './state.ts';

// The widgets' code loads once there is one.
const Widgets = lazy(() => import('./Widgets.tsx'));

export function WidgetsMount() {
  const any = useWidgets((s) => s.list.length > 0);
  if (!any) return null;
  return <Suspense fallback={null}><Widgets /></Suspense>;
}
