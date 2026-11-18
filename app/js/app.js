// FitControl · tramo 1c: lista de rutinas, editor (crear/editar/duplicar/archivar) y selector de ejercicios.
import { FitDb } from './db.js';
import { validateTemplate } from './validate.js';
import { ValidationError } from './errors.js';
import { newDraft, draftFromTemplate, defaultItem, toNum, moveItem, removeItem, draftToInput, describeError } from './draft.js';
import { h, clear, norm } from './ui.js';
import { renderTraining, leave as leaveTraining } from './train.js';

const db = new FitDb('fitcontrol');
const root = document.getElementById('app');
const toastEl = document.getElementById('toast');
let exercises = [];
let exMap = new Map();
let toastTimer = null;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
}
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const exName = (id) => exMap.get(id)?.name;

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

// ---------------------------------------------------------------- lista
function installBanner() {
  // OJO: Node.append(null) escribe el texto "null". Un fragmento vacío no añade nada.
  if (isStandalone()) return document.createDocumentFragment();
  return h('div', { class: 'warn', role: 'note', 'data-test': 'install-banner' },
    h('strong', {}, 'Instala la app para no perder tus datos. '),
    'Tus datos se guardan solo en este dispositivo y el navegador puede borrarlos si la usas en una pestaña. ' +
    'Instálala (en iPhone: Compartir → «Añadir a pantalla de inicio») y ábrela desde el icono.');
}

async function startTraining(t) {
  try { const s = await db.startSession(t.id); go('#/train/' + s.id); }
  catch (e) { toast(e.message); }
}

async function abandonActive(s) {
  const n = (await db.getSession(s.id)).entries.length;
  const msg = n > 0 ? '¿Abandonar el entreno en curso? Se conservan las ' + n + ' series ya registradas.' : 'No hay series registradas: se descartará el entreno en curso.';
  if (!confirm(msg)) return;
  try { await db.setSessionState(s.id, n > 0 ? 'abandoned' : 'cancelled'); toast('Entreno cerrado'); await renderList(); }
  catch (e) { toast('No se pudo cerrar: ' + e.message); }
}

function activeBanner(s) {
  if (!s) return null;
  return h('div', { class: 'active-banner', 'data-test': 'active-banner' },
    h('p', {}, h('strong', {}, 'Entreno en curso: '), s.templateSnapshot.name),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', 'data-act': 'continue', onclick: () => go('#/train/' + s.id) }, 'Continuar'),
      h('button', { class: 'btn danger', type: 'button', 'data-act': 'abandon-active', onclick: () => abandonActive(s) }, 'Abandonar')));
}

function card(t, active) {
  const names = t.items.map((i) => exName(i.exerciseId) ?? '?');
  const preview = names.slice(0, 4).join(' · ') + (names.length > 4 ? ' · …' : '');
  return h('li', { class: 'card', 'data-id': t.id },
    h('h3', {}, t.name),
    h('p', { class: 'meta' }, t.items.length + (t.items.length === 1 ? ' ejercicio' : ' ejercicios') + ' · versión ' + t.version),
    h('p', { class: 'meta' }, preview),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', 'data-act': 'train', disabled: !!active, title: active ? 'Ya hay un entreno en curso' : null, onclick: () => startTraining(t) }, 'Entrenar'),
      h('button', { class: 'btn', type: 'button', 'data-act': 'edit', onclick: () => go('#/edit/' + t.id) }, 'Editar'),
      h('button', { class: 'btn', type: 'button', 'data-act': 'dup', onclick: () => duplicate(t) }, 'Duplicar'),
      h('button', { class: 'btn danger', type: 'button', 'data-act': 'archive', onclick: () => archive(t) }, 'Archivar')));
}

async function duplicate(t) {
  try { const c = await db.duplicateTemplate(t.id); toast('Copia creada: ' + c.name); await renderList(); }
  catch (e) { toast('No se pudo duplicar: ' + e.message); }
}
async function archive(t) {
  if (!confirm('¿Archivar «' + t.name + '»? Dejará de aparecer en tu lista, pero el historial de entrenos se conserva.')) return;
  try { await db.archiveTemplate(t.id); toast('Rutina archivada'); await renderList(); }
  catch (e) { toast('No se pudo archivar: ' + e.message); }
}

async function renderList() {
  const templates = await db.listTemplates();
  const active = await db.getActiveSession();
  clear(root);
  root.append(
    h('div', { class: 'bar' },
      h('h1', {}, 'Mis rutinas'),
      h('button', { class: 'btn primary', type: 'button', 'data-act': 'new', onclick: () => go('#/new') }, 'Nueva rutina')),
    installBanner(),
    activeBanner(active) ?? document.createDocumentFragment(),
    templates.length
      ? h('ul', { class: 'cards' }, templates.map((t) => card(t, active)))
      : h('div', { class: 'empty', 'data-test': 'empty' },
        h('p', {}, 'Aún no tienes rutinas.'),
        h('button', { class: 'btn primary', type: 'button', 'data-act': 'new-empty', onclick: () => go('#/new') }, 'Crear mi primera rutina')));
}

