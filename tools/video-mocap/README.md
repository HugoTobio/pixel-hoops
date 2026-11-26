# Vídeo → animación (captura de movimiento desde vídeo)

Saca la postura del jugador fotograma a fotograma con **MediaPipe Pose** (Google, gratis, en local, sin cuenta).
Probado el 2026-11-26 con el vídeo del pivote (`JUEGO BASKET/Grabación de pantalla 2026-11-26 a las 9.27.57.mov`).

## Preparar (una vez)

```sh
python3.13 -m venv .mpenv && .mpenv/bin/pip install mediapipe opencv-python-headless
mkdir -p models && curl -sL -o models/pose_heavy.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task
```

## Usar

```sh
.mpenv/bin/python -I tools/video-mocap/pose.py VIDEO.mov models/pose_heavy.task pose.json
.mpenv/bin/python -I tools/video-mocap/overlay.py VIDEO.mov pose.json overlay.png   # comprobación visual
```

`pose.json`: `{fps, frames:[{i, w:[[x,y,z,visibilidad]×33] (metros, centrado en la cadera), n:[[x,y]×33] (imagen 0–1)}]}`.
Puntos MediaPipe: 11/12 hombros, 13/14 codos, 15/16 muñecas, 23/24 caderas, 25/26 rodillas, 27/28 tobillos,
29/30 talones, 31/32 punteras (impares = izquierda).

## Resultado con el vídeo del pivote

- 2330×1258, 60 fps, 4,9 s, 292 fotogramas → **pose detectada en los 292**.
- El giro de espaldas se lee bien (la orientación de la cadera nunca salta).
- A corregir antes de usarlo: temblor de ~6 cm/fotograma en manos y pies (suavizar), ~10 saltos sueltos de
  muñeca cuando el brazo queda tapado (muñeca derecha poco visible el 40 % del vídeo) y tobillos cruzados en
  los fotogramas 74–83 (bote entre las piernas).
- No da el desplazamiento por la pista (la cámara sigue al jugador) ni el balón: los pone el juego.
- Contenido: ~0–1,5 s bote/cambio entre piernas · ~1,5–3,3 s giro de espaldas y pivote · ~3,6–4,2 s tiro en
  suspensión.
- Ojo: parece una grabación de pantalla del vídeo de otra persona (rótulo "MOVE 1"). Vale para probar; para
  publicar, grabar el gesto uno mismo (cuerpo entero, de lado o en diagonal, buena luz, 60 fps).

## Hornear y ver el prototipo

```sh
npx tsx tools/video-mocap/bake-pose.ts     # data/pivot-pose.json → apps/client/src/content/anims/pivot.json
npm run dev                                 # http://localhost:5180/pivot.html
```

`bake-pose.ts` limpia (visibilidad < 0,5 fuera, mediana de 7 fotogramas, gaussiano), apoya el pie más bajo en el
suelo, saca el salto de la imagen (subida de los tobillos en pantalla) y retargetea con `tools/mocap/retarget.ts`
(el mismo código que los BVH de CMU). Guarda `pivot` (limpio) y `pivotRaw` (sin limpiar) + rumbo (`yaw`) y salto
(`lift`) por fotograma, y el esqueleto de MediaPipe para comparar.

`pivot.html` muestra el vídeo (`data/pivot.mp4`, fuera de git) sincronizado con el rig del juego y el esqueleto,
con cámara orbital, velocidad, fotograma a fotograma y comparación limpio / sin limpiar.
Para regenerar el mp4: `ffmpeg -i VIDEO.mov -vf scale=-2:540 -an -c:v libx264 -crf 25 -g 6 -pix_fmt yuv420p -movflags +faststart tools/video-mocap/data/pivot.mp4`

## Pendiente

1. Revisar el bote entre las piernas (fotogramas 74–83, tobillos cruzados) y la muñeca derecha tapada.
2. El balón no se capta: hay que generarlo (como en `dribble`) o recortar el clip al giro.
3. Pasar el pivote al juego y decidir cuándo se ejecuta (¿botón nuevo o al cambiar bruscamente de dirección con balón?).
