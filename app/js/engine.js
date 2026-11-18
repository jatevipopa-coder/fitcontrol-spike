// Motor de temporizador (versión ES module del probado en el spike). Sin DOM. Reloj inyectable.
// La verdad del tiempo es un deadline calculado con un reloj monotónico, no un contador.
export class Engine {
  constructor(phases, now, onEvent) {
    this.phases = phases;               // [{name, ms}]
    this.now = now;                     // () => ms monotónicos
    this.onEvent = onEvent || (() => {});
    this.state = 'idle';                // idle | running | paused | done
    this.index = 0;
    this.deadline = 0;
    this.remainingOnPause = 0;
  }
  start() {
    if (this.state !== 'idle' && this.state !== 'done') return;
    this.index = 0;
    this.deadline = this.now() + this.phases[0].ms;
    this.state = 'running';
    this.onEvent({ type: 'start', phase: this.phases[0].name });
  }
  pause() {
    if (this.state !== 'running') return;
    this.tick();
    if (this.state !== 'running') return;
    this.remainingOnPause = Math.max(0, this.deadline - this.now());
    this.state = 'paused';
    this.onEvent({ type: 'pause', remainingMs: this.remainingOnPause });
  }
  resume() {
    if (this.state !== 'paused') return;
    this.deadline = this.now() + this.remainingOnPause;
    this.state = 'running';
    this.onEvent({ type: 'resume', remainingMs: this.remainingOnPause });
  }
  reset() { this.state = 'idle'; this.index = 0; this.onEvent({ type: 'reset' }); }

  // Reconcilia fases vencidas sin emitir ráfagas: un solo evento aunque haya pasado más de una fase.
  tick() {
    if (this.state !== 'running') return;
    const t = this.now();
    if (t < this.deadline) return;
    let skipped = 0; let drift = 0;
    while (this.state === 'running' && t >= this.deadline) {
      drift = t - this.deadline;
      const finished = this.phases[this.index];
      if (this.index + 1 >= this.phases.length) {
        this.state = 'done';
        this.onEvent({ type: 'done', phase: finished.name, driftMs: drift, skipped });
        return;
      }
      this.index += 1;
      this.deadline += this.phases[this.index].ms;
      if (t >= this.deadline) skipped += 1;
    }
    this.onEvent({ type: 'phase-end', phase: this.phases[this.index].name, driftMs: drift, skipped });
  }
  remainingMs() {
    if (this.state === 'running') return Math.max(0, this.deadline - this.now());
    if (this.state === 'paused') return this.remainingOnPause;
    return 0;
  }
  /** Milisegundos transcurridos de la fase actual (para registrar cuánto aguantó un ejercicio por tiempo). */
  elapsedMs() { return Math.max(0, this.phases[this.index].ms - this.remainingMs()); }
}
