/**
 * Estudio de mocap (local, independiente del juego): vídeo → MediaPipe Pose en el navegador → balón →
 * animación para el rig de referencia (@brawl/mocap). Arrancar con `npm run studio` (puerto 5190).
 * La parte que guarda en disco está en apps/studio/studio-server.ts.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import {
  applyPoseKeys,
  bakeCapture,
  DEFAULT_EXAGGERATE,
  detectBall,
  landmarksJson,
  MocapClip,
  MP,
  SKELETON_BONES,
  type Baked,
  type BallKey,
  type Capture,
  type CaptureFrame,
  type HandOverride,
  type PoseKey,
} from '@brawl/mocap';
import { createMannequin } from './mannequin';

declare const __MP_WASM__: string;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const video = $<HTMLVideoElement>('#video');
const overlay = $<HTMLCanvasElement>('#overlay');
const canvas = $<HTMLCanvasElement>('#view');
const timeline = $('#timeline');
const playBtn = $<HTMLButtonElement>('#play');
const fmt = (x: number, d = 2) => x.toFixed(d).replace('.', ',');

function status(text: string, kind: '' | 'ok' | 'bad' = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = kind;
}

// --- Escena 3D: neutra (suelo con cuadrícula), sin nada del juego ---------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d222b);
scene.fog = new THREE.Fog(0x1d222b, 14, 30);
const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 48), new THREE.MeshStandardMaterial({ color: 0x2a313d, roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(20, 40, 0x56627a, 0x384152); // cuadros de 0,5 m
grid.position.y = 0.002;
scene.add(grid);
scene.add(new THREE.HemisphereLight(0xe6ecff, 0x30343c, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(-3, 9, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 5, bottom: -4, near: 1, far: 30 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 2;
controls.maxDistance = 25;
controls.maxPolarAngle = Math.PI / 2 - 0.02;

// Maniquí con el rig de referencia (2,00 m).
const player = createMannequin();
player.root.visible = false;
scene.add(player.root);
const RIG_M = player.height / 2; // unidades del rig → metros

// Balón (del tamaño con que se ve en el juego: 1,6× el real).
const BALL_R = 0.19;
const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(BALL_R, 2), new THREE.MeshStandardMaterial({ color: 0xe8742c, roughness: 0.8, flatShading: true }));
ball.castShadow = true;
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

// Aros para girar la articulación elegida (editar pose).
const poseGizmo = new TransformControls(camera, canvas);
poseGizmo.setMode('rotate');
poseGizmo.setSpace('local');
poseGizmo.setSize(0.7);
poseGizmo.enabled = false;
const poseGizmoHelper = poseGizmo.getHelper();
poseGizmoHelper.visible = false;
scene.add(poseGizmoHelper);
poseGizmo.addEventListener('dragging-changed', (e) => (controls.enabled = !e.value));
const JOINT_NAMES = ['tronco', 'cadera izq.', 'rodilla izq.', 'cadera der.', 'rodilla der.', 'hombro izq.', 'codo izq.', 'hombro der.', 'codo der.'];

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
  pixel: false,
  playing: false,
  /** Inicio y fin del clip (segundos del vídeo): recorta lo analizado o marca qué analizar. */
  range: [0, 0] as [number, number],
  analyzing: false,
  cancel: false,
  dirty: false,
  editing: false,
  /** Editar la pose: girar articulaciones del maniquí con aros. */
  poseEdit: false,
  /** Articulación elegida (índice en SLOTS) o −1. */
  joint: -1,
  /** Mostrar el desplazamiento por el suelo (por defecto no: anima en el sitio, como un bucle). */
  travel: false,
  /** fps del vídeo medidos al abrirlo (antes de analizar); con captura mandan los de la captura. */
  videoFps: 30,
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
      const tag = it.clip ? 'clip guardado' : it.capture ? 'analizada' : it.video ? 'sin analizar' : 'sin vídeo';
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
  setPoseEdit(false);
  state.joint = -1;
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
  // fps del vídeo en segundo plano (para numerar fotogramas antes de analizar).
  if (it.video) {
    const src = it.video;
    void analysisVideo(src)
      .then((v) => measureFps(v, 0))
      .then((fps) => {
        if (video.src.endsWith(src)) state.videoFps = fps;
        renderTicks();
      })
      .catch(() => {});
  }
  $<HTMLButtonElement>('#dup').disabled = !it.video;
  $<HTMLButtonElement>('#ren').disabled = false;
  $<HTMLButtonElement>('#del').disabled = false;
  showSideForm(null);
  if (it.capture) {
    const cap = await api<Capture>(`capture/${name}`);
    const draft = await restoreDraft(cap);
    loadCapture(cap);
    if (draft) {
      state.dirty = true;
      const at = draft.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      status(`Recuperados los cambios sin guardar de las ${at} (${cap.ballKeys?.length ?? 0} keyframes, salto ×${fmt(cap.exaggerate.jump)}). Pulsa GUARDAR CLIP para conservarlos.`, 'ok');
    } else status(`${name}: clip de ${state.baked!.world.length} fotogramas a ${fmt(cap.fps, 1)} fps · ${statsText()}`, 'ok');
  } else status(it.video ? `${name}: sin analizar. Marca el tramo (opcional) y pulsa ANALIZAR.` : `${name}: falta el vídeo.`);
  seek(state.range[0]);
  updateRangeUi();
  renderTicks();
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
  renderTicks();
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
function markDirty(msg = 'Cambios sin guardar: pulsa GUARDAR CLIP.') {
  state.dirty = true;
  status(msg);
  queueDraft();
}

