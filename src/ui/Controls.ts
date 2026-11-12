import { KEYS } from '../config';

type Handler = (code: string) => void;

export class Controls {
  down = new Set<string>();
  private handlers: Handler[] = [];
  enabled = true;

  constructor() {
    const block = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
    window.addEventListener('keydown', (e) => {
      if (block.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      if (this.enabled) this.handlers.forEach((h) => h(e.code));
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  onPress(h: Handler) { this.handlers.push(h); }

  held(codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  get steer() { return Number(this.held(KEYS.left)) - Number(this.held(KEYS.right)); }

  get accel() { return this.held(KEYS.accel); }
  get brake() { return this.held(KEYS.brake); }
  get ebrake() { return this.held(KEYS.ebrake); }

  /** programmatic key (used by automated tests) */
  press(code: string, hold = false) {
    this.down.add(code);
    if (this.enabled) this.handlers.forEach((h) => h(code));
    if (!hold) this.down.delete(code);
  }
  release(code: string) { this.down.delete(code); }
}
