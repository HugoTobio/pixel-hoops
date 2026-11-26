/**
 * Estudio de mocap (local): vídeo → MediaPipe Pose en el navegador → balón → clip del juego.
 * Arrancar con `npm run studio` (abre http://localhost:5180/studio.html).
 * La parte que guarda en disco está en apps/client/studio-server.ts.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { lookFor } from '../content/teams';
import { buildCourt } from '../render/court';
import { createPlayerModel } from '../render/player-model';
import { faceted, outlineMaterial, toonMaterial } from '../render/toon';
import { detectBall } from '../mocap/ball-detect';
import { bakeCapture, DEFAULT_EXAGGERATE, landmarksJson, MP, SKELETON_BONES, type Baked, type BallKey, type Capture, type CaptureFrame, type HandOverride } from '../mocap/capture';
import { MocapClip } from '../mocap/clip';

declare const __MP_WASM__: string;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const video = $<HTMLVideoElement>('#video');
const overlay = $<HTMLCanvasElement>('#overlay');
const canvas = $<HTMLCanvasElement>('#view');
const scrub = $<HTMLInputElement>('#scrub');
const playBtn = $<HTMLButtonElement>('#play');
const fmt = (x: number, d = 2) => x.toFixed(d).replace('.', ',');

function status(text: string, kind: '' | 'ok' | 'bad' = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = kind;
}

// --- Escena 3D (la misma luz y pista que el juego) ------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b2433);
scene.add(buildCourt().group);
scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x5a4a3a, 1.5));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.0);
sun.position.set(-3, 11, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 5, bottom: -4, near: 1, far: 30 });
sun.shadow.bias = -0.001;
scene.add(sun);

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 2;
controls.maxDistance = 25;
controls.maxPolarAngle = Math.PI / 2 - 0.02;

const player = createPlayerModel(lookFor('home', 1), 2.01, 0xf2c94c);
player.root.visible = false;
scene.add(player.root);
const RIG = player.height / 2; // unidades del rig → metros

// Balón como en el juego (se dibuja 1,6× el real).
const BALL_R = 0.19;
const ballGeo = faceted(new THREE.IcosahedronGeometry(BALL_R, 1));
const ball = new THREE.Mesh(ballGeo, toonMaterial(0xe8742c));
ball.castShadow = true;
const ballHull = new THREE.Mesh(ballGeo, outlineMaterial);
ballHull.scale.setScalar(1.12);
ball.add(ballHull);
ball.visible = false;
scene.add(ball);

// Esqueleto de MediaPipe (comparación).
const skelGeo = new THREE.BufferGeometry();
const skelPos = new Float32Array(SKELETON_BONES.length * 6);
skelGeo.setAttribute('position', new THREE.BufferAttribute(skelPos, 3));
const skeleton = new THREE.Group();
skeleton.add(new THREE.LineSegments(skelGeo, new THREE.LineBasicMaterial({ color: 0x6fe3ff })));
const skelBall = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 1), new THREE.MeshBasicMaterial({ color: 0x6fe3ff, wireframe: true }));
skeleton.add(skelBall);
skeleton.visible = false;
scene.add(skeleton);

// Asa del keyframe del balón (se mueve con flechas X/Y/Z en la vista 3D).
const keyHandle = new THREE.Mesh(new THREE.IcosahedronGeometry(BALL_R * 1.08, 1), new THREE.MeshBasicMaterial({ color: 0x6fe3a0, wireframe: true }));
keyHandle.visible = false;
scene.add(keyHandle);
const gizmo = new TransformControls(camera, canvas);
gizmo.setSize(0.8);
gizmo.attach(keyHandle);
gizmo.enabled = false;
const gizmoHelper = gizmo.getHelper();
gizmoHelper.visible = false;
scene.add(gizmoHelper);
gizmo.addEventListener('dragging-changed', (e) => (controls.enabled = !e.value));

// --- Estado --------------------------------------------------------------------------------
const state = {
  name: '',
  capture: null as Capture | null,
  baked: null as Baked | null,
  bakedRaw: null as Baked | null,
  mocap: null as MocapClip | null,
  clean: true,
  skeleton: false,
  overlay: true,
  pixel: true,
  playing: false,
  /** Inicio y fin del clip (segundos del vídeo): recorta lo analizado o marca qué analizar. */
  range: [0, 0] as [number, number],
  analyzing: false,
  cancel: false,
  dirty: false,
  editing: false,
};
const sample = MocapClip.emptySample();
let lastOverlayFrame = -2;
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();
const footL = new THREE.Vector3();
const footR = new THREE.Vector3();
const offset = new THREE.Vector3();
/** Dónde estaba el jugador en el fotograma anterior (la cámara le sigue). */
const lastBody = new THREE.Vector3();