// --- Borrador automático -------------------------------------------------------------------
// Lo editable de una captura se guarda al momento en disco (data/<nombre>/borrador.json): si la página se
// recarga o se cierra sin GUARDAR, al volver a abrir la captura se recupera, en este u otro navegador.
type Draft = Pick<Capture, 'ballKeys' | 'poseKeys' | 'exaggerate' | 'feetLock' | 'trim'> & { at: number; analysis: string };
/** Huella del análisis: el borrador solo vale para el mismo análisis. */
const analysisId = (c: Capture) => `${c.range[0].toFixed(4)}|${c.range[1].toFixed(4)}|${c.fps.toFixed(3)}|${c.frames.length}`;
let draftTimer = 0;
function queueDraft() {
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => void saveDraft(), 250);
}
async function saveDraft() {
  const c = state.capture;
  if (!c || !state.dirty) return;
  const d: Draft = { at: Date.now(), analysis: analysisId(c), ballKeys: c.ballKeys, poseKeys: c.poseKeys, exaggerate: c.exaggerate, feetLock: c.feetLock, trim: c.trim };
  try {
    await api(`draft/${state.name}`, { method: 'PUT', body: JSON.stringify(d) });
  } catch {
    /* sin servidor: no hay borrador, pero no se interrumpe el trabajo */
  }
}
function clearDraft(name = state.name) {
  clearTimeout(draftTimer);
  if (name) void api(`draft/${name}`, { method: 'DELETE' }).catch(() => {});
}
/** Si hay un borrador de esta captura (del mismo análisis), lo aplica y devuelve cuándo se hizo. */
async function restoreDraft(c: Capture): Promise<Date | null> {
  try {
    const d = await api<Draft | null>(`draft/${c.name}`);
    if (!d || d.analysis !== analysisId(c)) return null;
    c.ballKeys = d.ballKeys ?? [];
    c.exaggerate = d.exaggerate ?? c.exaggerate;
    c.feetLock = d.feetLock ?? true;
    c.trim = d.trim;
    c.poseKeys = d.poseKeys ?? [];
    return new Date(d.at);
  } catch {
    return null; // no hay borrador
  }
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
  try {
    await saveCaptureOnly(); // que la copia lleve los últimos cambios
    await api(`duplicate/${state.name}`, { method: 'POST', body: JSON.stringify({ to }) });
    $('#dup-form').classList.remove('show');
    await refreshLibrary();
    await open(to);
    status(`Copia creada: ${to}. Marca otro inicio/fin (o analiza otra parte del vídeo) para sacar otro clip.`, 'ok');
  } catch (err) {
    status(`No se pudo duplicar: ${(err as Error).message}`, 'bad');
  }
};

