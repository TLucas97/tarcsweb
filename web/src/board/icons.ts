import { LUCIDE } from './vendor/lucide.ts';

// Common names a model or a person may use for the same icon.
const ALIASES: Record<string, string> = {
  home: 'house',
  hamburger: 'menu',
  filter: 'funnel',
  edit: 'pencil',
  cart: 'shopping-cart',
  bag: 'shopping-bag',
  more: 'ellipsis',
  'more-horizontal': 'ellipsis',
  'more-vertical': 'ellipsis-vertical',
  close: 'x',
  'trash-2': 'trash',
  delete: 'trash',
  grid: 'layout-grid',
  profile: 'circle-user',
  account: 'circle-user',
  notification: 'bell',
  location: 'map-pin',
  pin: 'map-pin',
  message: 'message-circle',
  chat: 'message-square',
  help: 'circle-question-mark',
  'help-circle': 'circle-question-mark',
  alert: 'circle-alert',
  'alert-circle': 'circle-alert',
  unlock: 'lock-open',
  volume: 'volume-2',
  sound: 'volume-2',
  photo: 'image',
  picture: 'image',
  like: 'thumbs-up',
  favorite: 'heart',
  refresh: 'refresh-cw',
  logout: 'log-out',
  login: 'log-in',
  back: 'chevron-left',
  next: 'chevron-right',
  sliders: 'sliders-horizontal',
  checkbox: 'square-check',
};

export const ICON_NAMES = Object.keys(LUCIDE);

export const iconKey = (name: string) => {
  const n = name.trim().toLowerCase();
  return LUCIDE[n] ? n : ALIASES[n] ?? null;
};

// Neutral stand-in for names outside the set: a box with a cross.
const PLACEHOLDER = 'M4 4h16v16H4zM4 4l16 16M20 4 4 20';

// One path per icon name in its 24x24 box, shared by every element showing it.
const paths = new Map<string, Path2D>();

export function iconPath(name: string) {
  const key = iconKey(name) ?? '';
  let p = paths.get(key);
  if (!p) {
    p = new Path2D(key ? LUCIDE[key] : PLACEHOLDER);
    paths.set(key, p);
  }
  return p;
}
