// Capa de datos sobre IndexedDB. Una instancia por nombre de BD (las pruebas usan BD desechables).
// Reglas: plantilla ≠ sesión; la sesión guarda un SNAPSHOT inmutable; las series se guardan una a una.
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { LIMITS, validateEntry, validateTemplate } from './validate.js';
import { transition } from './session-state.js';

export const DB_VERSION = 1;
const clone = (o) => JSON.parse(JSON.stringify(o));
const nowIso = () => new Date().toISOString();            // siempre UTC

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new Error('transacción abortada'));
});

export class FitDb {
  constructor(name = 'fitcontrol') { this.name = name; this.db = null; }

  async open() {
    if (this.db) return this;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open(this.name, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('exercises', { keyPath: 'id' });
        db.createObjectStore('templates', { keyPath: 'id' });
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('templateId', 'templateId'); s.createIndex('status', 'status'); s.createIndex('startedAt', 'startedAt');
        const e = db.createObjectStore('entries', { keyPath: 'id' });
        e.createIndex('sessionId', 'sessionId'); e.createIndex('exerciseId', 'exerciseId');
        db.createObjectStore('meta');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('apertura bloqueada por otra pestaña con una versión anterior'));
    });
    this.db.onversionchange = () => { this.db.close(); this.db = null; };
    return this;
  }
  close() { if (this.db) { this.db.close(); this.db = null; } }
  static deleteDatabase(name) {
    return new Promise((res, rej) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = () => res(); r.onerror = () => rej(r.error); r.onblocked = () => res();
    });
  }

  // Ejecuta fn dentro de UNA transacción; si lanza, aborta y no queda nada a medias.
  async _tx(stores, mode, fn) {
    await this.open();
    const tx = this.db.transaction(stores, mode);
    const done = txDone(tx);
    let result;
    try { result = await fn(...stores.map((s) => tx.objectStore(s))); }
    catch (err) { try { tx.abort(); } catch { /* ya terminada */ } await done.catch(() => {}); throw err; }
    await done;
    return result;
  }
  async _exerciseMap(exStore) {
    return new Map((await reqP(exStore.getAll())).map((e) => [e.id, e]));
  }

  // ---------- Ejercicios (catálogo del sistema) ----------
  /** Idempotente: repetir la siembra no duplica ni cambia el número de ejercicios. */
  async seedExercises(list) {
    return this._tx(['exercises', 'meta'], 'readwrite', async (ex, meta) => {
      for (const e of list) await reqP(ex.put({ ...e, status: 'system' }));
      await reqP(meta.put({ at: nowIso(), count: list.length }, 'seed'));
      return list.length;
    });
  }
  async listExercises() { return this._tx(['exercises'], 'readonly', (ex) => reqP(ex.getAll())); }
  async getExercise(id) { return this._tx(['exercises'], 'readonly', (ex) => reqP(ex.get(id))); }

  // ---------- Rutinas (plantillas) ----------
  async createTemplate(input) {
    return this._tx(['exercises', 'templates'], 'readwrite', async (ex, tp) => {
      const v = validateTemplate(input, await this._exerciseMap(ex));
      if (!v.ok) throw new ValidationError(v.errors);
      const t = { id: uuid(), ...v.value, version: 1, createdAt: nowIso(), updatedAt: nowIso(), archivedAt: null };
      await reqP(tp.add(t));
      return t;
    });
  }
  async getTemplate(id) { return this._tx(['templates'], 'readonly', (tp) => reqP(tp.get(id))); }
  async listTemplates({ includeArchived = false } = {}) {
    const all = await this._tx(['templates'], 'readonly', (tp) => reqP(tp.getAll()));
    return all.filter((t) => includeArchived || !t.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  /** Editar sube la versión y NO toca sesiones pasadas (tienen su snapshot). */
  async updateTemplate(id, input) {
    return this._tx(['exercises', 'templates'], 'readwrite', async (ex, tp) => {
      const cur = await reqP(tp.get(id));
      if (!cur) throw new NotFoundError('rutina');
      if (cur.archivedAt) throw new ConflictError('la rutina está archivada');
      const v = validateTemplate(input, await this._exerciseMap(ex));
      if (!v.ok) throw new ValidationError(v.errors);
      const t = { ...cur, ...v.value, version: cur.version + 1, updatedAt: nowIso() };
      await reqP(tp.put(t));
      return t;
    });
  }
  async duplicateTemplate(id) {
    return this._tx(['templates'], 'readwrite', async (tp) => {
      const cur = await reqP(tp.get(id));
      if (!cur) throw new NotFoundError('rutina');
      const suffix = ' (copia)';
      const t = { ...clone(cur), id: uuid(), name: cur.name.slice(0, LIMITS.nameMax - suffix.length) + suffix,
        version: 1, createdAt: nowIso(), updatedAt: nowIso(), archivedAt: null };
      await reqP(tp.add(t));
      return t;
    });
  }
  async archiveTemplate(id) {
    return this._tx(['templates'], 'readwrite', async (tp) => {
      const cur = await reqP(tp.get(id));
      if (!cur) throw new NotFoundError('rutina');
      if (cur.archivedAt) return cur;
      const t = { ...cur, archivedAt: nowIso(), updatedAt: nowIso() };
      await reqP(tp.put(t));
      return t;
    });
  }
  /** Borrado definitivo solo si ninguna sesión la referencia; si no, archivar. */
  async deleteTemplate(id) {
    return this._tx(['templates', 'sessions'], 'readwrite', async (tp, ss) => {
      if (!(await reqP(tp.get(id)))) throw new NotFoundError('rutina');
      if ((await reqP(ss.index('templateId').count(id))) > 0) {
        throw new ConflictError('la rutina tiene sesiones en el historial: archívala en lugar de borrarla');
      }
      await reqP(tp.delete(id));
    });
  }

  // ---------- Sesiones ----------
  async getDeviceId() {
    return this._tx(['meta'], 'readwrite', async (meta) => {
      let id = await reqP(meta.get('deviceId'));
      if (!id) { id = uuid(); await reqP(meta.put(id, 'deviceId')); }
      return id;
    });
  }
  async getActiveSession() {
    const all = await this._tx(['sessions'], 'readonly', (ss) => reqP(ss.getAll()));
    return all.find((s) => s.status === 'running' || s.status === 'paused') ?? null;
  }
  /** Copia el plan tal como está AHORA; editar la rutina después no cambia esta sesión. */
  async startSession(templateId) {
    const deviceId = await this.getDeviceId();
    return this._tx(['templates', 'exercises', 'sessions'], 'readwrite', async (tp, ex, ss) => {
      const t = await reqP(tp.get(templateId));
      if (!t) throw new NotFoundError('rutina');
      if (t.archivedAt) throw new ConflictError('la rutina está archivada');
      const all = await reqP(ss.getAll());
      if (all.some((s) => s.status === 'running' || s.status === 'paused')) {
        throw new ConflictError('ya hay una sesión activa: termínala o abandónala primero');
      }
      const exs = await this._exerciseMap(ex);
      const session = {
        id: uuid(), templateId: t.id, status: 'running', startedAt: nowIso(), endedAt: null,
        elapsedActiveMs: 0, deviceId, schemaVersion: 1,
        templateSnapshot: {
          name: t.name, version: t.version, goal: t.goal,
          items: t.items.map((it) => {
            const e = exs.get(it.exerciseId);
            return { ...clone(it), exerciseName: e?.name ?? '(ejercicio eliminado)', modality: e?.modality ?? 'reps' };
          }),
        },
      };
      await reqP(ss.add(session));
      return session;
    });
  }
  async getSession(id) {
    return this._tx(['sessions', 'entries'], 'readonly', async (ss, en) => {
      const s = await reqP(ss.get(id));
      if (!s) return null;
      const entries = (await reqP(en.index('sessionId').getAll(id))).sort((a, b) => a.sequence - b.sequence);
      return { ...s, entries };
    });
  }
  async listSessions({ limit = 50 } = {}) {
    const all = await this._tx(['sessions'], 'readonly', (ss) => reqP(ss.getAll()));
    return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }
  /** Cada serie se guarda al registrarla (no al final). Con el mismo id es idempotente (doble clic). */
  async addEntry(sessionId, input) {
    return this._tx(['sessions', 'entries'], 'readwrite', async (ss, en) => {
      const s = await reqP(ss.get(sessionId));
      if (!s) throw new NotFoundError('sesión');
      if (s.status !== 'running' && s.status !== 'paused') throw new ConflictError('la sesión ya terminó: no admite más series');
      const snap = s.templateSnapshot.items.find((i) => i.exerciseId === input?.exerciseId);
      const v = validateEntry(input, snap ? { id: snap.exerciseId, modality: snap.modality } : null);
      if (!v.ok) throw new ValidationError(v.errors);
      const id = input.id ?? uuid();
      const prev = await reqP(en.get(id));
      if (prev) return prev;
      const n = await reqP(en.index('sessionId').count(sessionId));
      const entry = { id, sessionId, sequence: n + 1, exerciseName: snap.exerciseName, ...v.value, createdAt: nowIso() };
      await reqP(en.add(entry));
      return entry;
    });
  }
  async setSessionState(sessionId, to, { elapsedActiveMs } = {}) {
    return this._tx(['sessions', 'entries'], 'readwrite', async (ss, en) => {
      const s = await reqP(ss.get(sessionId));
      if (!s) throw new NotFoundError('sesión');
      const entryCount = await reqP(en.index('sessionId').count(sessionId));
      const next = transition(s, to, { now: nowIso(), entryCount });
      if (Number.isFinite(elapsedActiveMs) && elapsedActiveMs >= 0) next.elapsedActiveMs = Math.round(elapsedActiveMs);
      await reqP(ss.put(next));
      return next;
    });
  }
  /** Última serie COMPLETADA de un ejercicio (para mostrar "último peso"). */
  async lastEntryForExercise(exerciseId) {
    const list = await this._tx(['entries'], 'readonly', (en) => reqP(en.index('exerciseId').getAll(exerciseId)));
    return list.filter((e) => e.completed).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  async counts() {
    return this._tx(['exercises', 'templates', 'sessions', 'entries'], 'readonly', async (...st) => {
      const n = await Promise.all(st.map((s) => reqP(s.count())));
      return { exercises: n[0], templates: n[1], sessions: n[2], entries: n[3] };
    });
  }
}
