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
   **Línea de tiempo**: el cabezal se ajusta a fotogramas exactos y su etiqueta dice en qué fotograma estás
   (numerados desde el inicio del vídeo, en la misma rejilla que el análisis; ←/→ avanzan de uno en uno).
   Los indicadores amarillos **[ ]** marcan inicio y fin del clip: se arrastran (el vídeo enseña el fotograma
   mientras tanto) y al soltar se recorta. Verde = analizado; rombos = keyframes del balón.
2. Opcional: marcar el tramo con **Inicio aquí / Fin aquí** (teclas I / O) o con los indicadores. Después de analizar, esos mismos
   botones **recortan el clip** al momento (sin volver a analizar): lo de fuera no entra en el clip ni en los
   landmarks. **Sin recorte** lo quita. Si el nuevo tramo se sale de lo analizado, pide ANALIZAR (los keyframes
   se conservan, recolocados por tiempo).
3. **ANALIZAR**: mide los fps del vídeo, saca la pose fotograma a fotograma y busca el balón
   (`src/mocap/ball-detect.ts`: mancha naranja redonda del tamaño esperado; descarta cara, piel y zapatillas
   naranjas y saltos imposibles). Se guarda en `data/<nombre>/capture.json`. Mientras analiza se puede seguir
   tocando el reproductor: el análisis usa su propia copia del vídeo.
4. Ajustar **Salto** (×0–4) y **Movimiento** (×0–2,5: cuánto se aparta cada articulación de la postura de reposo).
5. **Pies fijos** (activado por defecto): detecta cuándo cada pie está apoyado y lo clava en el suelo; el cuerpo
   se desplaza sobre él (desplazamiento de la raíz). En el rig se resuelve con cinemática inversa de dos huesos.
6. **Corregir el balón** con keyframes: **Editar balón** (tecla B) y
   - clic/arrastrar sobre el vídeo (mueve X/Y y conserva la profundidad),
   - arrastrar las flechas X/Y/Z del asa verde en la vista 3D, o
   - escribir **X Y Z** en metros (X/Z respecto a la cadera —X a la derecha de la cámara, Z hacia ella—,
     Y = altura sobre el suelo).

    Un keyframe manda en su fotograma; entre dos keyframes a menos de 0,75 s se interpola
   (sustituye a la detección); un keyframe suelto corrige la detección de alrededor y se desvanece en 0,15 s.
   Cada keyframe puede forzar la mano (automática / izquierda / derecha / suelto). `,` `.` saltan entre
   keyframes y Supr borra el del fotograma actual. Sobre el vídeo: amarillo discontinuo = detectado, verde =
   corregido (relleno = keyframe). Los keyframes se guardan en `capture.json` (no hace falta volver a analizar).
7. **GUARDAR EN EL JUEGO** → `apps/client/src/content/anims/<nombre>.json` (con la exageración elegida).
8. **EXPORTAR LANDMARKS** → `data/<nombre>/landmarks.json` (y se descarga). Ver formato abajo.
Lo que se edita (keyframes, recorte, pies, exageración) se guarda al momento como **borrador** en el navegador:
si la página se recarga o se cierra sin GUARDAR, al volver a abrir la captura se recupera (lo dice arriba).

9. **⧉ Duplicar captura** (barra lateral): copia vídeo (clon APFS, sin ocupar espacio extra), análisis,
   keyframes, recorte y exageración con otro nombre, para sacar otro clip de otra sección del mismo vídeo.

### Formato de `landmarks.json` (landmarks limpios, antes del retargeting)

```jsonc
{
  "format": "pixel-hoops/mediapipe-landmarks", "version": 1, "name": "pivot",
  "fps": 60, "frameCount": 291, "duration": 4.85, "videoRange": [0, 4.85], "units": "m",
  "axes": "y arriba, x a la derecha de la cámara, z hacia la cámara; suelo en y = 0; x/z = 0 en la cadera del 1er fotograma",
  "cleaning": { "minVisibility": 0.5, "medianFrames": 7, "gaussSigmaFrames": 2.2, "feetLocked": true },
  "points": ["nose", "left_eye_inner", …, "right_foot_index"],   // los 33 de MediaPipe, en su orden
  "frames": [ { "t": 0, "p": [[x, y, z, visibility], … 33] }, … ],
  "ball": [[x, y, z] | null, …]                                  // extra: centro del balón, mismos ejes
}
```

- Coordenadas *world* de MediaPipe (metros) pasadas a ejes con Y arriba (giro de 180° sobre X, sin espejo).
- Limpieza: puntos con visibilidad < 0,5 interpolados, mediana de 7 fotogramas y gaussiano σ = 2,2 sin desfase.
  La `visibility` es la original de MediaPipe (así se sabe qué puntos se han rellenado).
- Incluye el salto (medido en la imagen) y, con pies fijos, el desplazamiento por la pista y los pies clavados.

La "detección sobre vídeo" dibuja el esqueleto y un círculo amarillo donde se ha visto el balón: si el círculo
se va a otra cosa, ese tramo saldrá mal. El modelo (`models/pose_landmarker_heavy.task`, 30 MB) se descarga solo
la primera vez.

Código: `apps/client/studio.html` + `src/studio/main.ts` (interfaz), `studio-server.ts` (guardar en disco; solo
existe en `npm run dev`, nunca en la web publicada), `src/mocap/capture.ts` (captura → clip: limpieza, suelo,
salto medido en la imagen, balón en la mano o suelto), `src/mocap/clip.ts` (reproducir con exageración; lo usará
el juego), `src/mocap/retarget.ts` (común con los BVH de CMU).

## Pendiente

1. Meter el pivote en el juego y decidir cuándo se ejecuta (¿botón nuevo o al cambiar bruscamente de dirección con balón?).
