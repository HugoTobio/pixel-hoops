import * as THREE from 'three';
import {
  BALL,
  createGame,
  NO_INPUT,
  resetPossession,
  assignHuman,
  cutJumpLift,
  finishLift,
  cutterCalling,
  NET,
  SHOT,
  SIM_DT,
  stepGame,
  type GameEvent,
  type GameState,
  type PlayerInput,
  type ServerMsg,
  type ShotQuality,
  type Team,
} from '@brawl/shared';
import './style.css';
import { lookFor, RING } from './content/teams';
import { isDown, keyboardVector } from './input/keyboard';
import { VirtualJoystick } from './input/joystick';
import { buildCourt } from './render/court';
import { createPlayerModel } from './render/player-model';
import { BroadcastCamera } from './render/camera';
import { applyPixelSize, autoScale } from './render/pixel';
import { faceted, toonMaterial, outlineMaterial } from './render/toon';
import { shareOrigin } from './net';
import { P2PGuest, P2PHost } from './p2p';
import { Sfx } from './audio/sfx';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const canvas = $<HTMLCanvasElement>('#game');
const statsEl = $('#stats');
const pxBtn = $<HTMLButtonElement>('#px-btn');
const hintEl = $('#hint');
const meterEl = $('#meter');
const meterFill = $('#meter-fill');
const meterSweet = $('#meter-sweet');
const toastEl = $('#toast');
const shootBtn = $<HTMLButtonElement>('#btn-shoot');
const scoreHome = $('#score-home');
const scoreAway = $('#score-away');

// --- Render -----------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap; // sombras de borde duro, encajan con el pixel

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b2433);
const court = buildCourt();
scene.add(court.group);

scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x5a4a3a, 1.5));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.0);
sun.position.set(-6, 22, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 16, bottom: -16, near: 1, far: 60 });
sun.shadow.bias = -0.001;
scene.add(sun);

// FOV estrecho + cámara lejana = poca deformación en los bordes (efecto teleobjetivo de TV).
const camera = new THREE.PerspectiveCamera(24, 1, 1, 200);
/** Vista lateral tipo retransmisión desde la banda (+z), con zoom out automático. */
const broadcast = new BroadcastCamera(camera);
const focus = new THREE.Vector3();
const mustSee = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

const params = new URLSearchParams(location.search);
/** ?zoom=3 acerca la cámara (útil para revisar modelos). */
const camZoom = Math.max(0.5, Number(params.get('zoom')) || 1);
let pixelOverride = params.has('px') ? Math.max(1, Number(params.get('px')) || 1) : 0;
let view = applyPixelSize(renderer, camera, pixelOverride || autoScale());

function onResize() {
  view = applyPixelSize(renderer, camera, pixelOverride || autoScale());
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 200));
pxBtn.addEventListener('click', () => {
  pixelOverride = pixelOverride >= 6 ? 0 : pixelOverride + 1; // auto → 1..6 → auto
  onResize();
});

// --- Partida (simulación compartida) ----------------------------------------
const game = createGame();
/**
 * Modo: menú, partida contra bots, ANFITRIÓN online (este navegador es el árbitro: simula la partida)
 * o INVITADO online (envía sus controles y dibuja el estado que le manda el anfitrión).
 */
let mode: 'menu' | 'local' | 'host' | 'guest' = 'menu';
let running = false;
/** Tu equipo: 0 (local) contra bots o si creaste la partida online; 1 si te uniste. */
let myTeam: Team = 0;
/** Jugador que controlas: cambia al recibir un pase (lo decide la simulación). */
let me = 0;
const humanId = () => game.players.find((p) => p.control === 'human' && p.team === myTeam)?.id ?? me;
let ringOwner = -1;
if (import.meta.env.DEV) Object.assign(window, { __game: game }); // depuración

const models = game.players.map((p, i) => {
  const team = p.team === 0 ? 'home' : 'away';
  const ring = RING[team];
  const m = createPlayerModel(lookFor(team, i % 3), p.height, ring);
  scene.add(m.root);
  return m;
});

