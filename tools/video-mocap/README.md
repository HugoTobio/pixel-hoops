# Vídeo → animación (captura de movimiento desde vídeo)

Saca la postura del jugador fotograma a fotograma con **MediaPipe Pose** (Google, gratis, en local, sin cuenta).
Probado el 2026-11-26 con el vídeo del pivote (`JUEGO BASKET/Grabación de pantalla 2026-11-26 a las 9.27.57.mov`).

## Alternativa en Python (la primera prueba; ya no hace falta)

### Preparar (una vez)

```sh
python3.13 -m venv .mpenv && .mpenv/bin/pip install mediapipe opencv-python-headless
mkdir -p models && curl -sL -o models/pose_heavy.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task
```

### Usar

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

## Estudio de mocap (lo normal)

```sh
npm run studio        # abre http://localhost:5180/studio.html
```

Todo en local y en el navegador (MediaPipe Pose para web; sin Python):

1. **＋ Abrir vídeo…** (o arrastrarlo) y ponerle nombre → se copia a `data/<nombre>/video.<ext>` (fuera de git).
2. Opcional: marcar el tramo con **Inicio aquí / Fin aquí** (teclas I / O).
3. **ANALIZAR**: mide los fps del vídeo, saca la pose fotograma a fotograma y busca el balón
   (`src/mocap/ball-detect.ts`: mancha naranja redonda del tamaño esperado; descarta cara, piel y zapatillas
   naranjas y saltos imposibles). Se guarda en `data/<nombre>/capture.json`. Mientras analiza se puede seguir
   tocando el reproductor: el análisis usa su propia copia del vídeo.
4. Ajustar **Salto** (×0–4) y **Movimiento** (×0–2,5: cuánto se aparta cada articulación de la postura de reposo).
5. **GUARDAR EN EL JUEGO** → `apps/client/src/content/anims/<nombre>.json` (con la exageración elegida).

La "detección sobre vídeo" dibuja el esqueleto y un círculo amarillo donde se ha visto el balón: si el círculo
se va a otra cosa, ese tramo saldrá mal. El modelo (`models/pose_landmarker_heavy.task`, 30 MB) se descarga solo
la primera vez.

Código: `apps/client/studio.html` + `src/studio/main.ts` (interfaz), `studio-server.ts` (guardar en disco; solo
existe en `npm run dev`, nunca en la web publicada), `src/mocap/capture.ts` (captura → clip: limpieza, suelo,
salto medido en la imagen, balón en la mano o suelto), `src/mocap/clip.ts` (reproducir con exageración; lo usará
el juego), `src/mocap/retarget.ts` (común con los BVH de CMU).

## Pendiente

1. Meter el pivote en el juego y decidir cuándo se ejecuta (¿botón nuevo o al cambiar bruscamente de dirección con balón?).
2. Si un vídeo da problemas con el balón: corregirlo a mano en el estudio (aún no existe).