// ---------------------------------------------------------------- selector de ejercicios
function openPicker(onPick) {
  const groups = [...new Set(exercises.map((e) => e.muscleGroup))].sort();
  const listEl = h('div', { 'data-test': 'picker-list' });
  const search = h('input', { type: 'text', placeholder: 'Buscar ejercicio', 'aria-label': 'Buscar ejercicio', autocomplete: 'off', 'data-test': 'picker-search' });
  const group = h('select', { 'aria-label': 'Grupo muscular', 'data-test': 'picker-group' },
    h('option', { value: '' }, 'Todos los grupos'), groups.map((g) => h('option', { value: g }, g)));
  const prevFocus = document.activeElement;

  function close() {
    document.removeEventListener('keydown', onKey);
    sheet.remove(); document.body.classList.remove('noscroll');
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  function fill() {
    const q = norm(search.value);
    const found = exercises.filter((e) => (!group.value || e.muscleGroup === group.value) && norm(e.name).includes(q));
    clear(listEl);
    if (!found.length) listEl.append(h('p', { class: 'hint' }, 'Ningún ejercicio coincide.'));
    found.forEach((e) => listEl.append(h('button', {
      class: 'btn pick', type: 'button', 'data-act': 'pick', 'data-id': e.id,
      onclick: () => { close(); onPick(e); },
    }, e.name, h('small', {}, e.muscleGroup + ' · ' + e.equipment + ' · ' + (e.modality === 'time' ? 'por tiempo' : 'por repeticiones')))));
  }
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Elegir ejercicio' },
    h('div', { class: 'inner' },
      h('div', { class: 'bar' }, h('h2', { style: 'margin:0' }, 'Elegir ejercicio'),
        h('button', { class: 'btn', type: 'button', 'data-act': 'picker-close', onclick: close }, 'Cerrar')),
      h('div', { class: 'grid2' }, h('div', {}, search), h('div', {}, group)),
      h('div', { style: 'height:12px' }), listEl));
  search.addEventListener('input', fill); group.addEventListener('change', fill);
  document.addEventListener('keydown', onKey);
  document.body.classList.add('noscroll');
  document.body.append(sheet);
  fill(); search.focus();
}

