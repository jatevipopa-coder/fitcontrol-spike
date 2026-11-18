// Pruebas que corren DENTRO de la página (botón "Ejecutar pruebas"), igual en el panel y en el iPhone.
// Cada prueba de BD usa una base desechable y la borra al terminar: nunca toca los datos reales.
import { FitDb, uuid } from '../js/db.js';
import { validateTemplate, validateEntry } from '../js/validate.js';
import { canTransition, transition } from '../js/session-state.js';
import { buildPlan, isFinished, restAfter, suggestFor, cueOffset, summarize, fmtClock, fmtLoad } from '../js/runner.js';
import { Engine } from '../js/engine.js';
import { newDraft, draftFromTemplate, defaultItem, toNum, moveItem, removeItem, draftToInput, describeError } from '../js/draft.js';

const EX = [
  { id: 'ex-a', name: 'Ejercicio A', modality: 'reps' },
  { id: 'ex-b', name: 'Ejercicio B', modality: 'time' },
  { id: 'ex-c', name: 'Ejercicio C', modality: 'reps' },
];
const exMap = new Map(EX.map((e) => [e.id, e]));

const ok = (c, m) => { if (!c) throw new Error(m || 'esperaba verdadero'); };
const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m ? m + ': ' : '') + 'esperado ' + JSON.stringify(b) + ', obtenido ' + JSON.stringify(a));
};
async function rejects(fn, name) {
  try { await fn(); } catch (e) {
    if (e.name !== name) throw new Error('error esperado ' + name + ' pero fue ' + e.name + ': ' + e.message);
    return;
  }
  throw new Error('esperaba el error ' + name + ' y no hubo ninguno');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withDb(fn) {
  const name = 'fc-test-' + uuid();
  const db = new FitDb(name);
  try { await db.seedExercises(EX); await fn(db, name); }
  finally { db.close(); await FitDb.deleteDatabase(name); }
}
const good = () => ({
  name: '  Torso   A ', goal: '',
  items: [
    { exerciseId: 'ex-a', sets: 3, reps: 8, restSec: 90 },
    { exerciseId: 'ex-b', sets: 2, durationSec: 45, restSec: 60 },
  ],
});
const fieldsOf = (v) => v.errors.map((e) => e.field);

export const TESTS = [
  // ---------- validación (pura) ----------
  ['plantilla válida: normaliza espacios del nombre', () => {
    const v = validateTemplate(good(), exMap);
    ok(v.ok); eq(v.value.name, 'Torso A');
  }],
  ['nombre demasiado corto o de 101 caracteres se rechaza', () => {
    for (const name of ['ab', 'x'.repeat(101), '   ']) {
      const v = validateTemplate({ ...good(), name }, exMap);
      ok(!v.ok && fieldsOf(v).includes('name'), 'nombre ' + JSON.stringify(name.slice(0, 5)));
    }
    ok(validateTemplate({ ...good(), name: 'x'.repeat(100) }, exMap).ok);
  }],
  ['series: 0, 51, NaN, Infinity, texto y decimales se rechazan', () => {
    for (const sets of [0, 51, NaN, Infinity, '3', 2.5, -1]) {
      const t = good(); t.items[0].sets = sets;
      ok(!validateTemplate(t, exMap).ok, 'sets=' + String(sets));
    }
  }],
  ['ejercicio por tiempo exige duración; por repeticiones exige reps', () => {
    const a = good(); delete a.items[1].durationSec;
    ok(fieldsOf(validateTemplate(a, exMap)).includes('items[1].durationSec'));
    const b = good(); delete b.items[0].reps;
    ok(fieldsOf(validateTemplate(b, exMap)).includes('items[0].reps'));
  }],
  ['ejercicio inexistente, sin ejercicios y más de 100 se rechazan', () => {
    const a = good(); a.items[0].exerciseId = 'no-existe';
    ok(fieldsOf(validateTemplate(a, exMap)).includes('items[0].exerciseId'));
    ok(fieldsOf(validateTemplate({ ...good(), items: [] }, exMap)).includes('items'));
    const many = Array.from({ length: 101 }, () => ({ exerciseId: 'ex-a', sets: 1, reps: 1, restSec: 0 }));
    ok(!validateTemplate({ ...good(), items: many }, exMap).ok);
    const hundred = Array.from({ length: 100 }, () => ({ exerciseId: 'ex-a', sets: 1, reps: 1, restSec: 0 }));
    ok(validateTemplate({ ...good(), items: hundred }, exMap).ok);
  }],
  ['descanso 0 es válido; carga se redondea a 2 decimales; negativa se rechaza', () => {
    const t = good(); t.items[0].restSec = 0; t.items[0].targetLoadKg = 42.504;
    const v = validateTemplate(t, exMap);
    ok(v.ok); eq(v.value.items[0].targetLoadKg, 42.5);
    const n = good(); n.items[0].targetLoadKg = -1;
    ok(!validateTemplate(n, exMap).ok);
  }],
  ['serie: completada exige repeticiones; omitida no; RPE fuera de rango se rechaza', () => {
    const ex = { id: 'ex-a', modality: 'reps' };
    ok(!validateEntry({ setNumber: 1, completed: true }, ex).ok);
    ok(validateEntry({ setNumber: 1, completed: false }, ex).ok);
    ok(validateEntry({ setNumber: 1, completed: true, actualReps: 8, actualLoadKg: 60 }, ex).ok);
    ok(!validateEntry({ setNumber: 1, completed: true, actualReps: 8, rpe: 11 }, ex).ok);
    ok(!validateEntry({ setNumber: 1, completed: true, actualReps: NaN }, ex).ok);
    ok(!validateEntry({ setNumber: 1, completed: 'si', actualReps: 8 }, ex).ok);
    ok(!validateEntry({ setNumber: 1, completed: true, actualDurationMs: 5000 }, { id: 'ex-b', modality: 'time' }).ok === false);
    ok(!validateEntry({ setNumber: 1, completed: true }, { id: 'ex-b', modality: 'time' }).ok);
  }],
  ['transiciones de sesión', () => {
    const s = { status: 'running', endedAt: null };
    ok(canTransition('running', 'paused') && canTransition('paused', 'running'));
    ok(!canTransition('completed', 'running') && !canTransition('abandoned', 'running') && !canTransition('cancelled', 'running'));
    let threw = false;
    try { transition({ status: 'completed' }, 'running', { now: 'x' }); } catch (e) { threw = e.name === 'ConflictError'; }
    ok(threw, 'completed -> running debía fallar');
    threw = false;
    try { transition(s, 'cancelled', { now: 'x', entryCount: 2 }); } catch (e) { threw = e.name === 'ConflictError'; }
    ok(threw, 'cancelar con series debía fallar');
    const end = transition(s, 'abandoned', { now: '2026-01-01T00:00:00.000Z', entryCount: 2 });
    eq(end.status, 'abandoned'); eq(end.endedAt, '2026-01-01T00:00:00.000Z');
  }],
  ['catálogo real (exercises.json): 16 ejercicios, ids y slugs únicos, campos completos', async () => {
    const data = await (await fetch(new URL('../data/exercises.json', import.meta.url))).json();
    const list = data.exercises;
    eq(list.length, 16);
    eq(new Set(list.map((e) => e.id)).size, 16, 'ids únicos');
    eq(new Set(list.map((e) => e.slug)).size, 16, 'slugs únicos');
    for (const e of list) {
      ok(['reps', 'time'].includes(e.modality), e.id + ' modalidad');
      ok(e.name && e.muscleGroup && e.equipment, e.id + ' campos');
      ok(e.description && e.description.length > 20, e.id + ' descripción');
    }
    ok(data.reviewNote, 'nota de revisión editorial');
  }],

  // ---------- editor (lógica pura) ----------
  ['editor: toNum interpreta coma decimal, vacío y basura', () => {
    eq(toNum('62,5'), 62.5); eq(toNum(' 8 '), 8); eq(toNum(''), undefined); eq(toNum(null), undefined);
    ok(Number.isNaN(toNum('abc')) && Number.isNaN(toNum('1e3')) && Number.isNaN(toNum('1,2,3')) && Number.isNaN(toNum('0x10')));
  }],
  ['editor: valores por defecto según modalidad', () => {
    eq(defaultItem({ id: 'ex-a', modality: 'reps' }), { exerciseId: 'ex-a', sets: 3, reps: 8, restSec: 90 });
    eq(defaultItem({ id: 'ex-b', modality: 'time' }), { exerciseId: 'ex-b', sets: 3, durationSec: 45, restSec: 60 });
  }],
  ['editor: mover y quitar no mutan y respetan los bordes', () => {
    const a = [{ n: 1 }, { n: 2 }, { n: 3 }];
    eq(moveItem(a, 0, 1).map((x) => x.n), [2, 1, 3]);
    eq(moveItem(a, 0, -1).map((x) => x.n), [1, 2, 3]);
    eq(moveItem(a, 2, 1).map((x) => x.n), [1, 2, 3]);
    eq(a.map((x) => x.n), [1, 2, 3], 'el original no cambia');
    eq(removeItem(a, 1).map((x) => x.n), [1, 3]);
  }],
  ['editor: el borrador válido pasa la validación; un campo ilegible no', () => {
    const d = newDraft(); d.name = 'Pierna';
    d.items = [defaultItem(exMap.get('ex-a')), defaultItem(exMap.get('ex-b'))];
    ok(validateTemplate(draftToInput(d), exMap).ok);
    d.items[0].sets = toNum('abc');
    const v = validateTemplate(draftToInput(d), exMap);
    ok(!v.ok && v.errors[0].field === 'items[0].sets');
    d.items[0].sets = toNum('3'); d.items[0].reps = toNum('');   // reps vacío en ejercicio por repeticiones
    ok(!validateTemplate(draftToInput(d), exMap).ok);
  }],
  ['editor: mensajes de error legibles', () => {
    const items = [{ exerciseId: 'ex-a' }];
    const nm = (id) => exMap.get(id)?.name;
    eq(describeError({ field: 'items[0].sets', message: 'x' }, items, nm), 'Ejercicio 1 (Ejercicio A) · Series: x');
    eq(describeError({ field: 'name', message: 'y' }, items, nm), 'Nombre: y');
  }],
  ['editor: draftFromTemplate copia, no comparte referencias', () => {
    const t = { id: 'i', name: 'N', goal: undefined, items: [{ exerciseId: 'ex-a', sets: 1, reps: 1, restSec: 0 }] };
    const d = draftFromTemplate(t); d.items[0].sets = 9;
    eq(t.items[0].sets, 1); eq(d.goal, '');
  }],

  // ---------- entreno (lógica pura) ----------
  ['entreno: buildPlan expande series en orden y marca la última', () => {
    const snap = { items: [
      { exerciseId: 'ex-a', exerciseName: 'A', modality: 'reps', sets: 2, reps: 8, restSec: 90, targetLoadKg: 60 },
      { exerciseId: 'ex-b', exerciseName: 'B', modality: 'time', sets: 1, durationSec: 45, restSec: 60 },
    ] };
    const steps = buildPlan(snap);
    eq(steps.map((s) => s.exerciseId + '#' + s.setNumber), ['ex-a#1', 'ex-a#2', 'ex-b#1']);
    eq(steps.map((s) => s.isLast), [false, false, true]);
    eq(steps[0].totalSets, 2); eq(steps[2].itemCount, 2); eq(steps[2].targetDurationSec, 45); eq(steps[0].targetLoadKg, 60);
    eq(restAfter(steps[1]), 90); eq(restAfter(steps[2]), 0, 'sin descanso tras la última serie');
    ok(!isFinished(steps, 2) && isFinished(steps, 3));
  }],
  ['entreno: el mismo ejercicio repetido en la rutina genera pasos distintos', () => {
    const it = { exerciseId: 'ex-a', exerciseName: 'A', modality: 'reps', sets: 2, reps: 5, restSec: 30 };
    const steps = buildPlan({ items: [it, it] });
    eq(steps.length, 4); eq(steps.map((s) => s.itemIndex), [0, 0, 1, 1]);
  }],
  ['entreno: el último peso manda sobre el objetivo; sin historial usa el objetivo', () => {
    const step = { targetReps: 8, targetLoadKg: 60, targetDurationSec: null };
    eq(suggestFor(step, { actualLoadKg: 62.5 }).loadKg, 62.5);
    eq(suggestFor(step, null).loadKg, 60); eq(suggestFor(step, null).fromHistory, false);
    eq(suggestFor({ targetReps: 8, targetLoadKg: null }, { actualLoadKg: null }).loadKg, null);
  }],
  ['entreno: posición de la pista según el descanso (salto a 300−D)', () => {
    eq(cueOffset(15), 285); eq(cueOffset(120), 180); eq(cueOffset(300), 0);
    eq(cueOffset(0), null); eq(cueOffset(301), null); eq(cueOffset(NaN), null); eq(cueOffset(2.5), null);
  }],
  ['entreno: resumen cuenta hechas, omitidas, pendientes y volumen solo con peso', () => {
    const steps = new Array(6).fill(0).map((_, i) => ({ index: i }));
    const entries = [
      { completed: true, actualReps: 8, actualLoadKg: 60 },
      { completed: true, actualReps: 6, actualLoadKg: 62.5 },
      { completed: false },
      { completed: true, actualDurationMs: 45000 },            // sin peso: no suma volumen
    ];
    const s = summarize({ startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T10:45:30.000Z' }, entries, steps);
    eq([s.planned, s.completed, s.skipped, s.pending], [6, 3, 1, 2]);
    eq(s.volumeKg, 855, 'volumen'); eq(s.wallSeconds, 2730);
  }],
  ['entreno: formato de reloj y de peso', () => {
    eq(fmtClock(65), '1:05'); eq(fmtClock(0), '0:00'); eq(fmtClock(3600), '60:00'); eq(fmtClock(59.2), '1:00'); eq(fmtClock(-3), '0:00');
    eq(fmtLoad(62.5), '62,5'); eq(fmtLoad(60), '60'); eq(fmtLoad(null), '');
  }],
  ['motor (ES module): pausa conserva el tiempo y se completa una sola vez', () => {
    let t = 1000; const ev = [];
    const e = new Engine([{ name: 'D', ms: 10000 }], () => t, (x) => ev.push(x.type));
    e.start(); t += 4000; e.pause(); t += 30000;
    eq(e.remainingMs(), 6000); e.resume(); t += 5999; e.tick(); eq(e.state, 'running');
    t += 1; e.tick(); eq(e.state, 'done'); eq(ev.filter((x) => x === 'done').length, 1);
    e.tick(); eq(ev.filter((x) => x === 'done').length, 1, 'no repite el evento');
  }],
  ['motor: elapsedMs refleja lo transcurrido (para "terminar ya")', () => {
    let t = 0; const e = new Engine([{ name: 'P', ms: 45000 }], () => t);
    e.start(); t += 12300; eq(e.elapsedMs(), 12300);
  }],

  // ---------- base de datos ----------
  ['siembra idempotente: sembrar dos veces no duplica', () => withDb(async (db) => {
    await db.seedExercises(EX); await db.seedExercises(EX);
    eq((await db.listExercises()).length, 3);
  })],
  ['crear rutina inválida no guarda nada', () => withDb(async (db) => {
    await rejects(() => db.createTemplate({ name: 'x', items: [] }), 'ValidationError');
    eq((await db.listTemplates()).length, 0);
  })],
  ['crear, leer y listar rutina', () => withDb(async (db) => {
    const t = await db.createTemplate(good());
    eq(t.version, 1); eq(t.name, 'Torso A'); ok(t.id && t.createdAt.endsWith('Z'));
    eq((await db.getTemplate(t.id)).items.length, 2);
    eq((await db.listTemplates()).length, 1);
  })],
  ['editar sube la versión y conserva createdAt', () => withDb(async (db) => {
    const t = await db.createTemplate(good());
    await sleep(5);
    const u = await db.updateTemplate(t.id, { ...good(), name: 'Torso B' });
    eq(u.version, 2); eq(u.name, 'Torso B'); eq(u.createdAt, t.createdAt);
    ok(u.updatedAt > t.updatedAt);
  })],
  ['duplicar: copia independiente; nombre de 100 caracteres sigue ≤ 100', () => withDb(async (db) => {
    const t = await db.createTemplate({ ...good(), name: 'N'.repeat(100) });
    const c = await db.duplicateTemplate(t.id);
    ok(c.id !== t.id && c.name.endsWith('(copia)') && c.name.length <= 100 && c.version === 1);
    await db.updateTemplate(c.id, { ...good(), name: 'Otra' });
    eq((await db.getTemplate(t.id)).name, 'N'.repeat(100), 'el original no cambia');
  })],
  ['archivar: sale de la lista pero sigue existiendo; no se puede editar ni iniciar', () => withDb(async (db) => {
    const t = await db.createTemplate(good());
    await db.archiveTemplate(t.id);
    eq((await db.listTemplates()).length, 0);
    eq((await db.listTemplates({ includeArchived: true })).length, 1);
    await rejects(() => db.updateTemplate(t.id, good()), 'ConflictError');
    await rejects(() => db.startSession(t.id), 'ConflictError');
  })],
  ['borrar: sin sesiones se puede; con sesiones se bloquea', () => withDb(async (db) => {
    const a = await db.createTemplate(good());
    await db.deleteTemplate(a.id);
    eq((await db.listTemplates()).length, 0);
    const b = await db.createTemplate(good());
    const s = await db.startSession(b.id);
    await db.setSessionState(s.id, 'abandoned');
    await rejects(() => db.deleteTemplate(b.id), 'ConflictError');
    eq((await db.listTemplates()).length, 1);
  })],
  ['snapshot: editar la rutina NO cambia la sesión ya iniciada', () => withDb(async (db) => {
    const t = await db.createTemplate(good());
    const s = await db.startSession(t.id);
    await db.updateTemplate(t.id, { name: 'Cambiada', items: [{ exerciseId: 'ex-c', sets: 5, reps: 5, restSec: 120 }] });
    const got = await db.getSession(s.id);
    eq(got.templateSnapshot.name, 'Torso A'); eq(got.templateSnapshot.version, 1);
    eq(got.templateSnapshot.items.length, 2); eq(got.templateSnapshot.items[0].exerciseName, 'Ejercicio A');
    eq((await db.getTemplate(t.id)).version, 2);
  })],
  ['solo una sesión activa a la vez; el deviceId es estable', () => withDb(async (db) => {
    const t = await db.createTemplate(good());
    const s1 = await db.startSession(t.id);
    await rejects(() => db.startSession(t.id), 'ConflictError');
    await db.setSessionState(s1.id, 'completed');
    const s2 = await db.startSession(t.id);
    eq(s2.deviceId, s1.deviceId);
  })],
  ['series: secuencia 1..n y doble envío con el mismo id no duplica', () => withDb(async (db) => {
    const t = await db.createTemplate(good());
    const s = await db.startSession(t.id);
    const id = uuid();
    const e1 = await db.addEntry(s.id, { id, exerciseId: 'ex-a', setNumber: 1, completed: true, actualReps: 8, actualLoadKg: 60 });
    const e1b = await db.addEntry(s.id, { id, exerciseId: 'ex-a', setNumber: 1, completed: true, actualReps: 8, actualLoadKg: 60 });
    eq(e1b.id, e1.id);
    const e2 = await db.addEntry(s.id, { exerciseId: 'ex-a', setNumber: 2, completed: true, actualReps: 7, actualLoadKg: 60 });
    eq([e1.sequence, e2.sequence], [1, 2]);
    eq((await db.getSession(s.id)).entries.length, 2);
  })],
  ['serie de un ejercicio fuera del plan o inválida se rechaza', () => withDb(async (db) => {
    const t = await db.createTemplate(good());
    const s = await db.startSession(t.id);
    await rejects(() => db.addEntry(s.id, { exerciseId: 'ex-c', setNumber: 1, completed: true, actualReps: 5 }), 'ValidationError');
    await rejects(() => db.addEntry(s.id, { exerciseId: 'ex-a', setNumber: 1, completed: true }), 'ValidationError');
    eq((await db.getSession(s.id)).entries.length, 0);
  })],
  ['sesión terminada: no admite series y no vuelve a running', () => withDb(async (db) => {
    const t = await db.createTemplate(good());
    const s = await db.startSession(t.id);
    const end = await db.setSessionState(s.id, 'completed', { elapsedActiveMs: 61234.4 });
    eq(end.status, 'completed'); eq(end.elapsedActiveMs, 61234); ok(end.endedAt);
    await rejects(() => db.addEntry(s.id, { exerciseId: 'ex-a', setNumber: 1, completed: true, actualReps: 5 }), 'ConflictError');
    await rejects(() => db.setSessionState(s.id, 'running'), 'ConflictError');
  })],
  ['cancelar con series se rechaza (abandonar sí); pausar y reanudar', () => withDb(async (db) => {
    const t = await db.createTemplate(good());
    const s = await db.startSession(t.id);
    await db.setSessionState(s.id, 'paused'); await db.setSessionState(s.id, 'running');
    await db.addEntry(s.id, { exerciseId: 'ex-a', setNumber: 1, completed: true, actualReps: 8 });
    await rejects(() => db.setSessionState(s.id, 'cancelled'), 'ConflictError');
    eq((await db.setSessionState(s.id, 'abandoned')).status, 'abandoned');
    const s2 = await db.startSession(t.id);
    eq((await db.setSessionState(s2.id, 'cancelled')).status, 'cancelled');
  })],
  ['último peso: devuelve la última serie completada e ignora las omitidas', () => withDb(async (db) => {
    const t = await db.createTemplate(good());
    const s = await db.startSession(t.id);
    await db.addEntry(s.id, { exerciseId: 'ex-a', setNumber: 1, completed: true, actualReps: 8, actualLoadKg: 60 });
    await sleep(5);
    await db.addEntry(s.id, { exerciseId: 'ex-a', setNumber: 2, completed: true, actualReps: 6, actualLoadKg: 62.5 });
    await sleep(5);
    await db.addEntry(s.id, { exerciseId: 'ex-a', setNumber: 3, completed: false, actualLoadKg: 100 });
    const last = await db.lastEntryForExercise('ex-a');
    eq(last.actualLoadKg, 62.5); eq(last.setNumber, 2);
    eq(await db.lastEntryForExercise('ex-c'), null);
  })],
  ['entreno completo contra la BD: un registro por paso, progreso = nº de registros, resumen coherente', () => withDb(async (db) => {
    const t = await db.createTemplate({ name: 'Prueba', items: [
      { exerciseId: 'ex-a', sets: 3, reps: 8, restSec: 90, targetLoadKg: 60 },
      { exerciseId: 'ex-b', sets: 1, durationSec: 45, restSec: 60 },
    ] });
    const s = await db.startSession(t.id);
    const steps = buildPlan(s.templateSnapshot);
    eq(steps.length, 4);
    const log = [];
    for (let i = 0; i < steps.length; i++) {
      const cur = steps[(await db.getSession(s.id)).entries.length];
      eq(cur.index, i, 'el paso actual coincide con el nº de registros');
      const input = { id: uuid(), exerciseId: cur.exerciseId, setNumber: cur.setNumber };
      if (i === 1) Object.assign(input, { completed: false });                                  // omitida
      else if (cur.modality === 'time') Object.assign(input, { completed: true, actualDurationMs: 45000 });
      else Object.assign(input, { completed: true, actualReps: 8, actualLoadKg: 60 + i });
      log.push(await db.addEntry(s.id, input));
      await sleep(3);
    }
    eq(isFinished(steps, (await db.getSession(s.id)).entries.length), true);
    const done = await db.setSessionState(s.id, 'completed');
    const full = await db.getSession(s.id);
    eq(full.entries.map((e) => e.sequence), [1, 2, 3, 4]);
    const sum = summarize(done, full.entries, steps);
    eq([sum.completed, sum.skipped, sum.pending], [3, 1, 0]);
    eq(sum.volumeKg, 8 * 60 + 8 * 62, 'volumen: solo series con peso');
    eq((await db.lastEntryForExercise('ex-a')).actualLoadKg, 62, 'último peso = el de la última serie hecha');
  })],
  ['reabrir un entreno a medias: el progreso se reconstruye desde lo guardado', () => withDb(async (db, name) => {
    const t = await db.createTemplate({ name: 'Prueba', items: [{ exerciseId: 'ex-a', sets: 3, reps: 8, restSec: 90 }] });
    const s = await db.startSession(t.id);
    await db.addEntry(s.id, { exerciseId: 'ex-a', setNumber: 1, completed: true, actualReps: 8 });
    db.close();
    const again = new FitDb(name);
    const act = await again.getActiveSession();
    const got = await again.getSession(act.id);
    const steps = buildPlan(got.templateSnapshot);
    eq(steps[got.entries.length].setNumber, 2, 'continúa en la serie 2');
    again.close();
  })],
  ['persistencia: cerrar y reabrir la base conserva todo', () => withDb(async (db, name) => {
    const t = await db.createTemplate(good());
    const s = await db.startSession(t.id);
    await db.addEntry(s.id, { exerciseId: 'ex-a', setNumber: 1, completed: true, actualReps: 8, actualLoadKg: 60 });
    db.close();
    const again = new FitDb(name);
    eq((await again.getTemplate(t.id)).name, 'Torso A');
    const got = await again.getSession(s.id);
    eq(got.entries.length, 1); eq(got.status, 'running');
    eq((await again.getActiveSession()).id, s.id);
    eq(await again.counts(), { exercises: 3, templates: 1, sessions: 1, entries: 1 });
    again.close();
  })],
];

export async function runAll(log = () => {}) {
  let passed = 0; const failed = [];
  for (const [name, fn] of TESTS) {
    const t0 = performance.now();
    try { await fn(); passed += 1; log('PASS  ' + name + '  (' + Math.round(performance.now() - t0) + ' ms)'); }
    catch (err) { failed.push(name); log('FAIL  ' + name + '\n      -> ' + err.message); }
  }
  log('\nRESULTADO: ' + passed + ' pasaron, ' + failed.length + ' fallaron, de ' + TESTS.length);
  return { passed, failed, total: TESTS.length };
}