// --- Biblioteca ----------------------------------------------------------------------------
interface Item {
  name: string;
  video: string | null;
  capture: boolean;
  clip: boolean;
}
let library: Item[] = [];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/__studio/${path}`, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as T;
}

async function refreshLibrary() {
  library = await api<Item[]>('list');
  const ul = $('#library');
  ul.replaceChildren(
    ...library.map((it) => {
      const li = document.createElement('li');
      li.className = it.name === state.name ? 'active' : '';
      const tag = it.clip ? 'en el juego' : it.capture ? 'analizada' : it.video ? 'sin analizar' : 'sin vídeo';
      li.innerHTML = `<span></span><small>${tag}</small>`;
      li.firstElementChild!.textContent = it.name;
      li.onclick = () => void open(it.name);
      return li;
    }),
  );
}

async function open(name: string) {
  if (state.analyzing) return;
  const it = library.find((i) => i.name === name);
  if (!it) return;
  setPlaying(false);
  state.name = name;
  state.capture = null;
  state.baked = state.bakedRaw = null;
  state.mocap = null;
  state.dirty = false;
  setEditing(false);
  renderKeys();
  $<HTMLButtonElement>('#export').disabled = true;
  history.replaceState(null, '', `?c=${encodeURIComponent(name)}`);
  await refreshLibrary();
  status(`Cargando ${name}…`);
  if (it.video) {
    video.src = it.video;
    await new Promise<void>((ok) => video.addEventListener('loadedmetadata', () => ok(), { once: true }));
  } else video.removeAttribute('src');
  state.range = [0, video.duration || 0];
  $<HTMLButtonElement>('#dup').disabled = !it.video;
  if (it.capture) {
    const cap = await api<Capture>(`capture/${name}`);
    loadCapture(cap);
    status(`${name}: clip de ${state.baked!.world.length} fotogramas a ${fmt(cap.fps, 1)} fps · ${statsText()}`, 'ok');
  } else status(it.video ? `${name}: sin analizar. Marca el tramo (opcional) y pulsa ANALIZAR.` : `${name}: falta el vídeo.`);
  seek(state.range[0]);
  updateRangeUi();
}

function statsText() {
  const s = state.baked?.stats;
  if (!s || !state.capture) return '';
  return `balón visto en ${Math.round((s.ballSeen / state.baked!.world.length) * 100)} % · salto máx. ${Math.round(s.maxJump * 100)} cm`;
}

function loadCapture(cap: Capture) {
  cap.exaggerate = { ...DEFAULT_EXAGGERATE, ...cap.exaggerate };
  state.capture = cap;
  state.range = [...(cap.trim ?? cap.range)];
  cap.ballKeys ??= [];
  cap.feetLock ??= true;
  $('#feet').setAttribute('aria-pressed', String(cap.feetLock));
  rebake();
  setSliders(cap.exaggerate.jump, cap.exaggerate.pose);
  $<HTMLButtonElement>('#save').disabled = false;
  $<HTMLButtonElement>('#export').disabled = false;
}

/** Vuelve a hornear tras cambiar keyframes o pies fijos (rápido: ~decenas de ms). */
function rebake() {
  const cap = state.capture;
  if (!cap) return;
  cap.ballKeys!.sort((a, b) => a.f - b.f);
  state.baked = bakeCapture(cap, true);
  state.bakedRaw = bakeCapture(cap, false);
  pickClip();
  renderKeys();
  lastOverlayFrame = -2;
}
let rebakeQueued = false;
function queueRebake() {
  if (rebakeQueued) return;
  rebakeQueued = true;
  requestAnimationFrame(() => {
    rebakeQueued = false;
    rebake();
  });
}
function markDirty(msg = 'Cambios sin guardar: pulsa GUARDAR EN EL JUEGO.') {
  state.dirty = true;
  status(msg);
}

function pickClip() {
  const b = state.clean ? state.baked : state.bakedRaw;
  if (!b) return;
  state.mocap = new MocapClip(b.clip);
  state.mocap.exaggerate = { ...state.capture!.exaggerate };
}

// --- Nuevo vídeo ---------------------------------------------------------------------------
let pendingFile: File | null = null;
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'clip';

function chooseFile(f: File) {
  pendingFile = f;
  let name = slug(f.name);
  for (let k = 2; library.some((i) => i.name === name); k++) name = `${slug(f.name).slice(0, 36)}-${k}`;
  $<HTMLInputElement>('#new-name').value = name;
  $('#new-form').classList.add('show');
  $<HTMLInputElement>('#new-name').focus();
  status(`Vídeo elegido: ${f.name} (${fmt(f.size / 1e6, 1)} MB). Ponle nombre y pulsa Crear captura.`);
}
$<HTMLInputElement>('#file').onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) chooseFile(f);
};
$('#new-cancel').onclick = () => {
  pendingFile = null;
  $('#new-form').classList.remove('show');
};
$<HTMLFormElement>('#new-form').onsubmit = async (e) => {
  e.preventDefault();
  if (!pendingFile) return;
  const name = $<HTMLInputElement>('#new-name').value.trim();
  const ext = (pendingFile.name.split('.').pop() ?? 'mp4').toLowerCase();
  status(`Copiando el vídeo a tools/video-mocap/data/${name}/…`);
  try {
    await api(`video/${name}?ext=${encodeURIComponent(ext)}`, { method: 'PUT', body: pendingFile });
    pendingFile = null;
    $('#new-form').classList.remove('show');
    await refreshLibrary();
    await open(name);
  } catch (err) {
    status(`No se pudo crear: ${(err as Error).message}`, 'bad');
  }
};
// --- Duplicar --------------------------------------------------------------------------------
$('#dup').onclick = () => {
  if (!state.name) return;
  let name = `${state.name.slice(0, 36)}-2`;
  for (let k = 3; library.some((i) => i.name === name); k++) name = `${state.name.slice(0, 36)}-${k}`;
  $<HTMLInputElement>('#dup-name').value = name;
  $('#dup-form').classList.add('show');
  $<HTMLInputElement>('#dup-name').focus();
};
$('#dup-cancel').onclick = () => $('#dup-form').classList.remove('show');
$<HTMLFormElement>('#dup-form').onsubmit = async (e) => {
  e.preventDefault();
  const to = $<HTMLInputElement>('#dup-name').value.trim();
  if (state.dirty) await save(); // que la copia lleve los últimos cambios
  try {
    await api(`duplicate/${state.name}`, { method: 'POST', body: JSON.stringify({ to }) });
    $('#dup-form').classList.remove('show');
    await refreshLibrary();
    await open(to);
    status(`Copia creada: ${to}. Marca otro inicio/fin (o analiza otra parte del vídeo) para sacar otro clip.`, 'ok');
  } catch (err) {
    status(`No se pudo duplicar: ${(err as Error).message}`, 'bad');
  }
};

addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dragging');
});
addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files[0];
  if (f && f.type.startsWith('video/')) chooseFile(f);
  else if (f) status('Eso no parece un vídeo.', 'bad');
});

// --- Análisis ------------------------------------------------------------------------------
let modelBuffer: Uint8Array | null = null;

async function createLandmarker(): Promise<PoseLandmarker> {
  if (!modelBuffer) {
    status('Cargando el modelo de MediaPipe Pose (la primera vez se descarga, 30 MB)…');
    const r = await fetch('/__studio/model');
    if (!r.ok) throw new Error('No se pudo cargar el modelo de MediaPipe');
    modelBuffer = new Uint8Array(await r.arrayBuffer());
  }
  const fileset = await FilesetResolver.forVisionTasks(__MP_WASM__);
  const opts = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetBuffer: modelBuffer!, delegate },
    runningMode: 'VIDEO' as const,
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    return await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
  }
}

/**
 * El análisis va sobre un vídeo propio, invisible: así se puede seguir tocando el reproductor mientras
 * tanto sin que se mezclen fotogramas.
 */
async function analysisVideo(src: string): Promise<HTMLVideoElement> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = src;
  await new Promise<void>((ok, fail) => {
    v.addEventListener('loadeddata', () => ok(), { once: true });
    v.addEventListener('error', () => fail(new Error('No se pudo leer el vídeo')), { once: true });
  });
  return v;
}

function seekVideo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((ok) => {
    if (Math.abs(v.currentTime - t) < 1e-4 && v.readyState >= 2) return ok();
    v.addEventListener('seeked', () => ok(), { once: true });
    v.currentTime = t;
  });
}

/** Fotogramas por segundo del vídeo: el navegador no lo dice, se mide reproduciendo un momento. */
async function measureFps(video: HTMLVideoElement, from: number): Promise<number> {
  if (!('requestVideoFrameCallback' in video)) return 30;
  await seekVideo(video, from);
  const times: number[] = [];
  await new Promise<void>((ok) => {
    const done = () => {
      video.pause();
      ok();
    };
    const tick = (_: number, meta: VideoFrameCallbackMetadata) => {
      times.push(meta.mediaTime);
      if (times.length >= 24) done();
      else video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
    video.playbackRate = 1;
    void video.play();
    setTimeout(done, 1500);
  });
  const d = times
    .slice(1)
    .map((t, i) => t - times[i]!)
    .filter((x) => x > 0.004)
    .sort((a, b) => a - b);
  if (d.length < 4) return 30;
  const fps = 1 / d[d.length >> 1]!;
  return Math.min(120, Math.max(10, fps));
}

async function analyze() {
  if (!state.name || !video.src || state.analyzing) return;
  setPlaying(false);
  state.analyzing = true;
  state.cancel = false;
  const ui = (on: boolean) => {
    $('#progress-wrap').classList.toggle('show', on);
    for (const id of ['#analyze', '#save', '#mark-in', '#mark-out', '#mark-reset']) $<HTMLButtonElement>(id).disabled = on;
  };
  ui(true);
  let landmarker: PoseLandmarker | null = null;
  try {
    landmarker = await createLandmarker();
    const [a, b] = state.range;
    status('Midiendo los fotogramas por segundo del vídeo…');
    const av = await analysisVideo(video.src);
    const fps = await measureFps(av, a);
    status(`Analizando ${state.name} a ${fmt(fps, 1)} fps…`);
    const W = av.videoWidth;
    const H = av.videoHeight;
    // Imagen de trabajo pequeña para buscar el balón (rápido y suficiente).
    const cw = 400;
    const ch = Math.round((H / W) * cw);
    const work = new OffscreenCanvas(cw, ch);
    const ctx = work.getContext('2d', { willReadFrequently: true })!;
    const total = Math.max(1, Math.floor((b - a) * fps));
    const frames: CaptureFrame[] = [];
    let lastBall: { x: number; y: number; i: number } | null = null;
    const started = performance.now();
    for (let i = 0; i < total && !state.cancel; i++) {
      const t = a + i / fps;
      await seekVideo(av, t);
      const res = landmarker.detectForVideo(av, Math.round((i * 1000) / fps) + 1);
      const wl = res.worldLandmarks[0];
      const nl = res.landmarks[0];
      const frame: CaptureFrame = {
        t: i / fps,
        w: wl ? wl.map((p) => [p.x, p.y, p.z, p.visibility ?? 1].map((x) => Math.round(x * 1e4) / 1e4)) : null,
        n: nl ? nl.map((p) => [p.x, p.y].map((x) => Math.round(x * 1e5) / 1e5)) : null,
        ball: null,
      };
      // Balón: tamaño esperado según la escala del cuerpo en este fotograma.
      ctx.drawImage(av, 0, 0, cw, ch);
      const img = ctx.getImageData(0, 0, cw, ch);
      if (wl && nl) {
        const wp = (j: number) => new THREE.Vector3(wl[j]!.x, wl[j]!.y, wl[j]!.z);
        const ip = (j: number) => ({ x: nl[j]!.x * cw, y: nl[j]!.y * ch });
        const d2 = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
        const legM = wp(MP.hipL).distanceTo(wp(MP.knL)) + wp(MP.knL).distanceTo(wp(MP.anL));
        const legPx = d2(ip(MP.hipL), ip(MP.knL)) + d2(ip(MP.knL), ip(MP.anL));
        const radius = Math.max(2, (0.12 / legM) * legPx);
        const age = lastBall ? i - lastBall.i : Infinity;
        const hit = detectBall(img, {
          radius,
          last: lastBall && age < fps * 0.4 ? { x: lastBall.x, y: lastBall.y, age } : null,
          hands: [ip(MP.wrL), ip(MP.wrR)],
          head: ip(MP.nose),
          feet: [MP.anL, MP.anR, MP.toeL, MP.toeR, MP.heelL, MP.heelR].map(ip),
        });
        if (hit) {
          frame.ball = [hit.x / cw, hit.y / ch, hit.r / cw].map((x) => Math.round(x * 1e5) / 1e5) as [number, number, number];
          lastBall = { x: hit.x, y: hit.y, i };
        }
      }
      frames.push(frame);
      if (i % 4 === 0) {
        // El reproductor visible acompaña al análisis para ver por dónde va.
        video.currentTime = t;
        drawOverlay(frame);
      }
      const el = (performance.now() - started) / 1000;
      const eta = (el / (i + 1)) * (total - i - 1);
      $<HTMLProgressElement>('#progress').value = (i + 1) / total;
      $('#progress-text').textContent = `${i + 1}/${total} · quedan ${Math.ceil(eta)} s`;
      if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    if (state.cancel) {
      status('Análisis parado. No se ha guardado nada.');
      return;
    }
    const detected = frames.filter((f) => f.w).length;
    if (detected < frames.length * 0.5) throw new Error(`Solo se ha visto al jugador en ${detected} de ${frames.length} fotogramas. Prueba otro tramo o un vídeo con el cuerpo entero.`);
    const cap: Capture = {
      version: 1,
      name: state.name,
      fps,
      width: W,
      height: H,
      range: [a, a + frames.length / fps],
      frames,
      exaggerate: state.capture?.exaggerate ?? { ...DEFAULT_EXAGGERATE },
      feetLock: state.capture?.feetLock ?? true,
      // Los keyframes se conservan: se recolocan por tiempo en el nuevo análisis.
      ballKeys: (state.capture?.ballKeys ?? [])
        .map((k) => ({ ...k, f: Math.round((state.capture!.range[0] + k.f / state.capture!.fps - a) * fps) }))
        .filter((k) => k.f >= 0 && k.f < frames.length),
    };
    await api(`capture/${state.name}`, { method: 'PUT', body: JSON.stringify(cap) });
    loadCapture(cap);
    await refreshLibrary();
    status(`Analizado: ${frames.length} fotogramas a ${fmt(fps, 1)} fps · jugador en ${detected} · ${statsText()}. Ajusta y pulsa GUARDAR EN EL JUEGO.`, 'ok');
    seek(cap.range[0]);
  } catch (err) {
    status(`Error al analizar: ${(err as Error).message}`, 'bad');
    console.error(err);
  } finally {
    landmarker?.close();
    state.analyzing = false;
    setPlaying(false);
    ui(false);
    $<HTMLButtonElement>('#save').disabled = !state.capture;
    updateRangeUi();
  }
}
$('#analyze').onclick = () => void analyze();
$('#cancel').onclick = () => (state.cancel = true);

// --- Guardar -------------------------------------------------------------------------------
async function save() {
  if (!state.capture || !state.baked) return;
  state.capture.exaggerate = readSliders();
  const clip = { ...state.baked.clip, exaggerate: state.capture.exaggerate };
  try {
    await api(`capture/${state.name}`, { method: 'PUT', body: JSON.stringify(state.capture) });
    const r = await api<{ path: string }>(`clip/${state.name}`, { method: 'PUT', body: JSON.stringify(clip) });
    state.dirty = false;
    await refreshLibrary();
    status(`Guardado en ${r.path} (salto ×${fmt(clip.exaggerate.jump)}, movimiento ×${fmt(clip.exaggerate.pose)}).`, 'ok');
  } catch (err) {
    status(`No se pudo guardar: ${(err as Error).message}`, 'bad');
  }
}
$('#save').onclick = () => void save();

/** Landmarks limpios (antes del retargeting): se guardan junto a la captura y se descargan. */
async function exportLandmarks() {
  if (!state.capture || !state.baked) return;
  const json = JSON.stringify(landmarksJson(state.capture, state.baked));
  try {
    const r = await api<{ path: string }>(`landmarks/${state.name}`, { method: 'PUT', body: json });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `${state.name}-landmarks.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status(`Landmarks exportados: ${r.path} (${fmt(json.length / 1e6, 1)} MB, ${state.capture.frames.length} fotogramas × 33 puntos).`, 'ok');
  } catch (err) {
    status(`No se pudieron exportar: ${(err as Error).message}`, 'bad');
  }
}
$('#export').onclick = () => void exportLandmarks();