// Balón: algo mayor que el real para que se lea a baja resolución.
const BALL_VISUAL_SCALE = 1.6;
const ballMesh = new THREE.Mesh(faceted(new THREE.IcosahedronGeometry(BALL.radius * BALL_VISUAL_SCALE, 1)), toonMaterial(0xf08a3c));
ballMesh.castShadow = true;
ballMesh.add(new THREE.Mesh(new THREE.IcosahedronGeometry(BALL.radius * BALL_VISUAL_SCALE + 0.03, 1), outlineMaterial));
scene.add(ballMesh);
// Sombra "blob" bajo el balón: clave para leer la altura del tiro desde arriba.
const ballShadow = new THREE.Mesh(
  new THREE.CircleGeometry(0.2, 10),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
);
ballShadow.rotation.x = -Math.PI / 2;
scene.add(ballShadow);

// Snapshot anterior para interpolar entre pasos fijos.
const prev = {
  px: game.players.map((p) => p.x),
  pz: game.players.map((p) => p.z),
  b: { x: game.ball.x, y: game.ball.y, z: game.ball.z },
};

// --- Input ------------------------------------------------------------------
const moveStick = new VirtualJoystick(canvas, (x) => x < window.innerWidth * 0.55);
let shootHeld = false;
/** Pulsación de pase pendiente de que la consuma un paso de simulación. */
let passQueued = false;
const passBtn = $<HTMLButtonElement>('#btn-pass');
passBtn.addEventListener('pointerdown', (e) => {
  passQueued = true;
  e.preventDefault();
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyN' && !e.repeat) passQueued = true;
});
shootBtn.addEventListener('pointerdown', (e) => {
  shootHeld = true;
  shootBtn.classList.add('held');
  shootBtn.setPointerCapture(e.pointerId);
  e.preventDefault();
});
const releaseShoot = () => {
  shootHeld = false;
  shootBtn.classList.remove('held');
};
shootBtn.addEventListener('pointerup', releaseShoot);
shootBtn.addEventListener('pointercancel', releaseShoot);

function readInput(): PlayerInput {
  const v = moveStick.active ? { x: moveStick.x, y: moveStick.y } : keyboardVector();
  // Pantalla → mundo: derecha = +x, arriba en pantalla = −z (la cámara mira desde la banda).
  return { mx: v.x, mz: v.y, shoot: shootHeld || isDown('Space'), pass: passQueued };
}

// --- Reset: recoloca y da el balón a tu jugador ------------------------------
function syncPrev() {
  game.players.forEach((p, i) => {
    prev.px[i] = p.x;
    prev.pz[i] = p.z;
  });
  Object.assign(prev.b, { x: game.ball.x, y: game.ball.y, z: game.ball.z });
}
function doReset() {
  if (mode !== 'local') return;
  assignHuman(game, 0);
  resetPossession(game, 0);
  syncPrev();
  toast('BALÓN PARA LOCAL', 'var(--ui)');
}
document.querySelector('#btn-reset')!.addEventListener('click', doReset);
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && !e.repeat) doReset();
});

// --- Feedback ---------------------------------------------------------------
const QUALITY_TEXT: Record<ShotQuality, [string, string]> = {
  perfect: ['¡PERFECTO!', 'var(--good)'],
  good: ['BIEN', 'var(--gold)'],
  early: ['PRONTO', 'var(--bad)'],
  late: ['TARDE', 'var(--bad)'],
};
let meterHideAt = 0;

function toast(text: string, color: string) {
  toastEl.textContent = text;
  toastEl.style.color = color;
  toastEl.classList.remove('show');
  void toastEl.offsetWidth; // reinicia la animación
  toastEl.classList.add('show');
}

