// Pantalla de entrenar: serie a serie, descanso automático con aviso sonoro, resumen.
// Reglas: cada serie se guarda al instante; el audio arranca en el MISMO toque (antes de cualquier await);
// nada avanza solo hasta que el usuario confirma repeticiones/peso (el temporizador solo controla descansos).
import { h, clear } from './ui.js';
import { Engine } from './engine.js';
import { RestCue } from './audio.js';
import { buildPlan, restAfter, suggestFor, summarize, fmtClock, fmtLoad, isFinished } from './runner.js';
import { validateEntry } from './validate.js';
import { toNum } from './draft.js';
import { uuid } from './db.js';

const cue = new RestCue();
let S = null;            // estado de la pantalla actual
let tickTimer = null;
let wake = null;
let visHandler = null;

const now = () => performance.now();

function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }
async function lockScreen() {
  try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch { wake = null; }
}
function unlockScreen() { if (wake) { wake.release().catch(() => {}); wake = null; } }
function flash() {
  document.body.style.transition = 'background .15s';
  const prev = document.body.style.background;
  document.body.style.background = '#ffd400';
  setTimeout(() => { document.body.style.background = prev; }, 250);
  if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
}

/** Se llama al salir de la pantalla (cambio de ruta). */
export function leave() {
  stopTick(); cue.stop(); unlockScreen();
  if (visHandler) { document.removeEventListener('visibilitychange', visHandler); visHandler = null; }
  S = null;
}

export async function renderTraining(ctx, id) {
  leave();
  const { db, go, toast } = ctx;
  const session = await db.getSession(id);
  if (!session) { toast('Entreno no encontrado'); go('#/'); return; }
  S = { ctx, session, steps: buildPlan(session.templateSnapshot), entries: session.entries, entryId: uuid(), busy: false, engine: null, mode: 'set', prefill: null };
  if (session.status !== 'running' && session.status !== 'paused') { showSummary(); return; }
  visHandler = () => {
    if (document.visibilityState !== 'visible' || !S) return;
    if (S.engine) { S.engine.tick(); paintClock(); }
    lockScreen();
  };
  document.addEventListener('visibilitychange', visHandler);
  lockScreen();
  await showSet();
}

// ------------------------------------------------------------------ pantallas
function header(step) {
  const t = S.session.templateSnapshot;
  return h('div', { class: 'train-head' },
    h('div', { class: 'meta' }, t.name),
    step ? h('div', { class: 'progress', 'data-test': 'progress' },
      'Ejercicio ' + (step.itemIndex + 1) + ' de ' + step.itemCount + ' · Serie ' + step.setNumber + ' de ' + step.totalSets) : null);
}

function endButtons() {
  return h('div', { class: 'row end-row' },
    h('button', { class: 'btn', type: 'button', 'data-act': 'finish', onclick: onFinish }, 'Terminar entreno'),
    h('button', { class: 'btn danger', type: 'button', 'data-act': 'abandon', onclick: onAbandon }, 'Abandonar'));
}

