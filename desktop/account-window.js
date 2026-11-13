const api = window.accountWindow;
const field = document.querySelector('#url');
let lastState;
function render(state) {
  document.documentElement.lang = state.locale;
  document.title = state.title;
  document.querySelector('#name').textContent = state.title;
  document.querySelector('#hint').textContent = state.labels.hint;
  document.querySelector('#back').setAttribute('aria-label', state.labels.back);
  document.querySelector('#reload').setAttribute('aria-label', state.labels.reload);
  field.setAttribute('aria-label', state.labels.address);
  document.querySelector('#go').textContent = state.labels.go;
  document.querySelector('#done').textContent = state.labels.done;
  document.querySelector('.header').hidden = false;
  const languageOnly = lastState && state.locale !== lastState.locale && state.url === lastState.url;
  if (document.activeElement !== field && !languageOnly) field.value = state.url;
  lastState = state;
  const error = document.querySelector('#error');
  error.textContent = state.error || '';
  error.style.display = state.error ? 'block' : 'none';
  document.querySelector('#hint').style.display = state.error ? 'none' : 'block';
}
async function command(action, value) {
  try {
    await api.command(action, value);
  } catch (error) {
    const box = document.querySelector('#error');
    box.textContent = error.message;
    box.style.display = 'block';
    document.querySelector('#hint').style.display = 'none';
  }
}
api.onState(render);
api.command('state').then(render);
document.querySelector('#navigation').addEventListener('submit', (event) => {
  event.preventDefault();
  command('navigate', field.value);
});
document.querySelector('#back').addEventListener('click', () => command('back'));
document.querySelector('#reload').addEventListener('click', () => command('reload'));
document.querySelector('#done').addEventListener('click', () => command('close'));
