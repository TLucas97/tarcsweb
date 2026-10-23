// Chrome's --app windows report standalone and reserve no keys; a normal tab keeps Ctrl+Tab and Ctrl+digit for itself.
export const ownsCtrlKeys = () => matchMedia('(display-mode: standalone)').matches;
