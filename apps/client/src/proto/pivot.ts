/**
 * Prototipo: el rig del juego animado con la captura del pivote desde vídeo.
 * Abrir con `npm run dev` → http://localhost:5180/pivot.html
 *
 * Datos: apps/client/src/content/anims/pivot.json (tools/video-mocap/bake-pose.ts).
 * El vídeo (tools/video-mocap/data/pivot.mp4) no está en git: si falta, se reproduce sin él.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import data from '../content/anims/pivot.json';
import videoUrl from '../../../../tools/video-mocap/data/pivot.mp4?url';
import { lookFor } from '../content/teams';
import { Clip, PoseBuf } from '../render/anim';
import { buildCourt } from '../render/court';
import { createPlayerModel } from '../render/player-model';

type ClipName = 'pivot' | 'pivotRaw';
interface PivotClipJson {
  fps: number;
  loop: boolean;
  duration: number;
  frames: number[][];
  yaw: number[];
  lift: number[];
}
const json = data as unknown as {
  clips: Record<ClipName, PivotClipJson>;
  skeleton: { points: string[]; bones: [number, number][] } & Record<ClipName, number[][]>;
};
const clips = { pivot: new Clip(json.clips.pivot), pivotRaw: new Clip(json.clips.pivotRaw) };
const FPS = json.clips.pivot.fps;
const DURATION = json.clips.pivot.duration;
const PHASES = [
  { t: 0, label: 'Bote y cambio entre las piernas' },
  { t: 1.5, label: 'Giro de espaldas y pivote' },
  { t: 3.45, label: 'Tiro en suspensión' },
];

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const canvas = $<HTMLCanvasElement>('#view');
const video = $<HTMLVideoElement>('#video');
const scrub = $<HTMLInputElement>('#scrub');
const playBtn = $<HTMLButtonElement>('#play');

// --- Escena (la misma luz y pista que el juego) -----------------------------
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
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 30 });
sun.shadow.bias = -0.001;
scene.add(sun);

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 2;
controls.maxDistance = 25;
controls.maxPolarAngle = Math.PI / 2 - 0.02;

// Jugador de 2,01 m (el alero, como en el juego).
const player = createPlayerModel(lookFor('home', 1), 2.01, 0xf2c94c);
scene.add(player.root);

// Esqueleto de MediaPipe al lado, para comparar con lo que se ha captado.
const skelGeo = new THREE.BufferGeometry();
const skelPos = new Float32Array(json.skeleton.bones.length * 2 * 3);
skelGeo.setAttribute('position', new THREE.BufferAttribute(skelPos, 3));
const skeleton = new THREE.Group();
skeleton.add(new THREE.LineSegments(skelGeo, new THREE.LineBasicMaterial({ color: 0x6fe3ff })));
const jointDots = new THREE.Points(skelGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.05 }));
skeleton.add(jointDots);
scene.add(skeleton);

// --- Estado -------------------------------------------------------------------
const state = {
  clip: 'pivot' as ClipName,
  skeleton: true,
  video: true,
  pixel: true,
  playing: false,
  speed: 1,
  t: 0,
};
const hasVideo = { ok: false };
const pose = new PoseBuf();

/** Interpola una pista por fotograma (yaw, salto) en el tiempo t. */
function track(xs: number[], t: number): number {
  const f = Math.max(0, Math.min(xs.length - 1, t * FPS));
  const i = Math.floor(f);
  const j = Math.min(xs.length - 1, i + 1);
  return xs[i]! + (xs[j]! - xs[i]!) * (f - i);
}

function layout() {
  player.root.position.x = state.skeleton ? -0.75 : 0;
  skeleton.position.x = 0.75;
  skeleton.visible = state.skeleton;
  $('#tag3d').textContent = state.skeleton ? 'RIG DEL JUEGO  ·  ESQUELETO MEDIAPIPE' : 'RIG DEL JUEGO';
}

