/**
 * Parte "servidor" del estudio de mocap: solo existe con `npm run dev` / `npm run studio` (nunca en la web
 * publicada). Guarda en disco lo que hace el estudio en el navegador:
 *
 *   tools/video-mocap/data/<nombre>/video.<ext>     vídeo original (fuera de git)
 *   tools/video-mocap/data/<nombre>/capture.json    análisis de MediaPipe + balón + exageración
 *   apps/client/src/content/anims/<nombre>.json     clip horneado que lee el juego
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA = join(ROOT, 'tools/video-mocap/data');
const MODELS = join(ROOT, 'tools/video-mocap/models');
const MODEL = join(MODELS, 'pose_landmarker_heavy.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task';
const ANIMS = join(ROOT, 'apps/client/src/content/anims');
export const MP_WASM = join(ROOT, 'node_modules/@mediapipe/tasks-vision/wasm');
const VIDEO_EXT = ['mp4', 'mov', 'webm', 'm4v'];
/** Los clips CMU y otros ficheros del juego no se pueden sobrescribir desde el estudio. */
const RESERVED = new Set(['clips']);

const validName = (n: string) => /^[a-z0-9][a-z0-9_-]{0,40}$/.test(n) && !RESERVED.has(n);
/** Ruta que Vite sirve tal cual (con soporte de Range, necesario para poder saltar por el vídeo). */
export const fsUrl = (abs: string) => `/@fs${encodeURI(abs)}`;

function videoOf(name: string): string | null {
  for (const ext of VIDEO_EXT) {
    const p = join(DATA, name, `video.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

function send(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

async function ensureModel(): Promise<void> {
  if (existsSync(MODEL)) return;
  mkdirSync(MODELS, { recursive: true });
  console.log('[estudio] Descargando el modelo de MediaPipe Pose (30 MB, solo la primera vez)…');
  const r = await fetch(MODEL_URL);
  if (!r.ok) throw new Error(`No se pudo descargar el modelo: HTTP ${r.status}`);
  writeFileSync(MODEL, Buffer.from(await r.arrayBuffer()));
}

export function studioServer(): Plugin {
  return {
    name: 'pixel-hoops-mocap-studio',
    apply: 'serve',
    configureServer(server) {
      mkdirSync(DATA, { recursive: true });
      server.middlewares.use('/__studio', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://x');
          const [, kind, name = ''] = url.pathname.split('/');

          if (kind === 'list' && req.method === 'GET') {
            const items = readdirSync(DATA, { withFileTypes: true })
              .filter((d) => d.isDirectory() && validName(d.name))
              .map((d) => {
                const v = videoOf(d.name);
                return {
                  name: d.name,
                  video: v ? fsUrl(v) : null,
                  capture: existsSync(join(DATA, d.name, 'capture.json')),
                  clip: existsSync(join(ANIMS, `${d.name}.json`)),
                  modified: statSync(join(DATA, d.name)).mtimeMs,
                };
              })
              .sort((a, b) => b.modified - a.modified);
            return send(res, 200, items);
          }

          if (kind === 'model' && req.method === 'GET') {
            await ensureModel();
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', String(statSync(MODEL).size));
            createReadStream(MODEL).pipe(res);
            return;
          }

          if (!validName(name)) return send(res, 400, { error: 'Nombre no válido: minúsculas, números, - y _ (máx. 41).' });
          const dir = join(DATA, name);

          if (kind === 'capture' && req.method === 'GET') {
            const p = join(dir, 'capture.json');
            if (!existsSync(p)) return send(res, 404, { error: 'Sin captura' });
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return res.end(readFileSync(p));
          }
          if (kind === 'capture' && req.method === 'PUT') {
            const body = await readBody(req);
            JSON.parse(body); // validar antes de escribir
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'capture.json'), body);
            return send(res, 200, { ok: true });
          }
          if (kind === 'video' && req.method === 'PUT') {
            const ext = (url.searchParams.get('ext') ?? 'mp4').toLowerCase();
            if (!VIDEO_EXT.includes(ext)) return send(res, 400, { error: `Formato no soportado (${VIDEO_EXT.join(', ')})` });
            if (videoOf(name)) return send(res, 409, { error: `Ya existe una captura llamada "${name}"` });
            mkdirSync(dir, { recursive: true });
            const target = join(dir, `video.${ext}`);
            await new Promise<void>((ok, fail) => {
              const out = createWriteStream(target);
              req.pipe(out);
              out.on('finish', ok);
              out.on('error', fail);
              req.on('error', fail);
            });
            return send(res, 200, { video: fsUrl(target) });
          }
          if (kind === 'clip' && req.method === 'PUT') {
            const body = await readBody(req);
            JSON.parse(body);
            writeFileSync(join(ANIMS, `${name}.json`), body);
            return send(res, 200, { ok: true, path: `apps/client/src/content/anims/${name}.json` });
          }
          return send(res, 404, { error: 'Ruta desconocida' });
        } catch (e) {
          return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}
