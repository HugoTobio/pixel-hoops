/**
 * Joystick virtual dinámico: aparece donde pones el dedo dentro de su zona.
 * Devuelve un vector en coordenadas de pantalla (x derecha, y abajo), longitud ≤ 1.
 */
export class VirtualJoystick {
  x = 0;
  y = 0;
  private pointerId: number | null = null;
  private ox = 0;
  private oy = 0;
  private readonly base = document.createElement('div');
  private readonly knob = document.createElement('div');

  constructor(
    target: HTMLElement,
    /** Decide si un toque en (x, y) pertenece a este joystick. */
    private readonly zone: (x: number, y: number) => boolean,
    private readonly radius = 60,
  ) {
    this.base.className = 'stick-base';
    this.knob.className = 'stick-knob';
    this.hide();
    document.body.append(this.base, this.knob);

    target.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
  }

  get active() {
    return this.pointerId !== null;
  }

  private onDown = (e: PointerEvent) => {
    if (this.pointerId !== null || !this.zone(e.clientX, e.clientY)) return;
    this.pointerId = e.pointerId;
    this.ox = e.clientX;
    this.oy = e.clientY;
    this.place(this.base, this.ox, this.oy);
    this.place(this.knob, this.ox, this.oy);
    this.base.style.display = this.knob.style.display = 'block';
    e.preventDefault();
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    let dx = e.clientX - this.ox;
    let dy = e.clientY - this.oy;
    const len = Math.hypot(dx, dy);
    if (len > this.radius) {
      dx = (dx / len) * this.radius;
      dy = (dy / len) * this.radius;
    }
    this.x = dx / this.radius;
    this.y = dy / this.radius;
    this.place(this.knob, this.ox + dx, this.oy + dy);
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.x = this.y = 0;
    this.hide();
  };

  private place(el: HTMLElement, x: number, y: number) {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  private hide() {
    this.base.style.display = this.knob.style.display = 'none';
  }
}