// --- Sonido -----------------------------------------------------------------
const sfx = new Sfx();
if (import.meta.env.DEV) Object.assign(window, { __sfx: sfx }); // depuración
const sndBtn = $<HTMLButtonElement>('#snd-btn');
sndBtn.classList.toggle('off', sfx.muted);
sndBtn.addEventListener('click', () => {
  sfx.setMuted(!sfx.muted);
  sndBtn.classList.toggle('off', sfx.muted);
});
/** Panorama estéreo según la posición en pantalla (izquierda/derecha de la cámara). */
const panAt = (x: number) => Math.max(-1, Math.min(1, (x - camera.position.x) / 10));
let lastRenderBallY = 1;
let lastRenderHolder = -1;

let netShake = [0, 0];
/** Última finalización (para anunciar "+2 ¡MATE!" al anotar). */
let lastFinish: { playerId: number; kind: 'layup' | 'dunk' } | null = null;
let crowdJump = 0;

function handleEvents(events: GameEvent[], now: number) {
  for (const e of events) {
    // Sonidos de los eventos de la simulación.
    switch (e.type) {
      case 'pass':
        sfx.pass(panAt(game.players[e.from]!.x));
        break;
      case 'catch':
      case 'intercept':
      case 'pickup':
        sfx.catch(panAt(game.players[e.playerId]!.x));
        break;
      case 'rim':
        sfx.rim(e.speed / 3, panAt(game.ball.x));
        break;
      case 'board':
        sfx.board(e.speed / 4, panAt(game.ball.x));
        break;
      case 'bounce':
        sfx.bounce(Math.min(1, e.speed / 6), panAt(game.ball.x));
        break;
      case 'score':
        sfx.basket(panAt(e.side * 12.4), e.points === 3 || lastFinish?.kind === 'dunk');
        break;
    }
    // (Las bandejas y mates no usan la barra: no se muestra la calidad del timing.)
    if (e.type === 'shot' && e.playerId === me && e.meter > 0) {
      const [, color] = QUALITY_TEXT[e.quality];
      meterFill.style.background = color;
      meterHideAt = now + 700;
      toast(QUALITY_TEXT[e.quality][0], color);
    } else if (e.type === 'score') {
      scoreHome.textContent = String(game.score[0]);
      scoreAway.textContent = String(game.score[1]);
      const label = e.points === 3 ? '  ¡TRIPLE!' : lastFinish?.playerId === e.shooter ? (lastFinish.kind === 'dunk' ? '  ¡MATE!' : '  BANDEJA') : '';
      toast(`+${e.points}${label}`, 'var(--gold)');
      lastFinish = null;
      netShake[e.side === 1 ? 0 : 1] = 1;
      crowdJump = 1.5;
    } else if (e.type === 'play' && game.players[e.playerId]!.team === myTeam) {
      toast(e.kind === 'cut' ? 'PASA Y CORTA' : 'BLOQUEO', 'var(--ui)');
    } else if (e.type === 'screened' && game.players[e.screener]!.team === myTeam) {
      toast('¡DEFENSOR BLOQUEADO!', 'var(--good)');
    } else if (e.type === 'finish') {
      lastFinish = { playerId: e.playerId, kind: e.kind };
      toast(e.kind === 'dunk' ? '¡MATE!' : 'BANDEJA', 'var(--gold)');
    } else if (e.type === 'inbound' && game.players[e.playerId]!.team === myTeam) {
      toast('SAQUE: apunta y pulsa PASE', 'var(--ui)');
    } else if (e.type === 'intercept') {
      const ours = game.players[e.playerId]!.team === myTeam;
      toast(ours ? '¡ROBO!' : 'PASE CORTADO', ours ? 'var(--good)' : 'var(--bad)');
    } else if (e.type === 'rim') {
      netShake[game.ball.x > 0 ? 0 : 1] = Math.max(netShake[game.ball.x > 0 ? 0 : 1]!, 0.4);
    }
  }
}

