// Máquina de estados de la sesión (Plan Maestro §8.4). Pura: no toca IndexedDB.
import { ConflictError } from './errors.js';

export const TERMINAL = ['completed', 'abandoned', 'cancelled'];
const NEXT = {
  ready: ['running', 'cancelled'],
  running: ['paused', 'completed', 'abandoned', 'cancelled'],
  paused: ['running', 'completed', 'abandoned', 'cancelled'],
  completed: [], abandoned: [], cancelled: [],
};

export function canTransition(from, to) { return (NEXT[from] ?? []).includes(to); }

/** Devuelve una copia con el nuevo estado; lanza ConflictError si no es válido.
 *  cancelled = descartar un inicio sin contenido útil; con series registradas se usa abandoned. */
export function transition(session, to, { now, entryCount = 0 } = {}) {
  const from = session.status;
  if (!canTransition(from, to)) throw new ConflictError('transición no permitida: ' + from + ' -> ' + to);
  if (to === 'cancelled' && entryCount > 0) {
    throw new ConflictError('la sesión tiene series registradas: usa "abandonar" en lugar de "cancelar"');
  }
  return { ...session, status: to, endedAt: TERMINAL.includes(to) ? now : null };
}
