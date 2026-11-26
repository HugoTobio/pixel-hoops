/**
 * Multijugador P2P (WebRTC con PeerJS): el navegador de quien crea la partida hace de servidor/árbitro.
 *
 * - El ANFITRIÓN ejecuta la simulación compartida, recibe los controles del invitado y le envía el
 *   estado completo 30 veces por segundo.
 * - El INVITADO solo envía sus controles y dibuja lo que recibe.
 * - El servidor público de PeerJS solo sirve para que los dos navegadores se encuentren (intercambian
 *   unos pocos mensajes de presentación). Luego la conexión es directa; si la red no lo permite, PeerJS
 *   usa sus repetidores TURN públicos. Nada de esto requiere cuenta.
 *
 * Los mensajes son los mismos del protocolo compartido (ClientMsg / ServerMsg).
 */
import Peer, { type DataConnection } from 'peerjs';
import { makeRoomCode, NO_INPUT, type ClientMsg, type PlayerInput, type ServerMsg } from '@brawl/shared';

/** Prefijo para que nuestros códigos no choquen con otras apps del servidor público de PeerJS. */
const PREFIX = 'pixelhoops-v1-';
const CONNECT_TIMEOUT_MS = 15000;
/** Sin noticias del otro durante este tiempo = desconectado (WebRTC tarda mucho en notarlo solo). */
export const SILENCE_TIMEOUT_MS = 6000;

export interface HostEvents {
  onGuestJoined(): void;
  onGuestLeft(): void;
  onError(message: string): void;
}

export class P2PHost {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  /** Último estado de los controles del invitado; el pase se retiene hasta usarlo en un paso. */
  readonly remoteInput: PlayerInput = { ...NO_INPUT };
  /** Última vez que llegó algo del invitado. */
  lastHeard = 0;
  private gone = false;
  private ping = 0;

  constructor(private readonly ev: HostEvents) {}

  /** Registra la partida con un código libre y devuelve el código. */
  async open(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeRoomCode();
      try {
        this.peer = await openPeer(PREFIX + code);
        this.listen();
        return code;
      } catch (e) {
        if ((e as { type?: string }).type !== 'unavailable-id') throw e;
      }
    }
    throw new Error('No se pudo generar un código de partida.');
  }

  private listen() {
    const peer = this.peer!;
    // Si se pierde el contacto con el servidor de presentación, la partida en curso sigue (es directa).
    peer.on('disconnected', () => peer.reconnect());
    peer.on('error', (e) => {
      if (e.type === 'network' || e.type === 'server-error') return; // solo afecta a nuevas presentaciones
      this.ev.onError(`Error de conexión (${e.type}).`);
    });
    peer.on('connection', (conn) => {
      if (this.conn) {
        conn.on('open', () => {
          conn.send({ t: 'error', message: 'La partida ya está completa.' } satisfies ServerMsg);
          setTimeout(() => conn.close(), 300);
        });
        return;
      }
      this.conn = conn;
      conn.on('open', () => {
        this.lastHeard = performance.now();
        // Latido (los temporizadores siguen vivos aunque la pestaña esté en segundo plano).
        this.ping = window.setInterval(() => conn.open && conn.send({ t: 'ping' }), 1000);
        this.send({ t: 'joined', code: '', team: 1 });
        this.ev.onGuestJoined();
      });
      conn.on('data', (data) => {
        this.lastHeard = performance.now();
        const msg = data as ClientMsg | { t: 'bye' };
        if (msg?.t === 'bye') return this.guestGone();
        if (msg?.t !== 'input') return;
        const inp = msg.input;
        Object.assign(this.remoteInput, {
          mx: clamp(Number(inp.mx) || 0),
          mz: clamp(Number(inp.mz) || 0),
          shoot: !!inp.shoot,
          pass: !!inp.pass || !!this.remoteInput.pass,
        });
      });
      conn.on('close', () => this.guestGone());
      conn.on('error', () => this.guestGone());
    });
  }

  private guestGone() {
    if (this.gone) return;
    this.gone = true;
    clearInterval(this.ping);
    this.ev.onGuestLeft();
  }

  /** Llamar periódicamente: detecta que el invitado dejó de dar señales. */
  checkAlive(now: number): void {
    if (this.conn?.open && this.lastHeard && now - this.lastHeard > SILENCE_TIMEOUT_MS) this.guestGone();
  }

  send(msg: ServerMsg): void {
    if (this.conn?.open) this.conn.send(msg);
  }

  /** Despedida inmediata (al cerrar la página) para que el otro no espere al tiempo de espera. */
  close(): void {
    if (this.conn?.open) this.conn.send({ t: 'opponent_left' } satisfies ServerMsg);
    this.conn?.close();
    this.peer?.destroy();
  }
}