/** Guarda en disco los cambios pendientes de la captura (no el clip del juego). */
async function saveCaptureOnly() {
  if (!state.dirty || !state.capture) return;
  await api(`capture/${state.name}`, { method: 'PUT', body: JSON.stringify(state.capture) });
  state.dirty = false;
  clearDraft();
}
const sideForms = ['#dup-form', '#ren-form', '#del-form'];
function showSideForm(id: string | null) {
  for (const f of sideForms) $(f).classList.toggle('show', f === id);
}

// --- Renombrar -------------------------------------------------------------------------------
$('#ren').onclick = () => {
  if (!state.name) return;
  $<HTMLInputElement>('#ren-name').value = state.name;
  showSideForm('#ren-form');
  $<HTMLInputElement>('#ren-name').select();
};
$('#ren-cancel').onclick = () => showSideForm(null);
$<HTMLFormElement>('#ren-form').onsubmit = async (e) => {
  e.preventDefault();
  const from = state.name;
  const to = $<HTMLInputElement>('#ren-name').value.trim();
  if (!from || to === from) return showSideForm(null);
  try {
    await saveCaptureOnly(); // los cambios pendientes viajan con ella
    await api(`rename/${from}`, { method: 'POST', body: JSON.stringify({ to }) });
    showSideForm(null);
    await refreshLibrary();
    await open(to);
    status(`Renombrada: ${from} → ${to}${library.find((i) => i.name === to)?.clip ? ` (su clip del juego ahora es ${to}.json)` : ''}.`, 'ok');
  } catch (err) {
    status(`No se pudo renombrar: ${(err as Error).message}`, 'bad');
  }
};

// --- Eliminar --------------------------------------------------------------------------------
$('#del').onclick = () => {
  if (!state.name) return;
  const it = library.find((i) => i.name === state.name);
  $('#del-text').textContent = `¿Eliminar «${state.name}»? Se mueve a tools/video-mocap/data/.papelera/ (se puede recuperar).`;
  $('#del-clip-row').style.display = it?.clip ? '' : 'none';
  $<HTMLInputElement>('#del-clip').checked = true;
  $('#del-clip-text').textContent = `Quitar también su clip del juego (${state.name}.json)`;
  showSideForm('#del-form');
};
$('#del-cancel').onclick = () => showSideForm(null);
$<HTMLFormElement>('#del-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = state.name;
  if (!name) return;
  const clip = $<HTMLInputElement>('#del-clip').checked && !!library.find((i) => i.name === name)?.clip;
  try {
    const r = await api<{ bin: string }>(`delete/${name}`, { method: 'POST', body: JSON.stringify({ clip }) });
    clearDraft(name);
    state.dirty = false;
    showSideForm(null);
    await refreshLibrary();
    if (library[0]) await open(library[0].name);
    else closeCapture();
    status(`«${name}» eliminada${clip ? ' (con su clip del juego)' : ''}. Está en ${r.bin} por si la necesitas.`, 'ok');
  } catch (err) {
    status(`No se pudo eliminar: ${(err as Error).message}`, 'bad');
  }
};