async function showSet() {
  if (!S) return;
  stopTick(); S.engine = null; S.mode = 'set';
  const { ctx, steps, entries } = S;
  if (isFinished(steps, entries.length)) { showAllDone(); return; }
  const step = steps[entries.length];
  const timed = step.modality === 'time';
  const last = await ctx.db.lastEntryForExercise(step.exerciseId);
  if (!S) return;
  const sug = suggestFor(step, last);
  const pre = S.prefill; S.prefill = null;

  const err = h('div', { class: 'summary', role: 'alert', 'data-test': 'set-error' });
  const repsIn = timed ? null : h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', name: 'reps', value: sug.reps ?? '' });
  const loadIn = timed ? null : h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', name: 'load', value: fmtLoad(sug.loadKg) });
  const durIn = timed ? h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', name: 'duration', value: pre?.durationSec ?? sug.durationSec ?? '' }) : null;

  const target = timed ? 'Objetivo: ' + step.targetDurationSec + ' s'
    : 'Objetivo: ' + step.targetReps + ' repeticiones' + (step.targetLoadKg != null ? ' × ' + fmtLoad(step.targetLoadKg) + ' kg' : '');
  const histLine = last?.actualLoadKg != null
    ? 'Última vez: ' + fmtLoad(last.actualLoadKg) + ' kg × ' + (last.actualReps ?? '?') : null;

  const read = () => timed
    ? { actualDurationMs: Math.round((toNum(durIn.value) ?? NaN) * 1000) }
    : { actualReps: toNum(repsIn.value), actualLoadKg: toNum(loadIn.value) };
  const showErr = (errors) => {
    clear(err);
    err.append(h('strong', {}, 'Revisa:'), h('ul', {}, errors.map((e) => h('li', {}, labelFor(e)))));
  };

  const view = h('div', { 'data-test': 'set-screen' },
    header(step),
    h('h2', { class: 'ex-name', 'data-test': 'ex-name' }, step.exerciseName),
    h('p', { class: 'target' }, target),
    histLine ? h('p', { class: 'hint', 'data-test': 'last-weight' }, histLine) : null,
    err,
    timed
      ? h('div', {},
        h('label', { class: 'field' }, h('span', {}, 'Duración hecha (s)'), durIn),
        h('button', { class: 'btn', type: 'button', 'data-act': 'start-hold', onclick: () => startHold(step) }, 'Empezar cuenta atrás de ' + step.targetDurationSec + ' s'))
      : h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', {}, 'Repeticiones'), repsIn),
        h('label', { class: 'field' }, h('span', {}, 'Peso (kg)'), loadIn)),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { class: 'btn primary big', type: 'button', 'data-act': 'complete', onclick: () => complete(step, read, showErr) }, 'Completar serie'),
      h('button', { class: 'btn', type: 'button', 'data-act': 'skip', onclick: () => skip(step) }, 'Omitir serie')),
    endButtons());
  clear(ctx.root); ctx.root.append(view);
  window.scrollTo(0, 0);
}

function labelFor(e) {
  const names = { actualReps: 'Repeticiones', actualLoadKg: 'Peso (kg)', actualDurationMs: 'Duración' };
  return (names[e.field] ?? e.field) + ': ' + e.message;
}

// ------------------------------------------------------------------ registrar series
async function complete(step, read, showErr) {
  if (!S || S.busy) return;                                    // evita el doble toque
  const input = { id: S.entryId, exerciseId: step.exerciseId, setNumber: step.setNumber, completed: true, ...read() };
  const v = validateEntry(input, { id: step.exerciseId, modality: step.modality });
  if (!v.ok) { showErr(v.errors); return; }
  S.busy = true;
  const rest = restAfter(step);
  // IMPORTANTE: el audio y el motor arrancan aquí, dentro del toque y antes del await de la base de datos.
  if (rest > 0) startRest(rest);
  try {
    const entry = await S.ctx.db.addEntry(S.session.id, input);
    S.entries.push(entry); S.entryId = uuid();
  } catch (e) {
    stopTick(); cue.stop(); S.engine = null; S.busy = false;
    await showSet();
    const box = S.ctx.root.querySelector('[data-test=set-error]');
    if (box) box.append('No se pudo guardar la serie: ' + e.message);
    return;
  }
  S.busy = false;
  if (rest === 0) showAllDone();
}

async function skip(step) {
  if (!S || S.busy) return;
  S.busy = true;
  try {
    const entry = await S.ctx.db.addEntry(S.session.id, { id: S.entryId, exerciseId: step.exerciseId, setNumber: step.setNumber, completed: false });
    S.entries.push(entry); S.entryId = uuid();
  } catch (e) { S.ctx.toast('No se pudo omitir: ' + e.message); S.busy = false; return; }
  S.busy = false;
  await showSet();                                              // omitir no abre descanso
}

// ------------------------------------------------------------------ descanso y cuenta atrás
function startRest(seconds) {
  const stepsLeft = S.steps[S.entries.length + 1];              // la serie que viene tras la que se está guardando
  const audioP = cue.start(seconds);                            // dentro del gesto
  runTimer({ kind: 'rest', seconds, title: 'Descanso', next: stepsLeft });
  audioP.then((ok) => { if (!ok && S) noteNoSound(seconds); });
  setMediaSession('Descanso');
}