export class P2PGuest {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private lastSent = '';
  private lastSentAt = 0;
  private closed = false;
  /** Última vez que llegó algo del anfitrión. */
  lastHeard = 0;
  private ping = 0;

  constructor(
    private readonly onMessage: (msg: ServerMsg) => void,
    private readonly onFail: (message: string) => void,
  ) {}

  async join(code: string): Promise<void> {
    try {
      this.peer = await openPeer();
    } catch {
      return this.fail('No se pudo contactar con el servicio de conexión. Revisa tu conexión a internet.');
    }
    this.peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') this.fail('No existe ninguna partida con ese código, o el anfitrión la ha cerrado.');
      else if (!this.conn?.open) this.fail(`No se pudo conectar (${e.type}).`);
    });
    const conn = this.peer.connect(PREFIX + code.toUpperCase(), { reliable: true, serialization: 'json' });
    this.conn = conn;
    const timer = setTimeout(() => {
      if (!conn.open) this.fail('No se pudo conectar con el anfitrión. Puede que vuestras redes no permitan la conexión directa.');
    }, CONNECT_TIMEOUT_MS);
    conn.on('open', () => {
      clearTimeout(timer);
      this.lastHeard = performance.now();
      this.ping = window.setInterval(() => conn.open && conn.send({ t: 'ping' }), 1000);
    });
    conn.on('data', (data) => {
      this.lastHeard = performance.now();
      if ((data as { t?: string })?.t === 'ping') return;
      this.onMessage(data as ServerMsg);
    });
    conn.on('close', () => {
      if (!this.closed) this.onMessage({ t: 'opponent_left' });
    });
  }

  private fail(message: string) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    this.onFail(message);
    this.peer?.destroy();
  }

  /** Envía los controles si han cambiado (o cada 100 ms como latido). Un pase siempre se envía. */
  sendInput(input: PlayerInput, now: number): void {
    if (!this.conn?.open) return;
    const key = `${input.mx.toFixed(2)},${input.mz.toFixed(2)},${input.shoot},${input.pass}`;
    if (key === this.lastSent && !input.pass && now - this.lastSentAt < 100) return;
    this.conn.send({ t: 'input', input: { mx: input.mx, mz: input.mz, shoot: input.shoot, pass: !!input.pass } } satisfies ClientMsg);
    this.lastSent = key;
    this.lastSentAt = now;
  }

  /** Llamar periódicamente durante la partida: detecta que el anfitrión dejó de enviar. */
  checkAlive(now: number): void {
    if (!this.closed && this.conn?.open && this.lastHeard && now - this.lastHeard > SILENCE_TIMEOUT_MS) {
      this.closed = true;
      this.onMessage({ t: 'opponent_left' });
    }
  }

  close(): void {
    if (this.conn?.open) this.conn.send({ t: 'bye' });
    this.closed = true;
    this.peer?.destroy();
  }
}

const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/** Crea un Peer y espera a que el servidor de presentación lo acepte. */
function openPeer(id?: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
    const onError = (e: unknown) => {
      peer.destroy();
      reject(e);
    };
    peer.once('open', () => {
      peer.off('error', onError);
      resolve(peer);
    });
    peer.once('error', onError);
  });
}
