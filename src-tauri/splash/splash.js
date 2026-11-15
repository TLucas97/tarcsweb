const invoke = window.__TAURI__.core.invoke;
document.querySelector('#retry').onclick = () => invoke('retry_startup');
document.querySelector('#quit').onclick = () => invoke('quit');
async function update() {
  try {
    const state = await invoke('startup_status');
    document.querySelector('#status').textContent = state.error || 'Starting the server…';
    document.querySelector('#logs').textContent = state.error ? state.logs.join('\n') : '';
    document.querySelector('#actions').hidden = !state.error;
  } catch (error) {
    document.querySelector('#status').textContent = String(error);
  }
}
setInterval(update, 500);
update();
