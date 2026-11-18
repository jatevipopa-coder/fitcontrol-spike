// Lógica pura del editor de rutinas (sin DOM): convierte lo que el usuario escribe en datos validables.
export function newDraft() { return { id: null, name: '', goal: '', items: [] }; }

export function draftFromTemplate(t) {
  return { id: t.id, name: t.name, goal: t.goal ?? '', items: t.items.map((i) => ({ ...i })) };
}

/** Valores iniciales razonables al añadir un ejercicio; el usuario los ajusta. */
export function defaultItem(exercise) {
  return exercise.modality === 'time'
    ? { exerciseId: exercise.id, sets: 3, durationSec: 45, restSec: 60 }
    : { exerciseId: exercise.id, sets: 3, reps: 8, restSec: 90 };
}

/** "62,5" -> 62.5 · "" -> undefined (campo vacío) · "abc" o "1e3" -> NaN (la validación lo rechaza). */
export function toNum(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  if (s === '') return undefined;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

export function moveItem(items, index, delta) {
  const j = index + delta;
  if (j < 0 || j >= items.length) return items;
  const out = items.slice();
  [out[index], out[j]] = [out[j], out[index]];
  return out;
}

export function removeItem(items, index) { return items.filter((_, i) => i !== index); }

/** Lo que se envía a la capa de datos: sin campos vacíos. */
export function draftToInput(d) {
  return {
    name: d.name, goal: d.goal,
    items: d.items.map((i) => {
      const o = { exerciseId: i.exerciseId, sets: i.sets, restSec: i.restSec };
      if (i.reps !== undefined) o.reps = i.reps;
      if (i.durationSec !== undefined) o.durationSec = i.durationSec;
      if (i.targetLoadKg !== undefined) o.targetLoadKg = i.targetLoadKg;
      return o;
    }),
  };
}

const FIELD_LABELS = { sets: 'Series', reps: 'Repeticiones', durationSec: 'Duración (s)', restSec: 'Descanso (s)', targetLoadKg: 'Peso objetivo (kg)', exerciseId: 'Ejercicio' };

/** Texto legible para un error de validación: "Ejercicio 2 (Press de banca) · Series: ..." */
export function describeError(err, items, exerciseName) {
  const m = /^items\[(\d+)\]\.(\w+)$/.exec(err.field);
  if (m) {
    const i = Number(m[1]);
    const name = exerciseName(items[i]?.exerciseId) ?? '?';
    return 'Ejercicio ' + (i + 1) + ' (' + name + ') · ' + (FIELD_LABELS[m[2]] ?? m[2]) + ': ' + err.message;
  }
  if (err.field === 'name') return 'Nombre: ' + err.message;
  if (err.field === 'goal') return 'Objetivo: ' + err.message;
  if (err.field === 'items') return 'Ejercicios: ' + err.message;
  return err.field + ': ' + err.message;
}