function startHold(step) {
  if (!S) return;
  const seconds = step.targetDurationSec;
  const audioP = cue.start(seconds);
  runTimer({ kind: 'hold', seconds, title: step.exerciseName, step });
  audioP.then((ok) => { if (!ok && S) noteNoSound(seconds); });
  setMediaSession(step.exerciseName);
}

function noteNoSound(seconds) {
  const box = S?.ctx.root.querySelector('[data-test=timer-note]');
  if (box) box.textContent = seconds > 300
    ? 'Esta duración supera los 5 min: no hay aviso sonoro, solo visual.'
    : 'El navegador bloqueó el sonido: solo habrá aviso visual y vibración.';
}

function setMediaSession(title) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'FitControl' });
    navigator.mediaSession.setActionHandler('pause', () => { if (S?.engine?.state === 'running') togglePause(); });
    navigator.mediaSession.setActionHandler('play', () => { if (S?.engine?.state === 'paused') togglePause(); });
  } catch { /* sin Media Session */ }
}

let clockEl = null; let pauseBtn = null;
function paintClock() {
  if (!S?.engine || !clockEl) return;
  clockEl.textContent = fmtClock(S.engine.remainingMs() / 1000);
}
function togglePause() {
  const e = S?.engine; if (!e) return;
  if (e.state === 'paused') { cue.resume(); e.resume(); } else { e.pause(); cue.pause(); }
  if (pauseBtn) pauseBtn.textContent = e.state === 'paused' ? 'Reanudar' : 'Pausar';
  paintClock();
}

function runTimer({ kind, seconds, title, next, step }) {
  stopTick();
  S.mode = kind;
  S.engine = new Engine([{ name: title, ms: seconds * 1000 }], now, (ev) => {
    if (ev.type === 'done') onTimerDone(kind, seconds);
  });
  S.engine.start();
  clockEl = h('div', { class: 'clock', 'data-test': 'clock', 'aria-live': 'off' }, fmtClock(seconds));
  pauseBtn = h('button', { class: 'btn', type: 'button', 'data-act': 'pause', onclick: togglePause }, 'Pausar');
  const note = h('p', { class: 'hint', 'data-test': 'timer-note' }, '');
  const nextLine = kind === 'rest' && next
    ? h('p', { class: 'target', 'data-test': 'next-up' }, 'Siguiente: ' + next.exerciseName + ' · serie ' + next.setNumber + ' de ' + next.totalSets
      + (next.targetReps != null ? ' · ' + next.targetReps + ' reps' : ' · ' + next.targetDurationSec + ' s'))
    : null;
  const finishHold = kind === 'hold'
    ? h('button', { class: 'btn', type: 'button', 'data-act': 'hold-stop', onclick: () => holdStopEarly(step) }, 'Terminar ya')
    : h('button', { class: 'btn', type: 'button', 'data-act': 'skip-rest', onclick: skipRest }, 'Saltar descanso');
  const view = h('div', { 'data-test': kind + '-screen' },
    header(kind === 'hold' ? step : null),
    h('h2', { class: 'ex-name' }, kind === 'rest' ? 'Descanso' : title),
    clockEl, nextLine, note,
    h('div', { class: 'row', style: 'margin-top:12px' }, pauseBtn, finishHold),
    endButtons());
  clear(S.ctx.root); S.ctx.root.append(view);
  tickTimer = setInterval(() => { if (S?.engine) { S.engine.tick(); paintClock(); } }, 100);
}

function onTimerDone(kind, seconds) {
  flash();
  if (kind === 'hold') { S.prefill = { durationSec: seconds }; }
  showSet();
}
function skipRest() { cue.stop(); stopTick(); S.engine = null; showSet(); }
function holdStopEarly(step) {
  const done = Math.max(1, Math.round(S.engine.elapsedMs() / 1000));
  cue.stop(); stopTick(); S.engine = null; S.prefill = { durationSec: done }; showSet();
}