/** Sin ninguna captura abierta. */
function closeCapture() {
  setPlaying(false);
  setEditing(false);
  setPoseEdit(false);
  state.joint = -1;
  state.name = '';
  state.capture = null;
  state.baked = state.bakedRaw = null;
  state.mocap = null;
  video.removeAttribute('src');
  video.load();
  for (const id of ['#dup', '#ren', '#del', '#save', '#export']) $<HTMLButtonElement>(id).disabled = true;
  history.replaceState(null, '', location.pathname);
  renderKeys();
  updateRangeUi();
  drawOverlay(null);
  status('No hay capturas: abre un vídeo para empezar.');
}

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
      poseKeys: (state.capture?.poseKeys ?? [])
        .map((k) => ({ ...k, f: Math.round((state.capture!.range[0] + k.f / state.capture!.fps - a) * fps) }))
        .filter((k) => k.f >= 0 && k.f < frames.length),
      ballKeys: (state.capture?.ballKeys ?? [])
        .map((k) => ({ ...k, f: Math.round((state.capture!.range[0] + k.f / state.capture!.fps - a) * fps) }))
        .filter((k) => k.f >= 0 && k.f < frames.length),
    };
    await api(`capture/${state.name}`, { method: 'PUT', body: JSON.stringify(cap) });
    clearDraft(); // el análisis nuevo ya lleva los keyframes y ajustes
    loadCapture(cap);
    await refreshLibrary();
    status(`Analizado: ${frames.length} fotogramas a ${fmt(fps, 1)} fps · jugador en ${detected} · ${statsText()}. Ajusta y pulsa GUARDAR CLIP.`, 'ok');
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
    clearDraft();
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
  const box = $('#tl-keys');
  box.replaceChildren();
  const cap = state.capture;
  const d = video.duration || 0;
  if (!cap || !d) return;
  for (const k of cap.ballKeys ?? []) {
    const el = document.createElement('div');
    el.className = 'tl-key';
    const t = cap.range[0] + k.f / cap.fps;
    el.style.left = `${(t / d) * 100}%`;
    el.title = `Keyframe del balón · fotograma ${frameAt(t) + 1}`;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      seekFrame(k.f);
    });
    box.append(el);
  }
  // Correcciones de pose: rombos morados (uno por fotograma, aunque haya varias articulaciones).
  for (const f of new Set((cap.poseKeys ?? []).map((k) => k.f))) {
    const el = document.createElement('div');
    el.className = 'tl-key pose';
    const t = cap.range[0] + f / cap.fps;
    el.style.left = `${(t / d) * 100}%`;
    const which = cap.poseKeys!.filter((k) => k.f === f).map((k) => JOINT_NAMES[k.slot]);
    el.title = `Pose corregida · fotograma ${frameAt(t) + 1}: ${which.join(', ')}`;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      seekFrame(f);
    });
    box.append(el);
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
  updatePoseUi();
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
  const w = vA.copy(keyHandle.position).sub(player.root.position).multiplyScalar(1 / (b.scale * RIG_M));
  setKey3D(state.travel ? b.worldToLocal(i, [w.x, w.y, w.z]) : [w.x, w.y, w.z]);
});
function jumpKey(dir: 1 | -1) {
  if (state.poseEdit) return jumpPoseKey(dir);
  const keys = state.capture?.ballKeys ?? [];
  const f = currentFrame();
  const k = dir > 0 ? keys.find((q) => q.f > f) : [...keys].reverse().find((q) => q.f < f);
  if (k) seekFrame(k.f);
}
function deleteKey() {
  if (state.poseEdit) return deletePoseKey();
  const cap = state.capture;
  const k = keyAt(currentFrame());
  if (!cap || !k) return;
  cap.ballKeys = cap.ballKeys!.filter((q) => q !== k);
  rebake();
  markDirty('Keyframe borrado (sin guardar).');
}
function setEditing(on: boolean) {
  if (on) setPoseEdit(false);
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

// --- Editar pose: girar articulaciones ------------------------------------------------------
/** Correcciones de pose dentro del clip (contadas desde su inicio), para reaplicarlas rápido. */
function clipPoseKeys(): PoseKey[] {
  const b = state.baked;
  const cap = state.capture;
  if (!b || !cap) return [];
  const n = b.world.length;
  return (cap.poseKeys ?? []).filter((k) => k.f >= b.f0 && k.f < b.f0 + n).map((k) => ({ ...k, f: k.f - b.f0 }));
}
/** Reaplica las correcciones de pose sin rehornear todo (rápido, para usar mientras se gira). */
function refreshPose() {
  const cap = state.capture;
  if (!cap) return;
  const keys = clipPoseKeys();
  for (const b of [state.baked, state.bakedRaw]) if (b) b.clip.frames = applyPoseKeys(b.baseFrames, keys, cap.fps);
  pickClip();
}
const poseKeyAt = (f: number, slot: number) => state.capture?.poseKeys?.find((k) => k.f === f && k.slot === slot) ?? null;
function selectJoint(slot: number) {
  state.joint = slot;
  player.highlight(slot);
  if (slot >= 0) poseGizmo.attach(player.joints[slot]!);
  else poseGizmo.detach();
  poseGizmoHelper.visible = slot >= 0 && state.poseEdit;
  poseGizmo.enabled = slot >= 0 && state.poseEdit;
  updatePoseUi();
  if (slot >= 0 && (slot === 1 || slot === 2 || slot === 3 || slot === 4) && state.capture?.feetLock)
    status(`${JOINT_NAMES[slot]}: con «Pies fijos» la pierna se reajusta para que el pie apoyado no se mueva (gira la articulación con el pie en el aire, o desactiva Pies fijos).`);
  else if (slot >= 0) status(`${JOINT_NAMES[slot]}: gira los aros para corregirla en este fotograma.`);
}
function setPoseEdit(on: boolean) {
  if (on) setEditing(false);
  state.poseEdit = on && !!state.capture;
  document.body.classList.toggle('posing', state.poseEdit);
  $('#pose').setAttribute('aria-pressed', String(state.poseEdit));
  if (state.poseEdit) {
    setPlaying(false);
    status('Editar pose: haz clic en una parte del maniquí (tronco, hombro, codo, cadera, rodilla) y gira los aros. ←/→ para moverte.');
    selectJoint(state.joint);
  } else {
    poseGizmo.detach();
    poseGizmo.enabled = false;
    poseGizmoHelper.visible = false;
    player.highlight(-1);
  }
  updatePoseUi();
}
function updatePoseUi() {
  const cap = state.capture;
  const n = cap?.poseKeys?.length ?? 0;
  const k = state.joint >= 0 ? poseKeyAt(currentFrame(), state.joint) : null;
  $('#pose-text').textContent =
    `${state.joint >= 0 ? JOINT_NAMES[state.joint] : 'ninguna articulación'} · ${n} correcci${n === 1 ? 'ón' : 'ones'}` + (k ? ' · corregida en este fotograma' : '');
  $<HTMLButtonElement>('#pose-del').disabled = !k;
}
function jumpPoseKey(dir: 1 | -1) {
  const f = currentFrame();
  const keys = (state.capture?.poseKeys ?? []).filter((k) => state.joint < 0 || k.slot === state.joint).map((k) => k.f);
  const g = dir > 0 ? Math.min(...keys.filter((x) => x > f)) : Math.max(...keys.filter((x) => x < f));
  if (Number.isFinite(g)) seekFrame(g);
}
function deletePoseKey() {
  const cap = state.capture;
  const k = state.joint >= 0 ? poseKeyAt(currentFrame(), state.joint) : null;
  if (!cap || !k) return;
  cap.poseKeys = cap.poseKeys!.filter((q) => q !== k);
  refreshPose();
  renderKeys();
  updatePoseUi();
  markDirty(`Corrección de ${JOINT_NAMES[k.slot]} quitada (sin guardar).`);
}
$('#pose').onclick = () => setPoseEdit(!state.poseEdit);
$('#pose-del').onclick = deletePoseKey;

// Clic en el maniquí (sin arrastrar y sin tocar los aros): elegir articulación.
const ray = new THREE.Raycaster();
let downAt: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointerup', (e) => {
  if (!state.poseEdit || !downAt || poseGizmo.dragging || poseGizmo.axis) return;
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return; // era un giro de cámara
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const slot = player.pickJoint(ray);
  if (slot >= 0 || state.joint >= 0) selectJoint(slot);
});