// --- Menú inicial y partida online -----------------------------------------
const overlay = $('#overlay');
const panels = ['menu', 'invite', 'lobby', 'countdown', 'error'] as const;
function showPanel(name: (typeof panels)[number] | null) {
  overlay.classList.toggle('hidden', name === null);
  for (const p of panels) $(`#panel-${p}`).classList.toggle('hidden', p !== name);
}
const resetBtn = $<HTMLButtonElement>('#btn-reset');
function markMyTeam() {
  $('#scoreboard .team.home').classList.toggle('you', myTeam === 0);
  $('#scoreboard .team.away').classList.toggle('you', myTeam === 1);
}

function startLocal() {
  mode = 'local';
  myTeam = 0;
  assignHuman(game, 0);
  resetPossession(game, 0);
  me = humanId();
  syncPrev();
  markMyTeam();
  showPanel(null);
  ringOwner = -1;
  running = true;
  sfx.whistle();
}

let host: P2PHost | null = null;
let guest: P2PGuest | null = null;
/** Anfitrión: eventos acumulados para el siguiente envío de estado al invitado. */
let hostEvents: GameEvent[] = [];
let hostSteps = 0;
let countdownTimer = 0;

function showError(msg: string) {
  running = false;
  clearInterval(countdownTimer);
  $('#error-msg').textContent = msg;
  showPanel('error');
}

function runCountdown(seconds: number, notice: string) {
  $('#cd-notice').textContent = notice;
  $('#cd-team').textContent = myTeam === 0 ? 'Juegas con LOCAL (azul)' : 'Juegas con VISITANTE (rojo)';
  const num = $('#cd-num');
  let n = seconds;
  const show = () => {
    num.textContent = String(n);
    num.classList.remove('tick');
    void num.offsetWidth;
    num.classList.add('tick');
  };
  show();
  showPanel('countdown');
  clearInterval(countdownTimer);
  countdownTimer = window.setInterval(() => {
    n = Math.max(0, n - 1);
    show();
    if (n === 0) clearInterval(countdownTimer);
  }, 1000);
}

function applySnapshot(s: GameState) {
  game.players.forEach((p, i) => {
    prev.px[i] = p.x;
    prev.pz[i] = p.z;
    Object.assign(p, s.players[i]);
  });
  Object.assign(prev.b, { x: game.ball.x, y: game.ball.y, z: game.ball.z });
  Object.assign(game.ball, s.ball);
  game.score = s.score;
  game.possession = s.possession;
  game.pendingInbound = s.pendingInbound;
  game.time = s.time;
  lastSnapAt = performance.now();
}

function onServer(msg: ServerMsg) {
  switch (msg.t) {
    case 'created': {
      myTeam = msg.team;
      const link = `${shareOrigin()}${location.pathname}?join=${msg.code}`;
      $('#room-code').textContent = msg.code;
      $<HTMLInputElement>('#room-link').value = link;
      $('#lobby-share').classList.remove('hidden');
      $('#waiting-text').textContent = 'Esperando';
      break;
    }
    case 'joined':
      myTeam = msg.team;
      break;
    case 'opponent_joined':
      break;
    case 'countdown':
      markMyTeam();
      runCountdown(msg.seconds, myTeam === 0 ? '¡Rival conectado!' : '¡Conectado a la partida!');
      break;
    case 'start':
      clearInterval(countdownTimer);
      showPanel(null);
      ringOwner = -1;
      running = true;
      sfx.whistle();
      break;
    case 'state':
      applySnapshot(msg.s);
      me = humanId();
      handleEvents(msg.ev, performance.now());
      break;
    case 'error':
      showError(msg.message);
      break;
    case 'opponent_left':
      showError('Tu rival se ha desconectado.');
      break;
  }
}

function enterOnlineUi(title: string) {
  resetBtn.style.display = 'none';
  hintEl.innerHTML = hintEl.innerHTML.replace(' · R = reset', '');
  $('#lobby-title').textContent = title;
  $('#lobby-share').classList.add('hidden');
  $('#waiting-text').textContent = 'Conectando';
  showPanel('lobby');
}

