import { inTauri } from './tauri.ts';

// Desktop windows reserve no keys; a normal tab keeps Ctrl+Tab and Ctrl+digit for itself.
export const ownsCtrlKeys = () => inTauri() || matchMedia('(display-mode: standalone)').matches;