// Girar los aros: la corrección es el giro hecho desde que se empezó a arrastrar, encima de la que hubiera.
let dragStart: { display: THREE.Quaternion; key: THREE.Quaternion; f: number; slot: number } | null = null;
poseGizmo.addEventListener('mouseDown', () => {
  const f = currentFrame();
  if (state.joint < 0 || bakedIndex(f) < 0) return;
  const k = poseKeyAt(f, state.joint);
  dragStart = {
    display: player.joints[state.joint]!.quaternion.clone(),
    key: k ? new THREE.Quaternion().fromArray(k.q) : new THREE.Quaternion(),
    f,
    slot: state.joint,
  };
});
poseGizmo.addEventListener('mouseUp', () => {
  dragStart = null;
  renderKeys();
  updatePoseUi();
});
poseGizmo.addEventListener('objectChange', () => {
  const cap = state.capture;
  if (!cap || !dragStart) return;
  const turn = dragStart.display.clone().invert().multiply(player.joints[dragStart.slot]!.quaternion);
  const q = dragStart.key.clone().multiply(turn).normalize();
  const arr: [number, number, number, number] = [q.x, q.y, q.z, q.w];
  cap.poseKeys ??= [];
  const k = poseKeyAt(dragStart.f, dragStart.slot);
  if (k) k.q = arr;
  else cap.poseKeys.push({ f: dragStart.f, slot: dragStart.slot, q: arr });
  refreshPose();
  markDirty(`${JOINT_NAMES[dragStart.slot]} corregida en el fotograma ${frameAt(video.currentTime) + 1} (sin guardar).`);
});
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
  if (user && state.capture) markDirty('Cambios sin guardar: pulsa GUARDAR CLIP para que el clip lleve esta exageración.');
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
  renderTimeline();
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
  state.range[0] = Math.min(timeOf(frameAt(video.currentTime)), state.range[1] - 0.2);
  applyRange();
};
const markOut = () => {
  state.range[1] = Math.max(timeOf(frameAt(video.currentTime)), state.range[0] + 0.2);
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
// --- Línea de tiempo ------------------------------------------------------------------------
/**
 * Fotogramas: se numeran desde el inicio del vídeo, sobre la misma rejilla que el análisis
 * (inicio de lo analizado + i / fps), para que "fotograma N" sea siempre el mismo.
 */
const fpsNow = () => state.capture?.fps ?? state.videoFps;
const gridBase = () => state.capture?.range[0] ?? 0;
const frameAt = (t: number) => Math.max(0, Math.round(gridBase() * fpsNow()) + Math.round((t - gridBase()) * fpsNow()));
const timeOf = (idx: number) => gridBase() + (idx - Math.round(gridBase() * fpsNow())) / fpsNow();
const totalFrames = () => Math.max(1, Math.floor((video.duration || 0) * fpsNow()));
/** Salta a un fotograma exacto (un pelín después de su instante, para que el navegador muestre ese y no el anterior). */
function seekToFrame(idx: number) {
  seek(timeOf(Math.max(0, Math.min(totalFrames() - 1, idx))) + 0.0005);
}
const pct = (t: number) => `${(t / (video.duration || 1)) * 100}%`;
let drag: 'head' | 'in' | 'out' | null = null;

function renderTicks() {
  const box = $('#tl-ticks');
  box.replaceChildren();
  const d = video.duration || 0;
  if (!d) return;
  const fps = fpsNow();
  const w = timeline.getBoundingClientRect().width;
  // Una marca por fotograma si caben (≥ 4 px); si no, cada 5, 10, 15 o 30.
  const step = [1, 5, 10, 15, 30].find((n) => (w / (d * fps)) * n >= 4) ?? Math.round(fps);
  const frag = document.createDocumentFragment();
  for (let i = 0; i <= d * fps; i += step) {
    const el = document.createElement('i');
    const t = i / fps;
    if (Math.abs(t - Math.round(t)) < 0.5 / fps) el.className = 'big';
    el.style.left = pct(t);
    frag.append(el);
  }
  box.append(frag);
}
new ResizeObserver(renderTicks).observe(timeline);

function renderTimeline() {
  const d = video.duration || 0;
  const [a, b] = state.range;
  const cap = state.capture;
  const show = (id: string, on: boolean) => ($(id).style.display = on ? '' : 'none');
  show('#tl-in', !!d);
  show('#tl-out', !!d);
  if (!d) return;
  $('#tl-in').style.left = pct(a);
  $('#tl-out').style.left = pct(b);
  const clip = $('#tl-clip');
  clip.style.left = pct(a);
  clip.style.width = pct(b - a);
  $('#tl-dim-l').style.cssText = `left:0;width:${pct(a)}`;
  $('#tl-dim-r').style.cssText = `left:${pct(b)};right:0`;
  const an = $('#tl-analyzed');
  show('#tl-analyzed', !!cap);
  if (cap) {
    an.style.left = pct(cap.range[0]);
    an.style.width = pct(cap.range[1] - cap.range[0]);
  }
}

/** Cabezal y textos de tiempo: fotograma exacto en el que estamos. */
function renderHead() {
  const d = video.duration || 0;
  const t = video.currentTime;
  const idx = frameAt(t);
  $('#tl-head').style.left = pct(t);
  const label = $('#tl-label');
  label.style.left = pct(t);
  label.textContent = `fotograma ${idx + 1}`;
  const clipIdx = state.capture && state.baked ? bakedIndex(currentFrame()) : -1;
  $('#time').innerHTML =
    `<b>fotograma ${idx + 1}</b> / ${totalFrames()} · ${fmt(t, 3)} / ${fmt(d)} s` +
    (state.baked ? ` · clip ${clipIdx >= 0 ? `${clipIdx + 1}/${state.baked.world.length}` : 'fuera'}` : '');
}

/** Tiempo (ajustado al fotograma) bajo el ratón. */
function timelineFrame(e: PointerEvent): number {
  const r = timeline.getBoundingClientRect();
  const u = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  return Math.max(0, Math.min(totalFrames() - 1, frameAt(u * (video.duration || 0))));
}
function dragTo(e: PointerEvent) {
  const idx = timelineFrame(e);
  const t = timeOf(idx);
  const minLen = 0.2;
  if (drag === 'head') return seekToFrame(idx);
  if (drag === 'in') state.range[0] = Math.max(0, Math.min(t, state.range[1] - minLen));
  if (drag === 'out') state.range[1] = Math.min(video.duration || t, Math.max(t, state.range[0] + minLen));
  // Mientras se arrastra un indicador, el vídeo enseña ese fotograma.
  const edge = drag === 'in' ? state.range[0] : state.range[1];
  seek(edge + 0.0005);
  const hl = $('#tl-hlabel');
  hl.classList.remove('hidden');
  hl.style.left = pct(edge);
  hl.textContent = `${drag === 'in' ? 'inicio' : 'fin'}: fotograma ${frameAt(edge) + 1}`;
  updateRangeUi();
}
timeline.addEventListener('pointerdown', (e) => {
  if (!video.duration || state.analyzing) return;
  const target = e.target as HTMLElement;
  drag = target.id === 'tl-in' ? 'in' : target.id === 'tl-out' ? 'out' : 'head';
  setPlaying(false);
  try {
    timeline.setPointerCapture(e.pointerId);
  } catch {
    /* puntero no capturable (p. ej. evento sintético): se sigue igual */
  }
  dragTo(e);
});
timeline.addEventListener('pointermove', (e) => drag && dragTo(e));
const endDrag = () => {
  if (!drag) return;
  const was = drag;
  drag = null;
  $('#tl-hlabel').classList.add('hidden');
  if (was !== 'head') applyRange(); // al soltar un indicador se recorta el clip
};
timeline.addEventListener('pointerup', endDrag);
timeline.addEventListener('pointercancel', endDrag);
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => {
  b.onclick = () => {
    currentSpeed = Number(b.dataset.speed);
    video.playbackRate = currentSpeed;
    document.querySelectorAll('[data-speed]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
  };
});
const toggle = (id: string, key: 'skeleton' | 'overlay' | 'pixel' | 'clean' | 'travel', after?: () => void) => {
  const b = $<HTMLButtonElement>(id);
  b.onclick = () => {
    state[key] = !state[key];
    b.setAttribute('aria-pressed', String(state[key]));
    after?.();
  };
};
toggle('#skel', 'skeleton');
toggle('#travel', 'travel', () => {
  // Al volver al sitio, la cámara vuelve a encuadrar al personaje.
  if (!state.travel) setCam('video');
});
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
    seekToFrame(frameAt(video.currentTime) + (e.code === 'ArrowRight' ? 1 : -1));
  } else if (e.code === 'KeyI') markIn();
  else if (e.code === 'KeyO') markOut();
  else if (e.code === 'KeyB') setEditing(!state.editing);
  else if (e.code === 'KeyP') setPoseEdit(!state.poseEdit);
  else if (e.code === 'Comma') jumpKey(-1);
  else if (e.code === 'Period') jumpKey(1);
  else if (e.code === 'Delete' || e.code === 'Backspace') deleteKey();
  else if (e.code === 'Escape') {
    setEditing(false);
    setPoseEdit(false);
  }
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
  $('#tag3d').textContent = state.skeleton ? 'MANIQUÍ (RIG)  ·  ESQUELETO MEDIAPIPE' : 'MANIQUÍ (RIG)';

  const m = state.mocap!.sample(tc, sample);
  // En el sitio (por defecto): se quita el desplazamiento de la raíz a todo (cuerpo, pies, balón,
  // esqueleto) para ver bien el gesto y el bucle; el giro se mantiene.
  const shift = vC.copy(m.root);
  if (!state.travel) shift.set(0, 0, 0);
  const drop = (q: THREE.Vector3) => (state.travel ? q : q.sub(m.root));
  // Pies clavados (mundo) = posición del personaje + objetivo del clip.
  footL.copy(drop(m.footL)).multiplyScalar(RIG_M).add(player.root.position);
  footR.copy(drop(m.footR)).multiplyScalar(RIG_M).add(player.root.position);
  player.applyPose(m.pose, m.yaw, m.lift * RIG_M, {
    offset: offset.copy(shift).multiplyScalar(RIG_M),
    footL,
    footR,
    footWL: m.footWL,
    footWR: m.footWR,
  });
  // Si se desplaza, la cámara le acompaña (sin perder el ángulo que haya puesto el usuario).
  const body = vB.copy(offset).add(player.root.position).setY(0);
  const move = vA.subVectors(body, lastBody);
  if (move.lengthSq() < 4) {
    camera.position.add(move);
    controls.target.add(move);
  }
  lastBody.copy(body);
  // El esqueleto de MediaPipe va en metros y con la raíz incluida.
  const rootM = baked!.clip.root[f]!;
  skeleton.position.set(0.75 - (state.travel ? 0 : rootM[0]! / baked!.scale), 0, state.travel ? 0 : -rootM[1]! / baked!.scale);

  // Balón: suelto donde se vio en el vídeo; en la mano, pegado a la palma del rig.
  const free = vA.copy(drop(m.ball)).multiplyScalar(RIG_M).add(player.root.position);
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
  $('#info').textContent = `fotograma ${f + 1}/${baked!.world.length}${out} · balón ${src ? seen : 'no visto'} (${where}) · salto ${Math.round(m.lift * RIG_M * 100)} cm · apoyo: ${feet}`;
}

