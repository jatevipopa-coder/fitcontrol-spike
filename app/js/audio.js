// Aviso sonoro con UNA pista (probada en iPhone con pantalla bloqueada): silencio y doble beep a los 300 s.
// Para un descanso de D segundos se reproduce desde 300−D y el beep cae justo al terminar.
import { cueOffset } from './runner.js';

export class RestCue {
  constructor(src = 'cue-rest.wav') {
    this.src = src;
    this.el = new Audio();
    this.el.preload = 'auto';
    this.offset = 0;
    this.active = false;
  }
  /** Llamar DENTRO del toque del usuario y ANTES de cualquier await (Safari bloquea el audio si no). */
  start(seconds) {
    const off = cueOffset(seconds);
    if (off === null) { this.active = false; return Promise.resolve(false); }
    this.offset = off; this.active = true;
    const el = this.el;
    if (el.readyState >= 1 && el.src.endsWith(this.src)) el.currentTime = off;
    else {
      el.src = this.src;
      el.addEventListener('loadedmetadata', () => { el.currentTime = this.offset; }, { once: true });
    }
    return el.play().then(() => true).catch(() => { this.active = false; return false; });
  }
  pause() { if (this.active) this.el.pause(); }
  resume() { return this.active ? this.el.play().then(() => true).catch(() => false) : Promise.resolve(false); }
  stop() { this.active = false; try { this.el.pause(); } catch { /* sin audio */ } }
  /** Segundos transcurridos del descanso según el audio (para comparar con el motor). */
  elapsedSec() { return this.el.currentTime - this.offset; }
}
