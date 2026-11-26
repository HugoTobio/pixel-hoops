import { NET, type ClientMsg, type PlayerInput, type ServerMsg } from '@brawl/shared';

declare const __LAN_HOST__: string | null;

const isLocalhost = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

/**
 * Dirección pública del juego para el enlace de invitación. Si lo has abierto como "localhost",
 * se sustituye por la IP del ordenador en la red local (si no, el móvil no podría abrirlo).
 */
export function shareOrigin(): string {
  const env = import.meta.env.VITE_PUBLIC_URL as string | undefined;
  if (env) return env.replace(/\/$/, '');
  if (isLocalhost(location.hostname) && __LAN_HOST__) return `${location.protocol}//${__LAN_HOST__}:${location.port}`;
  return location.origin;
}

/** Dirección del servidor de partidas: variable de entorno en producción; en local, el mismo host en el puerto 2567. */
export function serverUrl(): string {
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.hostname}:${NET.port}`;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private lastSent = '';
  private lastSentAt = 0;

  constructor(
    private readonly onMessage: (msg: ServerMsg) => void,
    private readonly onClose: (reason: 'failed' | 'closed') => void,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(serverUrl());
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.ws = ws;
        resolve();
      };
      ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)) as ServerMsg);
      ws.onerror = () => {
        if (!opened) reject(new Error('No se pudo conectar'));
      };
      ws.onclose = () => {
        this.ws = null;
        this.onClose(opened ? 'closed' : 'failed');
      };
    });
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Envía los controles si han cambiado (o cada 100 ms como latido). Un pase siempre se envía. */
  sendInput(input: PlayerInput, now: number): void {
    const key = `${input.mx.toFixed(2)},${input.mz.toFixed(2)},${input.shoot},${input.pass}`;
    if (key === this.lastSent && !input.pass && now - this.lastSentAt < 100) return;
    this.send({ t: 'input', input: { mx: input.mx, mz: input.mz, shoot: input.shoot, pass: !!input.pass } });
    this.lastSent = key;
    this.lastSentAt = now;
  }

  close(): void {
    this.ws?.close();
  }
}