/** Crea la partida: este navegador será el servidor/árbitro. */
async function startHost() {
  mode = 'host';
  myTeam = 0;
  enterOnlineUi('PARTIDA ONLINE');
  host = new P2PHost({
    onGuestJoined() {
      markMyTeam();
      host!.send({ t: 'countdown', seconds: NET.countdownSeconds });
      runCountdown(NET.countdownSeconds, '¡Rival conectado!');
      setTimeout(startHostedMatch, NET.countdownSeconds * 1000);
    },
    onGuestLeft() {
      if (mode === 'host') showError('Tu rival se ha desconectado.');
    },
    onError(message) {
      if (!running) showError(message);
    },
  });
  try {
    const code = await host.open();
    onServer({ t: 'created', code, team: 0 });
  } catch {
    showError('No se pudo crear la partida. Revisa tu conexión a internet.');
  }
}

function startHostedMatch() {
  // Si mientras tanto el rival se fue (hay un error en pantalla), no se empieza.
  if (mode !== 'host' || !$('#panel-error').classList.contains('hidden')) return;
  // Cada equipo lo maneja un humano (su base); los compañeros, la IA.
  assignHuman(game, 0);
  assignHuman(game, 3);
  resetPossession(game, 0);
  me = humanId();
  syncPrev();
  hostEvents = [];
  host!.send({ t: 'start' });
  onServer({ t: 'start' });
}

/** Se une a la partida de otro: su navegador es el árbitro. */
async function startGuest(code: string) {
  mode = 'guest';
  enterOnlineUi(`UNIRSE A ${code.toUpperCase()}`);
  $('#waiting-text').textContent = 'Uniéndote';
  guest = new P2PGuest(onServer, showError);
  await guest.join(code);
}

$('#btn-hvb').addEventListener('click', startLocal);
$('#btn-hvh').addEventListener('click', startHost);
$('#btn-cancel').addEventListener('click', () => location.assign(location.pathname));
$('#btn-back').addEventListener('click', () => location.assign(location.pathname));
$('#btn-copy').addEventListener('click', async () => {
  const input = $<HTMLInputElement>('#room-link');
  const btn = $<HTMLButtonElement>('#btn-copy');
  try {
    if (navigator.share) await navigator.share({ title: 'Pixel Hoops', text: 'Únete a mi partida', url: input.value });
    else await navigator.clipboard.writeText(input.value);
    btn.textContent = '¡HECHO!';
  } catch {
    input.select(); // sin permisos (p. ej. http en la red local): queda seleccionado para copiar a mano
    btn.textContent = 'SELECCIONADO';
  }
});

// Al cerrar o salir de la página, avisar al otro jugador al momento.
window.addEventListener('pagehide', () => {
  host?.close();
  guest?.close();
});

// Invitado por enlace: primero un botón (así el navegador permite el sonido) y luego se une.
const joinParam = new URLSearchParams(location.search).get('join');
if (joinParam) {
  $('#invite-code').textContent = joinParam.toUpperCase();
  showPanel('invite');
  $('#btn-join').addEventListener('click', () => startGuest(joinParam));
  $('#btn-invite-cancel').addEventListener('click', () => location.assign(location.pathname));
} else showPanel('menu');

// --- Bucle ------------------------------------------------------------------
const tmp = new THREE.Vector3();
const ballPos = new THREE.Vector3();
const crowdMatrix = new THREE.Matrix4();
const crowdBase = Array.from({ length: court.crowd.count }, (_, i) => {
  court.crowd.getMatrixAt(i, crowdMatrix);
  return new THREE.Vector3().setFromMatrixPosition(crowdMatrix);
});
let acc = 0;
let lastSnapAt = 0;
let last = performance.now();
let fpsFrames = 0;
let fpsTime = 0;
let hintHidden = false;
let t = 0;