// --- Pies fijos ----------------------------------------------------------------------------
$('#feet').onclick = () => {
  if (!state.capture) return;
  state.capture.feetLock = !state.capture.feetLock;
  $('#feet').setAttribute('aria-pressed', String(state.capture.feetLock));
  rebake();
  markDirty(state.capture.feetLock ? 'Pies fijos activados (sin guardar).' : 'Pies fijos desactivados (sin guardar).');
};

// --- Keyframes del balón -------------------------------------------------------------------
const handSel = $<HTMLSelectElement>('#key-hand');
/** Fotograma de la captura que se está viendo (o −1 si fuera del tramo analizado). */
function currentFrame(): number {
  const cap = state.capture;
  if (!cap) return -1;
  const tc = video.currentTime - cap.range[0];
  if (tc < -0.02 || tc > cap.frames.length / cap.fps + 0.02) return -1;
  return Math.max(0, Math.min(cap.frames.length - 1, Math.round(tc * cap.fps)));
}
const keyAt = (f: number) => state.capture?.ballKeys?.find((k) => k.f === f) ?? null;
/** Índice dentro del clip recortado (lo que usan los datos horneados), o −1 si queda fuera del recorte. */
function bakedIndex(f: number): number {
  const b = state.baked;
  if (!b || f < 0) return -1;
  const i = f - b.f0;
  return i >= 0 && i < b.world.length ? i : -1;
}
const xyz = ['#key-x', '#key-y', '#key-z'].map((id) => $<HTMLInputElement>(id));
/** Posición 3D local del balón en este fotograma: la del keyframe o, si no hay, la actual (detectada/corregida). */
function ballLocalAt(f: number): [number, number, number] | null {
  const k = keyAt(f);
  const i = bakedIndex(f);
  if (k?.p) return k.p;
  if (i < 0 || !state.baked) return null;
  if (k) return state.baked.imageToLocal(i, k.x, k.y);
  return state.baked.ballLocal[i] ?? null;
}
function seekFrame(f: number) {
  const cap = state.capture;
  if (!cap) return;
  setPlaying(false);
  seek(cap.range[0] + f / cap.fps + 0.0005);
}
function renderKeys() {
  const bar = $('#range-bar');
  bar.querySelectorAll('.key').forEach((e) => e.remove());
  const cap = state.capture;
  const d = video.duration || 0;
  if (!cap || !d) return;
  for (const k of cap.ballKeys ?? []) {
    const el = document.createElement('div');
    el.className = 'key';
    el.style.left = `${((cap.range[0] + k.f / cap.fps) / d) * 100}%`;
    el.title = `Keyframe del balón · fotograma ${k.f + 1}`;
    el.onclick = () => seekFrame(k.f);
    bar.append(el);
  }
  updateKeyUi();
}
function updateKeyUi() {
  const n = state.capture?.ballKeys?.length ?? 0;
  const k = keyAt(currentFrame());
  $('#key-text').textContent = `${n} keyframe${n === 1 ? '' : 's'}${k ? ` · este fotograma tiene uno` : ''}`;
  handSel.value = k?.hand ?? 'auto';
  $<HTMLButtonElement>('#key-del').disabled = !k;
  const f = currentFrame();
  const p = ballLocalAt(f);
  xyz.forEach((inp, c) => {
    inp.disabled = !p || bakedIndex(f) < 0;
    if (document.activeElement !== inp) inp.value = p ? p[c]!.toFixed(2) : '';
  });
}
/** Pone (o mueve) el keyframe del fotograma actual en una posición 3D local (metros). */
function setKey3D(p: [number, number, number]) {
  const cap = state.capture;
  const f = currentFrame();
  const i = bakedIndex(f);
  if (!cap || i < 0 || !state.baked) {
    status('Este fotograma queda fuera del clip (recorte): muévete dentro para editar el balón.', 'bad');
    return;
  }
  p[1] = Math.max(0.12, p[1]); // el balón no atraviesa el suelo
  const im = state.baked.localToImage(i, p) ?? { x: 0.5, y: 0.5 };
  const k = keyAt(f);
  if (k) Object.assign(k, { x: im.x, y: im.y, p });
  else cap.ballKeys!.push({ f, x: im.x, y: im.y, p, hand: handSel.value as HandOverride } satisfies BallKey);
  queueRebake();
  markDirty('Balón corregido (sin guardar).');
}
/** Clic sobre el vídeo: mueve X/Y y conserva la profundidad (Z) que tuviera el keyframe. */
function setKey(x: number, y: number) {
  const f = currentFrame();
  const i = bakedIndex(f);
  if (i < 0 || !state.baked) return setKey3D([0, 0, 0]);
  const p = state.baked.imageToLocal(i, x, y, keyAt(f)?.p?.[2]);
  if (p) setKey3D(p);
}
xyz.forEach((inp, c) =>
  inp.addEventListener('change', () => {
    const p = ballLocalAt(currentFrame());
    const v = Number(inp.value);
    if (!p || !Number.isFinite(v)) return;
    const q: [number, number, number] = [...p];
    q[c] = v;
    setKey3D(q);
  }),
);
// Arrastrar las flechas de la vista 3D: de la escena a metros locales del balón.
gizmo.addEventListener('objectChange', () => {
  const b = state.baked;
  const i = bakedIndex(currentFrame());
  if (!b || i < 0) return;
  const w = vA.copy(keyHandle.position).sub(player.root.position).multiplyScalar(1 / (b.scale * RIG));
  setKey3D(b.worldToLocal(i, [w.x, w.y, w.z]));
});
function jumpKey(dir: 1 | -1) {
  const keys = state.capture?.ballKeys ?? [];
  const f = currentFrame();
  const k = dir > 0 ? keys.find((q) => q.f > f) : [...keys].reverse().find((q) => q.f < f);
  if (k) seekFrame(k.f);
}
function deleteKey() {
  const cap = state.capture;
  const k = keyAt(currentFrame());
  if (!cap || !k) return;
  cap.ballKeys = cap.ballKeys!.filter((q) => q !== k);
  rebake();
  markDirty('Keyframe borrado (sin guardar).');
}
function setEditing(on: boolean) {
  state.editing = on && !!state.capture;
  document.body.classList.toggle('editing', state.editing);
  $('#edit').setAttribute('aria-pressed', String(state.editing));
  gizmo.enabled = state.editing;
  if (state.editing) {
    setPlaying(false);
    status('Editar balón: clic/arrastrar sobre el vídeo (X/Y), flechas de la vista 3D (X/Y/Z) o las casillas X Y Z. ←/→ para moverte.');
  }
}
$('#edit').onclick = () => setEditing(!state.editing);
$('#key-prev').onclick = () => jumpKey(-1);
$('#key-next').onclick = () => jumpKey(1);
$('#key-del').onclick = deleteKey;
handSel.onchange = () => {
  const cap = state.capture;
  const f = currentFrame();
  if (!cap || f < 0) return;
  const k = keyAt(f);
  if (k) k.hand = handSel.value as HandOverride;
  else {
    // Sin keyframe aquí: se crea uno donde está ahora el balón (corregido o detectado).
    const p = ballLocalAt(f);
    const i = bakedIndex(f);
    const im = p && i >= 0 ? state.baked!.localToImage(i, p) : null;
    if (!p || !im) {
      status('Primero coloca el balón en este fotograma (Editar balón y clic sobre el vídeo).', 'bad');
      handSel.value = 'auto';
      return;
    }
    cap.ballKeys!.push({ f, x: im.x, y: im.y, p: [...p], hand: handSel.value as HandOverride });
  }
  rebake();
  markDirty('Mano del keyframe cambiada (sin guardar).');
};
/** Posición en la imagen (0–1) de un evento de ratón sobre el vídeo. */
function videoPoint(e: PointerEvent): { x: number; y: number } | null {
  const r = overlay.getBoundingClientRect();
  const s = Math.min(r.width / video.videoWidth, r.height / video.videoHeight);
  const w = video.videoWidth * s;
  const h = video.videoHeight * s;
  const x = (e.clientX - r.left - (r.width - w) / 2) / w;
  const y = (e.clientY - r.top - (r.height - h) / 2) / h;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}
