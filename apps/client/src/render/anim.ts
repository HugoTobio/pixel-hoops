/**
 * Animaciones del juego: los clips que carga (CMU y bucles capturados desde vídeo).
 * El formato y el reproductor vienen del paquete común @brawl/mocap (lo escribe el estudio de mocap).
 */
import { BallLoop, Clip, type ClipJson } from '@brawl/mocap';
import data from '../content/anims/clips.json';
import dribbleRunData from '../content/anims/dribble-run.json';

export { idlePose, LOWER, PoseBuf, SLOTS, UPPER, type Slot } from '@brawl/mocap';

const clips = (data as unknown as { clips: Record<string, ClipJson> }).clips;
const dribbleRun = dribbleRunData as unknown as ClipJson & { ball: number[][] };
export const CLIPS = {
  dribble: new Clip(clips.dribble!),
  run: new Clip(clips.run!),
  shoot: new Clip(clips.shoot!),
  /** Bote en carrera: bucle de cuerpo entero capturado desde vídeo (estudio, captura "bote-en-carrera"). */
  dribbleRun: new Clip(dribbleRun),
};
export const DRIBBLE_RUN_BALL = new BallLoop(dribbleRun.fps, dribbleRun.ball);