function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  t += dt;

  // Local: simulación a paso fijo (la misma que ejecuta el servidor). Online: solo se envían controles.
  const input = readInput();
  if (mode === 'guest') {
    if (running) {
      guest?.sendInput(input, now);
      if (input.pass) passQueued = false;
    }
    acc = 0;
  } else if (running) acc += dt;
  if (running) {
    host?.checkAlive(now);
    guest?.checkAlive(now);
  }
  // Local y anfitrión: simulación a paso fijo. El anfitrión usa los controles del invitado para su equipo.
  while ((mode === 'local' || mode === 'host') && acc >= SIM_DT) {
    game.players.forEach((p, i) => {
      prev.px[i] = p.x;
      prev.pz[i] = p.z;
    });
    Object.assign(prev.b, { x: game.ball.x, y: game.ball.y, z: game.ball.z });
    const remote = host?.remoteInput;
    const ev = stepGame(
      game,
      (id) => (game.players[id]!.team === myTeam ? (id === me ? input : NO_INPUT) : (remote ?? NO_INPUT)),
      SIM_DT,
      Math.random,
    );
    handleEvents(ev, now);
    acc -= SIM_DT;
    if (input.pass) {
      input.pass = false;
      passQueued = false;
    }
    me = humanId();
    if (mode === 'host' && host) {
      host.remoteInput.pass = false; // la pulsación del invitado ya se usó
      hostEvents.push(...ev);
      if (++hostSteps % Math.round(1 / SIM_DT / NET.snapshotHz) === 0) {
        host.send({ t: 'state', s: game, ev: hostEvents });
        hostEvents = [];
      }
    }
  }
  if (!hintHidden && (Math.hypot(input.mx, input.mz) > 0 || input.shoot)) {
    hintHidden = true;
    hintEl.style.opacity = '0';
  }

  // Interpolación: entre pasos locales, o entre los dos últimos estados recibidos del servidor.
  const a = mode === 'guest' ? Math.min(1, (now - lastSnapAt) / (1000 / NET.snapshotHz)) : acc / SIM_DT;
  const lerp = (x0: number, x1: number) => x0 + (x1 - x0) * a;

  if (ringOwner !== me) {
    game.players.forEach((p, i) => models[i]!.setRing(p.id === me && mode !== 'menu' ? RING.self : RING[p.team === 0 ? 'home' : 'away']));
    ringOwner = me;
  }
  const passLabel =
    game.ball.holder === me && cutterCalling(game, myTeam)
      ? 'DEVOLVER'
      : game.ball.holder === me || game.possession === myTeam
        ? 'PASE'
        : 'CORTAR';
  if (passBtn.textContent !== passLabel) {
    passBtn.textContent = passLabel;
    passBtn.style.fontSize = passLabel.length > 6 ? '8px' : '';
  }

  // Jugadores (animación por mocap, ver render/anim.ts)
  game.players.forEach((p, i) => {
    const m = models[i]!;
    m.root.position.set(lerp(prev.px[i]!, p.x), 0, lerp(prev.pz[i]!, p.z));
    m.update(dt, {
      speed: Math.hypot(p.vx, p.vz),
      facing: p.facing,
      hasBall: game.ball.holder === p.id,
      charging: p.charging,
      chargeProgress: p.charge / (SHOT.meterTime * SHOT.sweet),
      action: p.finish
        ? p.finish.kind
        : p.play?.kind === 'cut'
          ? p.play.phase === 'toRim'
            ? 'callBall'
            : p.play.phase === 'jump'
              ? 'jumpCall'
              : 'none'
          : p.play?.kind === 'screen' && p.play.phase === 'set'
            ? 'screen'
            : 'none',
      lift: cutJumpLift(p) + finishLift(p),
    });
  });

  // Balón: en la mano (lo coloca la animación) o suelto (simulación).
  const b = game.ball;
  if (b.holder >= 0) {
    models[b.holder]!.ballAnchor(ballPos);
  } else {
    ballPos.set(lerp(prev.b.x, b.x), lerp(prev.b.y, b.y), lerp(prev.b.z, b.z));
    ballMesh.rotation.x += b.vz * dt * 4;
    ballMesh.rotation.z -= b.vx * dt * 4;
  }
  const bx = ballPos.x;
  const by = ballPos.y;
  const bz = ballPos.z;
  ballMesh.position.copy(ballPos);
  // Bote del regate: suena cuando el balón (animado por el mocap) toca el suelo.
  if (b.holder >= 0 && b.holder === lastRenderHolder && lastRenderBallY > 0.3 && by <= 0.3) {
    sfx.bounce(0.55, panAt(bx));
  }
  lastRenderBallY = by;
  lastRenderHolder = b.holder;
  ballShadow.position.set(bx, 0.012, bz);
  ballShadow.scale.setScalar(Math.max(0.5, 1.2 - by * 0.15));

  // Redes y público
  court.nets.forEach((net, i) => {
    netShake[i] = Math.max(0, netShake[i]! - dt * 2.5);
    net.scale.y = 1 + Math.sin(t * 40) * 0.12 * netShake[i]!;
  });
  if (crowdJump > 0) {
    crowdJump = Math.max(0, crowdJump - dt);
    crowdBase.forEach((p, i) => {
      const jump = Math.max(0, Math.sin(t * 14 + i * 1.7)) * 0.25 * Math.min(1, crowdJump);
      crowdMatrix.makeTranslation(p.x, p.y + jump, p.z);
      court.crowd.setMatrixAt(i, crowdMatrix);
    });
    court.crowd.instanceMatrix.needsUpdate = true;
  }

  // Cámara de retransmisión: centra entre balón y jugador y hace zoom out si no caben.
  const mePos = models[me]!.root.position;
  const meH = game.players[me]!.height;
  focus.set(bx * 0.6 + mePos.x * 0.4, 0, 0.6 + ((mePos.z + bz) / 2) * 0.3);
  mustSee[0]!.set(mePos.x, 0, mePos.z);
  mustSee[1]!.set(mePos.x, meH + 0.6, mePos.z); // cabeza + brazos en el tiro
  mustSee[2]!.set(bx, by + 0.4, bz);
  mustSee[3]!.set(bx, Math.max(0, by - 0.4), bz);
  broadcast.update(dt, focus, mustSee, camZoom);

  // Barra de tiro sobre el jugador
  const meP = game.players[me]!;
  if (meP.charging || now < meterHideAt) {
    if (meP.charging) {
      const fill = Math.min(1, meP.charge / SHOT.meterTime / SHOT.autoRelease);
      meterFill.style.height = `${fill * 100}%`;
      meterFill.style.background = 'var(--ui)';
    }
    // Zona verde real (± shotWindow alrededor del punto ideal); más grande si estás solo.
    const w = meP.shotWindow;
    meterSweet.style.bottom = `${((SHOT.sweet - w) / SHOT.autoRelease) * 100}%`;
    meterSweet.style.height = `${((2 * w) / SHOT.autoRelease) * 100}%`;
    meterEl.classList.toggle('open', w > SHOT.perfectWindow * 1.8);
    tmp.set(mePos.x + 0.7, meP.height + 0.7, mePos.z).project(camera);
    meterEl.style.left = `${((tmp.x + 1) / 2) * window.innerWidth}px`;
    // Sin taparse con el marcador: el borde inferior de la barra nunca por encima de 130 px.
    meterEl.style.top = `${Math.max(130, ((1 - tmp.y) / 2) * window.innerHeight)}px`;
    meterEl.style.display = 'block';
  } else {
    meterEl.style.display = 'none';
  }

  renderer.render(scene, camera);

  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    statsEl.textContent = `${Math.round(fpsFrames / fpsTime)} fps · ${view.width}×${view.height} · px ${pixelOverride || `auto(${view.scale})`}`;
    fpsFrames = 0;
    fpsTime = 0;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