let dragging = false;
overlay.addEventListener('pointerdown', (e) => {
  if (!state.editing) return;
  const p = videoPoint(e);
  if (!p) return;
  dragging = true;
  overlay.setPointerCapture(e.pointerId);
  setKey(p.x, p.y);
});
overlay.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const p = videoPoint(e);
  if (p) setKey(p.x, p.y);
});
overlay.addEventListener('pointerup', () => (dragging = false));

// --- Exageración ---------------------------------------------------------------------------
const jumpIn = $<HTMLInputElement>('#ex-jump');
const poseIn = $<HTMLInputElement>('#ex-pose');
const readSliders = () => ({ jump: Number(jumpIn.value), pose: Number(poseIn.value) });
function setSliders(jump: number, pose: number) {
  jumpIn.value = String(jump);
  poseIn.value = String(pose);
  onSliders(false);
}
function onSliders(user = true) {
  const e = readSliders();
  $('#ex-jump-v').textContent = `×${fmt(e.jump)}`;
  $('#ex-pose-v').textContent = `×${fmt(e.pose)}`;
  if (state.mocap) state.mocap.exaggerate = e;
  if (state.capture) state.capture.exaggerate = e;
  if (user && state.capture) {
    state.dirty = true;
    status('Cambios sin guardar: pulsa GUARDAR EN EL JUEGO para que el juego use esta exageración.');
  }
}
jumpIn.oninput = () => onSliders();
poseIn.oninput = () => onSliders();
$('#ex-reset').onclick = () => {
  setSliders(1, 1);
  onSliders();
};