// ---------------------------------------------------------------- editor
async function renderEditor(id) {
  let draft; let usedCount = 0;
  if (id) {
    const t = await db.getTemplate(id);
    if (!t || t.archivedAt) { toast('Esa rutina no existe o está archivada'); go('#/'); return; }
    draft = draftFromTemplate(t);
    usedCount = await db.countSessionsForTemplate(id);
  } else draft = newDraft();
  const initial = JSON.stringify(draft);
  const dirty = () => JSON.stringify(draft) !== initial;
  let saving = false;

  const summary = h('div', { class: 'summary', role: 'alert', 'data-test': 'summary' });
  const itemsEl = h('div', { 'data-test': 'items' });
  const saveBtn = h('button', { class: 'btn primary', type: 'submit', 'data-act': 'save' }, 'Guardar rutina');

  function numField(label, key, i, mode = 'numeric') {
    const v = draft.items[i][key];
    return h('label', { class: 'field' },
      h('span', {}, label),
      h('input', {
        type: 'text', inputmode: mode, autocomplete: 'off', 'data-f': key, 'data-i': i,
        value: v === undefined || Number.isNaN(v) ? '' : String(v),
        oninput: (e) => { draft.items[i][key] = toNum(e.target.value); },
      }),
      h('div', { class: 'err', 'data-field': 'items[' + i + '].' + key }));
  }
  function itemCard(it, i) {
    const ex = exMap.get(it.exerciseId);
    const timed = ex?.modality === 'time';
    return h('div', { class: 'card', 'data-i': i, style: 'margin-bottom:12px' },
      h('div', { class: 'item-head' },
        h('h3', {}, (i + 1) + '. ' + (ex?.name ?? '(ejercicio desconocido)')),
        h('button', { class: 'btn', type: 'button', 'aria-label': 'Subir', 'data-act': 'up', disabled: i === 0, onclick: () => { draft.items = moveItem(draft.items, i, -1); renderItems(); } }, '↑'),
        h('button', { class: 'btn', type: 'button', 'aria-label': 'Bajar', 'data-act': 'down', disabled: i === draft.items.length - 1, onclick: () => { draft.items = moveItem(draft.items, i, 1); renderItems(); } }, '↓'),
        h('button', { class: 'btn danger', type: 'button', 'aria-label': 'Quitar ejercicio', 'data-act': 'remove', onclick: () => { draft.items = removeItem(draft.items, i); renderItems(); } }, 'Quitar')),
      h('div', { class: 'grid2' },
        numField('Series', 'sets', i),
        timed ? numField('Duración (s)', 'durationSec', i) : numField('Repeticiones', 'reps', i),
        numField('Descanso (s)', 'restSec', i),
        timed ? null : numField('Peso objetivo (kg, opcional)', 'targetLoadKg', i, 'decimal')));
  }
  function renderItems() {
    clear(itemsEl);
    if (!draft.items.length) itemsEl.append(h('p', { class: 'hint' }, 'Añade al menos un ejercicio.'));
    draft.items.forEach((it, i) => itemsEl.append(itemCard(it, i)));
    itemsEl.append(h('div', { class: 'err', 'data-field': 'items' }));
  }
  function showErrors(errors) {
    form.querySelectorAll('.err').forEach((e) => { e.textContent = ''; });
    const lines = [];
    for (const err of errors) {
      lines.push(describeError(err, draft.items, exName));
      const slot = form.querySelector('[data-field="' + err.field + '"]');
      if (slot) slot.textContent = err.message;
    }
    clear(summary);
    summary.append(h('strong', {}, 'No se pudo guardar. Revisa:'), h('ul', {}, lines.map((l) => h('li', {}, l))));
    summary.scrollIntoView({ block: 'nearest' });
  }

  const form = h('form', { novalidate: true, 'data-test': 'editor' },
    h('h2', {}, id ? 'Editar rutina' : 'Nueva rutina'),
    usedCount > 0 ? h('div', { class: 'warn' }, 'Esta rutina ya se usó en ' + usedCount + (usedCount === 1 ? ' entreno' : ' entrenos') + '. Editarla no cambia el historial: cada entreno guarda su propia copia.') : null,
    summary,
    h('label', { class: 'field' }, h('span', {}, 'Nombre'),
      h('input', { type: 'text', name: 'name', maxlength: 100, autocomplete: 'off', value: draft.name, oninput: (e) => { draft.name = e.target.value; } }),
      h('div', { class: 'err', 'data-field': 'name' })),
    h('label', { class: 'field' }, h('span', {}, 'Objetivo (opcional)'),
      h('textarea', { name: 'goal', maxlength: 1000, value: draft.goal, oninput: (e) => { draft.goal = e.target.value; } }),
      h('div', { class: 'err', 'data-field': 'goal' })),
    h('h3', { style: 'margin:16px 0 8px' }, 'Ejercicios'),
    itemsEl,
    h('button', {
      class: 'btn', type: 'button', 'data-act': 'add-ex',
      onclick: () => openPicker((ex) => {
        draft.items.push(defaultItem(ex)); renderItems();
        const cards = itemsEl.querySelectorAll('.card');
        cards[cards.length - 1]?.querySelector('input')?.scrollIntoView({ block: 'center' });
      }),
    }, '+ Añadir ejercicio'),
    h('div', { class: 'actions' },
      saveBtn,
      h('button', {
        class: 'btn', type: 'button', 'data-act': 'cancel',
        onclick: () => { if (dirty() && !confirm('Hay cambios sin guardar. ¿Salir sin guardar?')) return; go('#/'); },
      }, 'Cancelar')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;                                  // evita el doble toque
    const input = draftToInput(draft);
    const v = validateTemplate(input, exMap);
    if (!v.ok) { showErrors(v.errors); return; }
    saving = true; saveBtn.disabled = true;
    try {
      if (id) await db.updateTemplate(id, input); else await db.createTemplate(input);
      toast('Rutina guardada');
      go('#/');
    } catch (err) {
      if (err instanceof ValidationError) showErrors(err.errors);
      else { clear(summary); summary.append('No se pudo guardar: ' + err.message); }
    } finally { saving = false; saveBtn.disabled = false; }
  });

  renderItems();
  clear(root); root.append(form);
  form.querySelector('input[name="name"]').focus();
}

// ---------------------------------------------------------------- rutas y arranque
async function route() {
  const hash = location.hash || '#/';
  if (!hash.startsWith('#/train/')) leaveTraining();      // suelta audio, temporizador y bloqueo de pantalla
  try {
    if (hash.startsWith('#/train/')) await renderTraining({ db, root, go, toast }, decodeURIComponent(hash.slice(8)));
    else if (hash === '#/' || hash === '#') await renderList();
    else if (hash === '#/new') await renderEditor(null);
    else if (hash.startsWith('#/edit/')) await renderEditor(decodeURIComponent(hash.slice(7)));
    else go('#/');
    window.scrollTo(0, 0);
  } catch (e) {
    clear(root);
    root.append(h('div', { class: 'summary', role: 'alert' }, 'Error: ' + e.message));
  }
}

async function boot() {
  try {
    await db.open();
    const data = await (await fetch('data/exercises.json')).json();
    await db.seedExercises(data.exercises);              // idempotente
    exercises = (await db.listExercises()).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    exMap = new Map(exercises.map((e) => [e.id, e]));
  } catch (e) {
    clear(root);
    root.append(h('div', { class: 'summary', role: 'alert' },
      'No se pudo abrir el almacenamiento del dispositivo: ' + e.message + '. Prueba a abrir la app desde el icono de la pantalla de inicio.'));
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}
window.fcApp = { get db() { return db; } };            // solo para depurar en escritorio
boot();
