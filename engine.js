// Motor del temporizador (spike, desechable). Sin DOM. Reloj inyectable para poder probarlo.
// La verdad del tiempo es un deadline calculado con un reloj monotónico, no un contador.
(function (root) {
  class Engine {
    constructor(phases, now, onEvent) {
      this.phases = phases;          // [{name, ms}]
      this.now = now;                // () => ms monotónicos
      this.onEvent = onEvent || (() => {});
      this.state = 'idle';           // idle | running | paused | done
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

    // Restaura una sesión guardada SIEMPRE en pausa; el usuario decide cuándo reanudar.
    restore(index, remainingMs) {
      this.index = index;
      this.remainingOnPause = Math.max(0, remainingMs);
      this.state = 'paused';
      this.onEvent({ type: 'restore', phase: this.phases[index].name, remainingMs: this.remainingOnPause });
    }

    reset() {
      this.state = 'idle';
      this.index = 0;
      this.onEvent({ type: 'reset' });
    }

    // Reconcilia fases vencidas. Si pasaron varias (suspensión), no emite ráfaga:
    // emite un solo evento 'phase-end' por la última y un 'skipped' con la cuenta.
    tick() {
      if (this.state !== 'running') return;
      const t = this.now();
      if (t < this.deadline) return;
      let skipped = 0;
      let lastDrift = 0;
      while (this.state === 'running' && t >= this.deadline) {
        lastDrift = t - this.deadline;
        const finished = this.phases[this.index];
        if (this.index + 1 >= this.phases.length) {
          this.state = 'done';
          this.onEvent({ type: 'done', phase: finished.name, driftMs: lastDrift, skipped });
          return;
        }
        this.index += 1;
        this.deadline += this.phases[this.index].ms; // determinista, sin acumular error
        if (t >= this.deadline) skipped += 1;
      }
      this.onEvent({
        type: 'phase-end',
        phase: this.phases[this.index].name,
        driftMs: lastDrift,
        skipped,
      });
    }

    remainingMs() {
      if (this.state === 'running') return Math.max(0, this.deadline - this.now());
      if (this.state === 'paused') return this.remainingOnPause;
      return 0;
    }

    current() { return this.phases[this.index]; }
  }

  function buildPhases(cycles, restSec) {
    const out = [];
    for (let i = 1; i <= cycles; i++) out.push({ name: 'Descanso ' + i, ms: restSec * 1000 });
    return out;
  }

  const api = { Engine, buildPhases };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpikeEngine = api;
})(typeof self !== 'undefined' ? self : this);
