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

## Pendiente

1. Suavizar (filtro tipo One-Euro o Savitzky-Golay), descartar puntos con visibilidad < 0,5 y saltos sueltos.
2. Adaptar `tools/mocap/bake.ts` (ya retargetea por direcciones de hueso) para leer `pose.json` en lugar de BVH.
3. Añadir el clip `pivot` (y quizá sustituir `shoot`) en `apps/client/src/content/anims/clips.json`.
4. Decidir cuándo se ejecuta el pivote en el juego (¿botón nuevo o al cambiar bruscamente de dirección con balón?).