// --- Tramo ---------------------------------------------------------------------------------
function updateRangeUi() {
  const d = video.duration || 0;
  const [a, b] = state.range;
  const cap = state.capture;
  const inside = cap && a >= cap.range[0] - 0.5 / cap.fps && b <= cap.range[1] + 0.5 / cap.fps;
  $('#range-text').textContent = !d
    ? ''
    : `Clip: ${fmt(a)}–${fmt(b)} s (${fmt(b - a)} s)` +
      (cap ? (inside ? ` · ${state.baked?.world.length ?? 0} fotogramas` : ' · ⚠ sale de lo analizado: pulsa ANALIZAR') : '');
  const bar = $('#bar-range');
  bar.style.left = `${d ? (a / d) * 100 : 0}%`;
  bar.style.width = `${d ? ((b - a) / d) * 100 : 0}%`;
  const done = $('#bar-done');
  const r = state.capture?.range;
  done.style.display = r ? '' : 'none';
  if (r && d) {
    done.style.left = `${(r[0] / d) * 100}%`;
    done.style.width = `${((r[1] - r[0]) / d) * 100}%`;
  }
}
/** Aplica inicio/fin: si cae dentro de lo analizado, recorta el clip al momento (sin volver a analizar). */
function applyRange() {
  const cap = state.capture;
  if (cap) {
    const tol = 0.5 / cap.fps;
    const [a, b] = state.range;
    if (a >= cap.range[0] - tol && b <= cap.range[1] + tol) {
      const whole = Math.abs(a - cap.range[0]) <= tol && Math.abs(b - cap.range[1]) <= tol;
      cap.trim = whole ? undefined : [Math.max(a, cap.range[0]), Math.min(b, cap.range[1])];
      rebake();
      markDirty(`Clip recortado a ${fmt(a)}–${fmt(b)} s (${state.baked!.world.length} fotogramas). Sin guardar.`);
    } else status(`El clip se sale de lo analizado (${fmt(cap.range[0])}–${fmt(cap.range[1])} s): pulsa ANALIZAR para analizar ${fmt(a)}–${fmt(b)} s.`);
  }
  updateRangeUi();
}
const markIn = () => {
  state.range[0] = Math.min(video.currentTime, state.range[1] - 0.2);
  applyRange();
};
const markOut = () => {
  state.range[1] = Math.max(video.currentTime, state.range[0] + 0.2);
  applyRange();
};
$('#mark-in').onclick = markIn;
$('#mark-out').onclick = markOut;
$('#mark-reset').onclick = () => {
  state.range = state.capture ? [...state.capture.range] : [0, video.duration || 0];
  applyRange();
};

