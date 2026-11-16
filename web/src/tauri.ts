// The desktop app's window exposes its API as window.__TAURI__ (app.withGlobalTauri); a browser has none of it.
type TauriApi = {
  core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
  notification?: {
    isPermissionGranted(): Promise<boolean>;
    requestPermission(): Promise<NotificationPermission>;
    sendNotification(o: { title: string; body?: string; icon?: string }): void;
  };
  opener?: { openUrl(url: string): Promise<void> };
  window?: { getCurrentWindow(): { close(): Promise<void> } };
};

declare global {
  interface Window {
    __TAURI__?: TauriApi;
  }
}

export const inTauri = () => !!window.__TAURI__;

// WebKit bounces scroll areas and zooms the page on trackpad pinch; the desktop window turns both off (styles.css, main.rs).
if (inTauri()) {
  document.documentElement.dataset.shell = 'desktop';
  for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = window.__TAURI__;
  return t ? t.core.invoke<T>(cmd, args) : Promise.reject(new Error('Only the tarcsweb desktop app can do this'));
}

// Last known answer, so desktopOn() can read it synchronously; refreshed by notifyPermission.
let permission: NotificationPermission = 'default';
export const notifyAllowed = () => permission === 'granted';

// The plugin's own globals when injected, else its commands by name.
export async function notifyPermission(ask = false): Promise<NotificationPermission> {
  const n = window.__TAURI__?.notification;
  const granted = n ? await n.isPermissionGranted() : await invoke<boolean>('plugin:notification|is_permission_granted');
  if (granted) permission = 'granted';
  else if (ask) permission = n ? await n.requestPermission() : await invoke<NotificationPermission>('plugin:notification|request_permission');
  else if (permission === 'granted') permission = 'default';
  return permission;
}

// A system notification from the desktop window; Settings asks for the permission. No-op in a browser.
export function notify(title: string, body: string, tag: string, sessionId: string) {
  if (!inTauri() || permission !== 'granted') return;
  void invoke('notify_session', { title, body, tag, sessionId }).catch((error) => console.error('Could not send notification', error));
}

// Tauri rejects with a string or an object; never show "[object Object]".
export function errorText(e: unknown, fallback: string) {
  if (typeof e === 'string' && e) return e;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m ? m : fallback;
}

// tray: whether the app has a tray (or menu bar) icon to keep it running after its windows close.
export type AppInfo = { version: string; os: string; devtools: boolean; tray?: boolean; notificationIcon?: string | null };
let info: Promise<AppInfo | null> | null = null;
export const appInfo = () => (info ??= inTauri() ? invoke<AppInfo>('shell_info').catch(() => null) : Promise.resolve(null));

export type DesktopBuild = {
  version: string; kind: 'source' | 'release'; sourceDir: string | null;
  commit: string | null; dirty: boolean; canRebuild: boolean;
};
export type DesktopUpdate = {
  phase: 'idle' | 'checking' | 'available' | 'latest' | 'building' | 'downloading' | 'installing' | 'restarting' | 'failed';
  version?: string; progress?: number | null; message?: string; logPath?: string;
};

export function listenDesktopUpdate(handler: (status: DesktopUpdate) => void) {
  const t = window.__TAURI__;
  return t ? t.event.listen<DesktopUpdate>('desktop-update', (event) => handler(event.payload))
    : Promise.resolve(() => {});
}

export async function installDesktopUpdate() {
  await invoke('install_update');
  await invoke('prepare_restart');
  await invoke('plugin:process|restart');
}

// The desktop window never opens pages itself, so links go to the system browser.
export function openExternal(url: string) {
  const t = window.__TAURI__;
  if (!t) return void window.open(url, '_blank', 'noopener');
  const opener = () => t.opener ? t.opener.openUrl(url) : t.core.invoke('plugin:opener|open_url', { url });
  void appInfo().then((info) => info?.os === 'linux'
    ? t.core.invoke('open_external', { url }).catch(opener)
    : opener()).catch((error) => console.error('Could not open external link', error));
}

// Resolves false when this window could not close itself.
export async function closeWindow(): Promise<boolean> {
  const w = window.__TAURI__?.window;
  if (!w) return false;
  return w.getCurrentWindow().close().then(() => true, () => false);
}

// One document listener for every new-tab link; React handlers run first, so a handled click stays handled.
function externalLink(e: MouseEvent) {
  if (e.defaultPrevented || (e.type === 'click' ? e.button !== 0 : e.button !== 1)) return;
  const a = (e.target as Element | null)?.closest?.('a[href]');
  if (!(a instanceof HTMLAnchorElement) || a.hasAttribute('download')) return;
  if (!/^(https?|mailto):$/.test(a.protocol)) return;
  if (a.target !== '_blank' && a.origin === location.origin) return;
  e.preventDefault();
  openExternal(a.href);
}

export function setupTauri() {
  if (!inTauri()) return;
  document.addEventListener('click', externalLink);
  document.addEventListener('auxclick', externalLink);
}
