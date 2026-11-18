// Lógica pura del entreno (sin DOM ni IndexedDB): del snapshot de la rutina salen los "pasos" (una serie = un paso).
// Regla clave: el paso actual es steps[numero_de_series_registradas]. Cada paso genera EXACTAMENTE un registro
// (hecha u omitida), así que el progreso se reconstruye siempre desde lo guardado, también tras cerrar la app.
export const CUE_LEN_SEC = 300;          // segundo de cue-rest.wav donde suena el doble beep

export function buildPlan(snapshot) {
  const steps = [];
  snapshot.items.forEach((it, itemIndex) => {
    for (let s = 1; s <= it.sets; s++) {
      steps.push({
        itemIndex, itemCount: snapshot.items.length,
        exerciseId: it.exerciseId, exerciseName: it.exerciseName, modality: it.modality,
        setNumber: s, totalSets: it.sets,
        targetReps: it.reps ?? null, targetDurationSec: it.durationSec ?? null,
        targetLoadKg: it.targetLoadKg ?? null, restSec: it.restSec,
      });
    }
  });
  return steps.map((st, index) => ({ ...st, index, isLast: index === steps.length - 1 }));
}

export const isFinished = (steps, entryCount) => entryCount >= steps.length;
/** Tras la última serie no hay descanso. */
export const restAfter = (step) => (step.isLast ? 0 : step.restSec);

/** Valores iniciales de los campos: el último peso usado (de cualquier sesión) manda sobre el objetivo. */
export function suggestFor(step, lastEntry) {
  const hist = lastEntry?.actualLoadKg;
  return {
    reps: step.targetReps,
    durationSec: step.targetDurationSec,
    loadKg: hist ?? step.targetLoadKg ?? null,
    fromHistory: hist != null,
  };
}

/** Desde qué segundo de la pista hay que reproducir para que el beep caiga a los `seconds`. null = no soportado. */
export function cueOffset(seconds) {
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= CUE_LEN_SEC ? CUE_LEN_SEC - seconds : null;
}

export function summarize(session, entries, steps, nowMs = Date.now()) {
  const done = entries.filter((e) => e.completed);
  const volume = done.reduce((a, e) => a + (e.actualReps ?? 0) * (e.actualLoadKg ?? 0), 0);
  const start = Date.parse(session.startedAt);
  const end = session.endedAt ? Date.parse(session.endedAt) : nowMs;
  return {
    planned: steps.length,
    completed: done.length,
    skipped: entries.length - done.length,
    pending: Math.max(0, steps.length - entries.length),
    volumeKg: Math.round(volume * 100) / 100,
    wallSeconds: Math.max(0, Math.round((end - start) / 1000)),   // incluye pausas y descansos
  };
}

export function fmtClock(totalSec) {
  const s = Math.max(0, Math.ceil(totalSec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export function fmtLoad(kg) { return kg == null ? '' : String(kg).replace('.', ','); }