// --- Reproducción --------------------------------------------------------------------------
let currentSpeed = 1;
function seek(t: number) {
  if (!video.duration) return;
  video.currentTime = Math.max(0, Math.min(video.duration - 0.001, t));
}
function setPlaying(on: boolean) {
  state.playing = on && !!video.src && !state.analyzing;
  playBtn.textContent = state.playing ? '❚❚ PAUSA' : '▶ PLAY';
  if (state.playing) void video.play();
  else video.pause();
}
video.loop = false;
video.addEventListener('timeupdate', () => {
  // Con captura, la reproducción va en bucle por el clip (recorte incluido).
  const r = state.baked?.range;
  if (state.playing && r && (video.currentTime >= r[1] || video.currentTime < r[0] - 0.05)) seek(r[0]);
});
video.addEventListener('ended', () => {
  if (state.playing) {
    seek(state.baked?.range[0] ?? 0);
    void video.play();
  }
});
playBtn.onclick = () => setPlaying(!state.playing);
scrub.oninput = () => {
  setPlaying(false);
  seek((Number(scrub.value) / 10000) * (video.duration || 0));
};
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => {
  b.onclick = () => {
    currentSpeed = Number(b.dataset.speed);
    video.playbackRate = currentSpeed;
    document.querySelectorAll('[data-speed]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
  };
});
const toggle = (id: string, key: 'skeleton' | 'overlay' | 'pixel' | 'clean', after?: () => void) => {
  const b = $<HTMLButtonElement>(id);
  b.onclick = () => {
    state[key] = !state[key];
    b.setAttribute('aria-pressed', String(state[key]));
    after?.();
  };
};
toggle('#skel', 'skeleton');
toggle('#ov', 'overlay');
toggle('#px', 'pixel', resize);
toggle('#clean', 'clean', () => {
  $('#clean').textContent = state.clean ? 'Limpio' : 'Sin limpiar';
  pickClip();
});
addEventListener('keydown', (e) => {
  // Escribiendo en un campo (nombre, X/Y/Z…) los atajos no cuentan.
  const el = e.target as HTMLElement;
  if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    setPlaying(!state.playing);
  } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    e.preventDefault();
    setPlaying(false);
    const fps = state.capture?.fps ?? 30;
    seek(video.currentTime + (e.code === 'ArrowRight' ? 1 : -1) / fps);
  } else if (e.code === 'KeyI') markIn();
  else if (e.code === 'KeyO') markOut();
  else if (e.code === 'KeyB') setEditing(!state.editing);
  else if (e.code === 'Comma') jumpKey(-1);
  else if (e.code === 'Period') jumpKey(1);
  else if (e.code === 'Delete' || e.code === 'Backspace') deleteKey();
  else if (e.code === 'Escape') setEditing(false);
});