// ------------------------------------------------------------------ fin del entreno
function showAllDone() {
  stopTick(); cue.stop(); S.engine = null; S.mode = 'done';
  clear(S.ctx.root);
  S.ctx.root.append(h('div', { 'data-test': 'all-done' },
    header(null),
    h('h2', {}, '¡Última serie registrada!'),
    h('p', { class: 'hint' }, 'Registraste todas las series de la rutina.'),
    h('button', { class: 'btn primary big', type: 'button', 'data-act': 'finish-all', onclick: () => finish('completed') }, 'Terminar y ver resumen')));
}

async function finish(status) {
  if (!S || S.busy) return;
  S.busy = true;
  try { S.session = { ...(await S.ctx.db.setSessionState(S.session.id, status)), entries: S.entries }; }
  catch (e) { S.ctx.toast('No se pudo terminar: ' + e.message); S.busy = false; return; }
  S.busy = false;
  stopTick(); cue.stop(); S.engine = null; unlockScreen();
  showSummary();
}

function onFinish() {
  if (!S) return;
  if (S.entries.length === 0) { onAbandon(); return; }
  const pending = S.steps.length - S.entries.length;
  const msg = pending > 0
    ? '¿Terminar el entreno? Se guardan las ' + S.entries.length + ' series registradas y quedarán ' + pending + ' sin hacer.'
    : '¿Terminar el entreno?';
  if (confirm(msg)) finish('completed');
}
async function onAbandon() {
  if (!S) return;
  const hasWork = S.entries.length > 0;
  const msg = hasWork
    ? '¿Abandonar el entreno? Se conservan las series ya registradas.'
    : 'No hay series registradas: se descartará el entreno.';
  if (!confirm(msg)) return;
  const { ctx, session } = S;
  try { await ctx.db.setSessionState(session.id, hasWork ? 'abandoned' : 'cancelled'); }
  catch (e) { ctx.toast('No se pudo abandonar: ' + e.message); return; }
  ctx.toast(hasWork ? 'Entreno abandonado' : 'Entreno descartado');
  ctx.go('#/');
}

function showSummary() {
  const { ctx, session, steps, entries } = S;
  const sum = summarize(session, entries, steps);
  const byEx = [];
  for (const e of entries) {
    let g = byEx.find((x) => x.name === e.exerciseName && x.last === e.sequence - 1);
    if (!g) { g = { name: e.exerciseName, sets: [], last: e.sequence }; byEx.push(g); }
    g.sets.push(e); g.last = e.sequence;
  }
  const line = (e) => !e.completed ? 'omitida'
    : e.actualDurationMs != null ? Math.round(e.actualDurationMs / 1000) + ' s'
      : (e.actualLoadKg != null ? fmtLoad(e.actualLoadKg) + ' kg × ' : '') + (e.actualReps ?? '?');
  const statusText = { completed: 'Entreno terminado', abandoned: 'Entreno abandonado', cancelled: 'Entreno descartado' }[session.status] ?? 'Entreno';
  clear(ctx.root);
  ctx.root.append(h('div', { 'data-test': 'summary-screen' },
    h('h2', {}, statusText),
    h('p', { class: 'meta' }, session.templateSnapshot.name),
    h('div', { class: 'stats' },
      stat('Series hechas', sum.completed + ' de ' + sum.planned, 'stat-completed'),
      stat('Omitidas', String(sum.skipped), 'stat-skipped'),
      stat('Sin hacer', String(sum.pending), 'stat-pending'),
      stat('Volumen', fmtLoad(sum.volumeKg) + ' kg', 'stat-volume'),
      stat('Duración total', fmtClock(sum.wallSeconds), 'stat-time')),
    h('p', { class: 'hint' }, 'La duración incluye descansos y pausas. El volumen suma repeticiones × peso de las series con peso.'),
    byEx.map((g) => h('div', { class: 'card', style: 'margin-bottom:8px' }, h('h3', {}, g.name), h('p', { class: 'meta' }, g.sets.map(line).join(' · ')))),
    h('button', { class: 'btn primary big', type: 'button', 'data-act': 'back', onclick: () => ctx.go('#/') }, 'Volver a mis rutinas')));
  window.scrollTo(0, 0);
}
function stat(label, value, test) {
  return h('div', { class: 'stat', 'data-test': test }, h('div', { class: 'stat-v' }, value), h('div', { class: 'stat-l' }, label));
}