/** Coloca el asa del keyframe (y sus flechas X/Y/Z) donde está el balón en este fotograma. */
function updateHandle(fAbs: number) {
  const b = state.baked;
  const i = bakedIndex(fAbs);
  const p = state.editing && b && i >= 0 ? ballLocalAt(fAbs) : null;
  keyHandle.visible = gizmoHelper.visible = !!p;
  gizmo.enabled = !!p;
  if (!p || gizmo.dragging) return;
  const w = state.travel ? b!.localToWorld(i, p) : p; // en el sitio: sin la raíz
  keyHandle.position.set(w[0], w[1], w[2]).multiplyScalar(b!.scale * RIG_M).add(player.root.position);
}

function frame() {
  const t = video.currentTime;
  renderHead();

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
// Los cambios sin guardar ya están en el borrador (en disco): solo se avisa si se está analizando.
addEventListener('beforeunload', (e) => {
  if (state.analyzing) e.preventDefault();
});
resize();
requestAnimationFrame(frame);
await refreshLibrary();
const want = new URLSearchParams(location.search).get('c');
if (want && library.some((i) => i.name === want)) await open(want);
else if (library[0]) await open(library[0].name);
if (import.meta.env.DEV) Object.assign(window, { __studio: { state, frameAt, timeOf, seekToFrame, setPoseEdit, selectJoint, poseGizmo, analyze, save, seek, setPlaying, seekFrame, setKey, setKey3D, exportLandmarks, setEditing, applyRange, keyHandle, gizmo, player } });