// --- Cámaras -------------------------------------------------------------------------------
function setCam(kind: string) {
  // MediaPipe mide desde la cámara del vídeo, que en nuestros ejes está en +z mirando a −z.
  if (kind === 'video') camera.position.set(0, 1.6, 10.5);
  if (kind === 'tv') camera.position.set(4.5, 4.2, 9);
  if (kind === 'top') camera.position.set(0.01, 10, 0.5);
  controls.target.set(0, 1.3, 0);
  controls.update();
  document.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cam === kind)));
}
document.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) => (b.onclick = () => setCam(b.dataset.cam!)));
setCam('video');

function resize() {
  const r = canvas.parentElement!.getBoundingClientRect();
  const scale = state.pixel ? Math.max(2, Math.round(Math.min(r.width, r.height) / 220)) : 1;
  renderer.setPixelRatio(state.pixel ? 1 : Math.min(2, devicePixelRatio));
  renderer.setSize(Math.max(1, Math.ceil(r.width / scale)), Math.max(1, Math.ceil(r.height / scale)), false);
  canvas.style.width = `${r.width}px`;
  canvas.style.height = `${r.height}px`;
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
  const v = video.getBoundingClientRect();
  overlay.width = Math.round(v.width * devicePixelRatio);
  overlay.height = Math.round(v.height * devicePixelRatio);
}
new ResizeObserver(resize).observe(canvas.parentElement!);
new ResizeObserver(resize).observe(video);

// --- Dibujo --------------------------------------------------------------------------------
/** Esqueleto 2D y balón detectado encima del vídeo (para ver qué ha entendido MediaPipe). */
function drawOverlay(f: CaptureFrame | null, i = -1) {
  const ctx = overlay.getContext('2d')!;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!f || !state.overlay || !video.videoWidth) return;
  // object-fit: contain → zona real del vídeo dentro del elemento.
  const s = Math.min(overlay.width / video.videoWidth, overlay.height / video.videoHeight);
  const w = video.videoWidth * s;
  const h = video.videoHeight * s;
  const ox = (overlay.width - w) / 2;
  const oy = (overlay.height - h) / 2;
  const P = (x: number, y: number) => [ox + x * w, oy + y * h] as const;
  ctx.lineWidth = 2 * devicePixelRatio;
  if (f.n) {
    const pts = Object.values(MP);
    ctx.strokeStyle = '#6fe3ff';
    ctx.beginPath();
    for (const [a, b] of SKELETON_BONES) {
      const pa = f.n[pts[a]!]!;
      const pb = f.n[pts[b]!]!;
      ctx.moveTo(...P(pa[0]!, pa[1]!));
      ctx.lineTo(...P(pb[0]!, pb[1]!));
    }
    ctx.stroke();
  }
  // Amarillo discontinuo: lo detectado. Verde: corregido a mano (relleno si es un keyframe).
  const rad = Math.max(6 * devicePixelRatio, (f.ball?.[2] ?? 0.015) * w * 1.15);
  if (f.ball) {
    const [x, y] = P(f.ball[0], f.ball[1]);
    ctx.strokeStyle = '#f2c94c';
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.setLineDash([5 * devicePixelRatio, 4 * devicePixelRatio]);
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const bi = bakedIndex(i);
  const fixed = bi >= 0 ? state.baked?.ball2d[bi] : null;
  if (fixed && fixed.source !== 'det') {
    const [x, y] = P(fixed.x, fixed.y);
    ctx.strokeStyle = '#6fe3a0';
    ctx.lineWidth = 3 * devicePixelRatio;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.stroke();
    if (fixed.source === 'key') {
      ctx.fillStyle = '#6fe3a066';
      ctx.fill();
    }
  }
}

