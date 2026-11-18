// Validación pura (sin IndexedDB ni DOM). Límites del Plan Maestro §8.3, ajustables aquí.
export const LIMITS = Object.freeze({
  nameMin: 3, nameMax: 100, goalMax: 1000, itemsMax: 100,
  sets: [1, 50], reps: [1, 1000], durationSec: [1, 3600], restSec: [0, 3600],
  loadKg: [0, 1000], rpe: [1, 10], durationMs: [1, 3600000],
});

export function normalizeText(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }
// Number.isInteger rechaza NaN, Infinity y textos.
const isInt = (n, [lo, hi]) => Number.isInteger(n) && n >= lo && n <= hi;
const isNum = (n, [lo, hi]) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
const round2 = (n) => Math.round(n * 100) / 100;

/** exercises: Map id -> ejercicio. Devuelve {ok, errors} o {ok, value} ya normalizado. */
export function validateTemplate(input, exercises) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });

  const name = normalizeText(input?.name);
  if (name.length < LIMITS.nameMin || name.length > LIMITS.nameMax) {
    add('name', 'debe tener entre ' + LIMITS.nameMin + ' y ' + LIMITS.nameMax + ' caracteres');
  }
  const goal = normalizeText(input?.goal);
  if (goal.length > LIMITS.goalMax) add('goal', 'máximo ' + LIMITS.goalMax + ' caracteres');

  const raw = Array.isArray(input?.items) ? input.items : null;
  if (!raw || raw.length < 1) add('items', 'debe tener al menos un ejercicio');
  else if (raw.length > LIMITS.itemsMax) add('items', 'máximo ' + LIMITS.itemsMax + ' ejercicios');

  const items = [];
  (raw ?? []).forEach((it, i) => {
    const p = 'items[' + i + ']';
    const ex = exercises.get(it?.exerciseId);
    if (!ex) { add(p + '.exerciseId', 'ejercicio inexistente'); return; }
    const out = { exerciseId: ex.id };
    if (isInt(it.sets, LIMITS.sets)) out.sets = it.sets; else add(p + '.sets', 'entero entre 1 y 50');
    if (ex.modality === 'time') {
      if (isInt(it.durationSec, LIMITS.durationSec)) out.durationSec = it.durationSec;
      else add(p + '.durationSec', 'obligatorio para ejercicios por tiempo: entero entre 1 y 3600 s');
    } else if (isInt(it.reps, LIMITS.reps)) out.reps = it.reps;
    else add(p + '.reps', 'obligatorio para ejercicios por repeticiones: entero entre 1 y 1000');
    if (isInt(it.restSec, LIMITS.restSec)) out.restSec = it.restSec; else add(p + '.restSec', 'entero entre 0 y 3600 s');
    if (it.targetLoadKg !== undefined && it.targetLoadKg !== null) {
      if (isNum(it.targetLoadKg, LIMITS.loadKg)) out.targetLoadKg = round2(it.targetLoadKg);
      else add(p + '.targetLoadKg', 'número entre 0 y 1000 kg');
    }
    items.push(out);
  });
  return errors.length ? { ok: false, errors } : { ok: true, value: { name, goal, items } };
}

/** Registro de una serie ejecutada. Pesos siempre en kg. */
export function validateEntry(input, exercise) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  if (!exercise) return { ok: false, errors: [{ field: 'exerciseId', message: 'ejercicio inexistente' }] };

  if (!isInt(input?.setNumber, LIMITS.sets)) add('setNumber', 'entero entre 1 y 50');
  if (typeof input?.completed !== 'boolean') add('completed', 'debe ser verdadero o falso');
  const done = input?.completed === true;
  const out = {
    exerciseId: exercise.id, setNumber: input?.setNumber, completed: done,
    actualReps: null, actualLoadKg: null, actualDurationMs: null, rpe: null,
  };

  if (input?.actualReps != null) {
    if (isInt(input.actualReps, [done ? 1 : 0, LIMITS.reps[1]])) out.actualReps = input.actualReps;
    else add('actualReps', 'entero entre ' + (done ? 1 : 0) + ' y 1000');
  } else if (done && exercise.modality === 'reps') add('actualReps', 'obligatorio si la serie está completada');

  if (input?.actualDurationMs != null) {
    if (isInt(input.actualDurationMs, [done ? 1 : 0, LIMITS.durationMs[1]])) out.actualDurationMs = input.actualDurationMs;
    else add('actualDurationMs', 'entero entre ' + (done ? 1 : 0) + ' y 3600000');
  } else if (done && exercise.modality === 'time') add('actualDurationMs', 'obligatorio si la serie está completada');

  if (input?.actualLoadKg != null) {
    if (isNum(input.actualLoadKg, LIMITS.loadKg)) out.actualLoadKg = round2(input.actualLoadKg);
    else add('actualLoadKg', 'número entre 0 y 1000 kg');
  }
  if (input?.rpe != null) {
    if (isInt(input.rpe, LIMITS.rpe)) out.rpe = input.rpe; else add('rpe', 'entero entre 1 y 10');
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}