function poseAt(t: number) {
  const c = json.clips[state.clip];
  clips[state.clip].sample(t, pose);
  player.applyPose(pose, track(c.yaw, t), track(c.lift, t) * (player.height / 2));

  const frames = json.skeleton[state.clip];
  const f = Math.max(0, Math.min(frames.length - 1, Math.round(t * FPS)));
  const pts = frames[f]!;
  json.skeleton.bones.forEach(([a, b], k) => {
    skelPos.set(pts.slice(a * 3, a * 3 + 3), k * 6);
    skelPos.set(pts.slice(b * 3, b * 3 + 3), k * 6 + 3);
  });
  skelGeo.attributes.position!.needsUpdate = true;
  skelGeo.computeBoundingSphere();

  const phase = [...PHASES].reverse().find((p) => t >= p.t)!;
  $('#phase').textContent = `${phase.label}  ·  fotograma ${f + 1}/${frames.length}`;
  $('#time').textContent = `${t.toFixed(2).replace('.', ',')} / ${DURATION.toFixed(2).replace('.', ',')} s`;
  if (document.activeElement !== scrub) scrub.value = String(Math.round((t / DURATION) * 1000));
}

// --- Cámaras ------------------------------------------------------------------
function setCam(kind: 'video' | 'tv' | 'top') {
  const target = new THREE.Vector3(0, 1.0, 0);
  // MediaPipe mide desde la cámara del vídeo, que en nuestros ejes está en +z mirando a −z.
  if (kind === 'video') camera.position.set(0, 1.25, 7.5);
  if (kind === 'tv') camera.position.set(4.5, 4.2, 9);
  if (kind === 'top') camera.position.set(0.01, 9, 0.5);
  controls.target.copy(target);
  controls.update();
  document.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cam === kind)));
}
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
}
new ResizeObserver(resize).observe(canvas.parentElement!);

// --- Vídeo como reloj (así va siempre sincronizado) ---------------------------
video.src = videoUrl;
video.loop = true;
video.addEventListener('loadeddata', () => (hasVideo.ok = true));
video.addEventListener('error', () => {
  hasVideo.ok = false;
  state.video = false;
  $('#vid').setAttribute('aria-pressed', 'false');
  $('#vid').setAttribute('disabled', '');
  $('#main').classList.add('no-video');
  resize();
});

function seek(t: number) {
  state.t = Math.max(0, Math.min(DURATION - 1 / FPS, t));
  if (hasVideo.ok) video.currentTime = state.t;
}

function setPlaying(on: boolean) {
  state.playing = on;
  playBtn.textContent = on ? '❚❚ PAUSA' : '▶ PLAY';
  if (hasVideo.ok) {
    if (on) void video.play();
    else video.pause();
  }
}

// --- Controles ----------------------------------------------------------------
playBtn.onclick = () => setPlaying(!state.playing);
scrub.oninput = () => {
  setPlaying(false);
  seek((Number(scrub.value) / 1000) * DURATION);
};
const toggle = (id: string, key: 'skeleton' | 'video' | 'pixel', after?: () => void) => {
  const b = $<HTMLButtonElement>(id);
  b.onclick = () => {
    state[key] = !state[key];
    b.setAttribute('aria-pressed', String(state[key]));
    after?.();
  };
};
toggle('#skel', 'skeleton', layout);
toggle('#vid', 'video', () => {
  $('#main').classList.toggle('no-video', !state.video);
  resize();
});
toggle('#px', 'pixel', resize);
$<HTMLButtonElement>('#clean').onclick = (e) => {
  state.clip = state.clip === 'pivot' ? 'pivotRaw' : 'pivot';
  const b = e.currentTarget as HTMLButtonElement;
  b.setAttribute('aria-pressed', String(state.clip === 'pivot'));
  b.textContent = state.clip === 'pivot' ? 'Limpio' : 'Sin limpiar';
};
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => {
  b.onclick = () => {
    state.speed = Number(b.dataset.speed);
    video.playbackRate = state.speed;
    document.querySelectorAll('[data-speed]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
  };
});
document.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) => (b.onclick = () => setCam(b.dataset.cam as 'video')));
const marks = $('#marks');
for (const p of PHASES) {
  const s = document.createElement('span');
  s.style.left = `${(p.t / DURATION) * 100}%`;
  s.textContent = p.label;
  s.onclick = () => {
    setPlaying(false);
    seek(p.t);
  };
  marks.append(s);
}
addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    setPlaying(!state.playing);
  } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    e.preventDefault();
    setPlaying(false);
    seek(state.t + (e.code === 'ArrowRight' ? 1 : -1) / FPS);
  }
});

// --- Bucle --------------------------------------------------------------------
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (hasVideo.ok) state.t = Math.min(video.currentTime, DURATION - 1 / FPS);
  else if (state.playing) state.t = (state.t + dt * state.speed) % DURATION;
  poseAt(state.t);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
layout();
resize();
requestAnimationFrame(frame);
if (import.meta.env.DEV) Object.assign(window, { __proto: { state, seek, setPlaying, player } });