/** @param tc segundos dentro del clip · @param f fotograma del clip · @param fAbs fotograma de lo analizado */
function update3d(tc: number, f: number, fAbs = f) {
  const baked = state.clean ? state.baked : state.bakedRaw;
  const has = !!(state.mocap && baked);
  player.root.visible = has;
  ball.visible = has;
  $('#empty').style.display = has || !video.src ? 'none' : '';
  skeleton.visible = has && state.skeleton;
  updateHandle(fAbs);
  if (!has) return;
  player.root.position.x = state.skeleton ? -0.75 : 0;
  skeleton.position.x = 0.75;
  $('#tag3d').textContent = state.skeleton ? 'RIG DEL JUEGO  ·  ESQUELETO MEDIAPIPE' : 'RIG DEL JUEGO';

  const m = state.mocap!.sample(tc, sample);
  // Pies clavados (mundo) = posición del jugador + objetivo del clip.
  footL.copy(m.footL).multiplyScalar(RIG).add(player.root.position);
  footR.copy(m.footR).multiplyScalar(RIG).add(player.root.position);
  player.applyPose(m.pose, m.yaw, m.lift * RIG, {
    offset: offset.copy(m.root).multiplyScalar(RIG),
    footL,
    footR,
    footWL: m.footWL,
    footWR: m.footWR,
  });
  // La cámara acompaña al jugador cuando se desplaza (sin perder el ángulo que haya puesto el usuario).
  const body = vB.copy(offset).add(player.root.position).setY(0);
  const move = vC.subVectors(body, lastBody);
  if (move.lengthSq() < 4) {
    camera.position.add(move);
    controls.target.add(move);
  }
  lastBody.copy(body);
  skeleton.position.set(0.75, 0, 0);

  // Balón: suelto donde se vio en el vídeo; en la mano, pegado a la palma del rig.
  const free = vA.copy(m.ball).multiplyScalar(RIG).add(player.root.position);
  const hold = Math.min(1, m.holdL + m.holdR);
  if (hold > 0.001) {
    player.palms(vB, vC);
    const palm = vB.multiplyScalar(m.holdL).addScaledVector(vC, m.holdR).multiplyScalar(1 / (m.holdL + m.holdR));
    const dir = vC.subVectors(free, palm);
    if (dir.lengthSq() < 1e-6) dir.set(0, -1, 0);
    const held = dir.normalize().multiplyScalar(BALL_R).add(palm);
    free.lerp(held, hold);
  }
  free.y = Math.max(BALL_R, free.y);
  ball.position.copy(free);

  // Esqueleto de MediaPipe.
  const pts = baked!.skeleton[f]!;
  SKELETON_BONES.forEach(([a, b], k) => {
    skelPos.set(pts.slice(a * 3, a * 3 + 3), k * 6);
    skelPos.set(pts.slice(b * 3, b * 3 + 3), k * 6 + 3);
  });
  skelGeo.attributes.position!.needsUpdate = true;
  skelGeo.computeBoundingSphere();
  const bm = baked!.ballMeters[f];
  skelBall.visible = !!bm;
  if (bm) skelBall.position.set(bm[0]!, bm[1]!, bm[2]!);

  const src = baked!.ball2d[f]?.source;
  const seen = { det: 'visto', key: 'keyframe', interp: 'interpolado', fix: 'corregido' }[src ?? 'det'];
  const where = hold > 0.5 ? (m.holdL > m.holdR ? 'mano izq.' : 'mano der.') : 'suelto';
  const feet = [m.footWL > 0.5 ? 'izq.' : '', m.footWR > 0.5 ? 'der.' : ''].filter(Boolean).join(' + ') || 'ninguno';
  const out = bakedIndex(fAbs) < 0 ? ' · FUERA DEL CLIP (recortado)' : '';
  $('#info').textContent = `fotograma ${f + 1}/${baked!.world.length}${out} · balón ${src ? seen : 'no visto'} (${where}) · salto ${Math.round(m.lift * RIG * 100)} cm · apoyo: ${feet}`;
}

/** Coloca el asa del keyframe (y sus flechas X/Y/Z) donde está el balón en este fotograma. */
function updateHandle(fAbs: number) {
  const b = state.baked;
  const i = bakedIndex(fAbs);
  const p = state.editing && b && i >= 0 ? ballLocalAt(fAbs) : null;
  keyHandle.visible = gizmoHelper.visible = !!p;
  gizmo.enabled = !!p;
  if (!p || gizmo.dragging) return;
  const w = b!.localToWorld(i, p);
  keyHandle.position.set(w[0], w[1], w[2]).multiplyScalar(b!.scale * RIG).add(player.root.position);
}

function frame() {
  const d = video.duration || 0;
  const t = video.currentTime;
  $('#time').textContent = `${fmt(t)} / ${fmt(d)} s`;
  if (document.activeElement !== scrub && d) scrub.value = String(Math.round((t / d) * 10000));

  const cap = state.capture;
  if (cap && !state.analyzing) {
    const tc = Math.max(0, Math.min(cap.frames.length / cap.fps - 1e-3, t - cap.range[0]));
    const f = Math.min(cap.frames.length - 1, Math.round(tc * cap.fps));
    const inside = t >= cap.range[0] - 0.02 && t <= cap.range[1] + 0.02;
    if (f !== lastOverlayFrame || !inside) {
      drawOverlay(inside ? cap.frames[f]! : null, f);
      updateKeyUi();
    }
    lastOverlayFrame = inside ? f : -2;
    // El 3D va por el clip recortado (fuera del recorte se queda en su primer/último fotograma).
    const b = state.baked!;
    const tb = Math.max(0, Math.min(b.world.length / cap.fps - 1e-3, t - b.range[0]));
    update3d(tb, Math.min(b.world.length - 1, Math.round(tb * cap.fps)), f);
  } else if (!state.analyzing) {
    update3d(0, 0);
    drawOverlay(null);
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// --- Arranque ------------------------------------------------------------------------------
addEventListener('beforeunload', (e) => {
  if (state.dirty || state.analyzing) e.preventDefault();
});
resize();
requestAnimationFrame(frame);
await refreshLibrary();
const want = new URLSearchParams(location.search).get('c');
if (want && library.some((i) => i.name === want)) await open(want);
else if (library[0]) await open(library[0].name);
if (import.meta.env.DEV) Object.assign(window, { __studio: { state, analyze, save, seek, setPlaying, seekFrame, setKey, setKey3D, exportLandmarks, setEditing, applyRange, keyHandle, gizmo, player } });
