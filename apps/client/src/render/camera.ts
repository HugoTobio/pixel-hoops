import * as THREE from 'three';

/**
 * Cámara de retransmisión: vista lateral desde la banda (+z) con inclinación fija.
 * Hace zoom out lo justo para que todos los puntos "obligatorios" (jugador y balón)
 * queden dentro de pantalla, y vuelve a acercarse suavemente cuando ya no hace falta.
 */
export interface BroadcastCameraOptions {
  pitchDeg: number;
  /** Fracción útil de la pantalla (deja sitio a marcador y botones). */
  marginX: number;
  marginY: number;
  /** Qué parte de la pista se ve como mínimo (semiancho y semialto en metros). */
  baseHalfWidth: number;
  baseHalfHeight: number;
  maxDistance: number;
}

const DEFAULTS: BroadcastCameraOptions = {
  pitchDeg: 38,
  marginX: 0.8,
  marginY: 0.72,
  baseHalfWidth: 8,
  baseHalfHeight: 5,
  maxDistance: 90,
};

export class BroadcastCamera {
  private readonly opts: BroadcastCameraOptions;
  private readonly dir: THREE.Vector3; // del objetivo hacia la cámara
  private readonly up: THREE.Vector3; // "arriba" de la pantalla en el mundo
  private readonly target = new THREE.Vector3(0, 0, 0.6);
  private readonly desiredTarget = new THREE.Vector3();
  private dist = 0;
  private readonly v = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    opts: Partial<BroadcastCameraOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    const p = THREE.MathUtils.degToRad(this.opts.pitchDeg);
    this.dir = new THREE.Vector3(0, Math.sin(p), Math.cos(p));
    this.up = new THREE.Vector3(0, Math.cos(p), -Math.sin(p));
  }

  private tans() {
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    return { tanV, tanH: tanV * this.camera.aspect };
  }

  /** Distancia mínima para que `points` quepan, mirando a `target`. */
  private requiredDistance(target: THREE.Vector3, points: THREE.Vector3[]): number {
    const { tanV, tanH } = this.tans();
    const { marginX, marginY } = this.opts;
    let need = 0;
    for (const p of points) {
      this.v.subVectors(p, target);
      const along = this.v.dot(this.dir); // cuánto se acerca el punto a la cámara
      const x = Math.abs(this.v.x);
      const y = Math.abs(this.v.dot(this.up));
      need = Math.max(need, x / (tanH * marginX) + along, y / (tanV * marginY) + along);
    }
    return need;
  }

  /**
   * @param focus Punto que se quiere centrar (antes de restricciones).
   * @param mustSee Puntos que deben verse siempre.
   * @param zoom >1 acerca (solo depuración; puede dejar cosas fuera).
   */
  update(dt: number, focus: THREE.Vector3, mustSee: THREE.Vector3[], zoom = 1): void {
    const { tanV, tanH } = this.tans();
    const base = Math.max(this.opts.baseHalfWidth / tanH, this.opts.baseHalfHeight / tanV) / zoom;

    // Centro: el foco, sin mostrar demasiado más allá de los fondos de la pista.
    const limit = Math.max(0, 17.5 - base * tanH);
    this.desiredTarget.set(zoom > 1 ? focus.x : THREE.MathUtils.clamp(focus.x, -limit, limit), focus.y, focus.z);
    this.target.lerp(this.desiredTarget, 1 - Math.exp(-dt * 4));

    // Distancia: nunca menos de la necesaria (respecto al centro real de este frame).
    const need = this.requiredDistance(this.target, mustSee);
    const desired = Math.min(this.opts.maxDistance, Math.max(base, need));
    if (this.dist === 0) this.dist = desired;
    // Alejarse rápido, acercarse despacio (evita "bombeo" de la cámara).
    const rate = desired > this.dist ? 8 : 1.2;
    this.dist += (desired - this.dist) * (1 - Math.exp(-dt * rate));
    this.dist = Math.min(this.opts.maxDistance, Math.max(this.dist, need));

    this.camera.position.copy(this.target).addScaledVector(this.dir, this.dist);
    this.camera.lookAt(this.target);
  }
}
