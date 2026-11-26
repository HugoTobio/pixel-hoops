# Pixel Hoops — resumen del proyecto

Juego para **móvil (navegador, en horizontal) de baloncesto 3 contra 3**, pista completa y realista, 3D con
estética pixelada low poly (el "estilo Brawl Stars" es SOLO estético: colorido, contornos, aspecto de juguete;
NO es un juego de peleas). Interfaz en español.

- **Jugar:** https://pixel-hoops.vercel.app
- **Código:** https://github.com/HugoTobio/pixel-hoops (privado; rama `main`). Los vídeos, capturas en curso, modelos
  de MediaPipe y BVH de la CMU no se suben (ver `.gitignore`).
- **Carpeta de trabajo (desde 2026-11-26):** Dropbox `/2026 HTS/CLAUDE/JUEGO BASKET/pixel-hoops`, con git (rama `main`).
  `~/brawl-pixel` es la copia antigua del Mac original; ya no se usa.
- `node_modules`, `dist` y `.deploy` están marcados para que Dropbox no los sincronice
  (`xattr -w com.dropbox.ignored 1 <carpeta>`); en otro ordenador basta con `npm install` y `npx vercel link`.
- Empezado el 2026-11-23. Último estado: 2026-11-26.

## Reglas que puso el usuario

- **Coste cero**: no ampliar ninguna suscripción. Todo debe caber en planes gratuitos.
  Supabase está al límite (2 proyectos) → si hace falta base de datos, usar **Neon** (ya instalado vía Vercel).
- Multijugador **sin servidor propio ni cuentas**: el móvil que crea la partida hace de servidor/árbitro.
- Confirmar la mecánica antes de construir (al principio hubo un malentendido: se empezó un brawler).

## Cómo arrancarlo

```sh
npm install
npm run dev          # http://localhost:5180 (también abre en la red local para probar desde el móvil)
npm test             # pruebas de la simulación sin navegador (tiros, IA, pases, jugadas, entradas, partido)
npm run typecheck
npm run studio       # estudio de mocap (app aparte, http://localhost:5190): vídeo → animaciones del rig
npm run deploy       # compila y publica en https://pixel-hoops.vercel.app (Vercel, equipo hugo-hts-projects)
```

Notas de despliegue: se publica la carpeta compilada con `npx vercel@latest` (el `vercel` de Homebrew del Mac
está roto: a su Node le falta `libsimdjson`; arreglo opcional `brew reinstall node`). `npm run deploy` usa la
carpeta `.deploy/pixel-hoops` (con el enlace `.vercel` al proyecto); en otro ordenador hay que volver a enlazar
con `npx vercel link` dentro de esa carpeta (proyecto **pixel-hoops**, equipo **hugo-hts-projects**).

## Tecnología

- Monorepo npm workspaces · TypeScript.
- `apps/client`: Vite 6 + Three.js 0.170. Pixelado = render a baja resolución + `image-rendering: pixelated`;
  materiales toon, contornos de casco invertido, normales facetadas.
- `packages/shared`: simulación **determinista** a 60 Hz e IA (la usan cliente y servidor).
- `apps/server`: servidor WebSocket autoritativo (ya NO se usa; se guarda como alternativa futura).
- Multijugador: **WebRTC P2P con PeerJS** (servidor público de presentación 0.peerjs.com + STUN de Google + TURN
  público de PeerJS; sin cuenta). El anfitrión ejecuta la simulación y envía el estado completo 30 veces/s; el
  invitado solo envía controles. Latido cada 1 s, desconexión a los 6 s de silencio, despedida al cerrar la página.
- Sonidos sintetizados con Web Audio (sin archivos).
- Animaciones: mocap de la **CMU** (licencia permite usarlo en el juego, acreditar a CMU; no revender los datos),
  retargeting por direcciones de hueso, horneado a `apps/client/src/content/anims/clips.json` (30 fps). Capas:
  piernas de `run`, tronco de `dribble`, `shoot`. Ver `tools/mocap/README.md`.

## Mapa del código

| Archivo | Qué hace |
|---|---|
| `packages/shared/src/court.ts` | Medidas FIBA en metros, aros en x = ±12,425, línea de 3 (con esquinas) |
| `ball.ts` | Física del balón: aro (toro), tablero, suelo; eventos canasta/aro/tablero/bote |
| `shot.ts` | Barra de tiro (mantener y soltar), zona verde según defensor cercano, dispersión del tiro |
| `game.ts` | Estado del partido, jugadores (alturas 1,85/2,01/2,13), movimiento, bloqueos, saques de banda, `stepGame` |
| `ai.ts` | IA: defensa individual + ayudas desde medio campo, espaciado en ataque, decisiones del que lleva el balón, rebote |
| `pass.ts` | Pase al compañero más cercano a donde miras, intercepción, recepción |
| `plays.ts` | Tras pasar: corte al aro (brazo arriba, salto bajo el aro, sale a la línea de 3) o bloqueo (brazos en jarras, 2× ancho 1 s) |
| `finish.ts` | Entradas y mates cerca del aro, influencia del defensor |
| `steer.ts` / `protocol.ts` | Utilidades de movimiento / mensajes de red y códigos de sala |
| `apps/client/src/main.ts` | Bucle del juego, menús, controles, modos local/anfitrión/invitado, sonidos y avisos |
| `apps/client/src/p2p.ts` | Conexión P2P (anfitrión e invitado) |
| `apps/client/src/net.ts` | Origen del enlace de invitación (IP de red local si estás en localhost) |
| `render/camera.ts` | Cámara de retransmisión: aleja el zoom para que siempre se vean el jugador y el balón |
| `render/player-model.ts` | Jugadores low poly antropomorfos (la camiseta es el rasgo principal), gestos, capas de mocap |
| `render/anim.ts`, `court.ts`, `toon.ts`, `pixel.ts` | Animación, pista, materiales, efecto pixelado |
| `audio/sfx.ts` | Pase, bote, canasta, aro, tablero, silbato |
| `content/teams.ts` | Colores y dorsales de los equipos |
| `tools/mocap/` | Herramientas para convertir mocap BVH de la CMU en clips |
| `packages/mocap/` | Común estudio/juego: formato de pose y clips, medidas del rig, retargeting, captura desde vídeo, IK, detector de balón |
| `apps/studio/` | **Estudio de mocap**, app independiente del juego (`npm run studio`, puerto 5190), ver `tools/video-mocap/README.md` |
| `tools/video-mocap/` | Capturas (`data/<nombre>/`) y la primera prueba en Python |
| `tools/tests/` | Pruebas sin navegador (`npm test`) |

## Lo que ya funciona

- **Menú inicial**: HUMANO vs BOT (empieza al momento) o HUMANO vs HUMANO (enlace con código, "Esperando..."
  con puntos animados; al entrar el rival, aviso + reloj cuadrado de números rojos 5→0 y empieza).
- **Controles**: joystick en pantalla + botones PASE y TIRO. En ordenador: flechas/WASD, espacio = tiro,
  **N = pase / cortar pase**, **R = reset** (da el balón a un jugador).
- **Tiro**: mantener y soltar con barra; la zona verde es estrecha con defensor encima y mucho más grande si
  estás solo (p. ej. tras un bloqueo). Triples, tablero, rebotes.
- **Bote en carrera** con mocap capturado desde vídeo (`dribble-run.json`, bucle de la captura `bote-en-carrera`).
- **Entradas y mates** al estar bajo el aro o atacándolo.
- **Pase** al compañero más cercano a donde miras; el rival puede cortarlo pulsando pase si está cerca.
- **Tras pasar**: el pasador corta al aro (pulsando pase otra vez se la devuelven) o va a bloquear al defensor.
- **IA**: defensa 1 contra 1 sobre el balón desde medio campo, los otros dos flotan entre el aro y el balón sin
  alejarse de su par; los compañeros se adelantan al que lleva el balón; rebote.
- **Saque de banda** del equipo contrario tras cada canasta.
- **Sonidos** y silbato inicial.
- **Multijugador por internet** comprobado en producción con dos pestañas (cuenta atrás y partida en ambos).

## Limitaciones conocidas

- Si el móvil anfitrión se bloquea o cambia de app, la partida termina para los dos.
- En redes muy restrictivas depende del TURN público de PeerJS (sin garantías).
- El invitado nota algo de retraso (no hay predicción en cliente).
- No probado aún entre dos redes reales distintas (wifi vs datos de otra persona).

## Ideas pendientes (no pedidas aún)

- Pivote con mocap desde vídeo (análisis hecho, ver `tools/video-mocap/README.md`; falta decidir cuándo se activa:
  ¿botón nuevo o al cambiar bruscamente de dirección con balón?).
- Predicción en el cliente invitado, cambios defensivos ante bloqueos, pick-and-roll, desplazamiento defensivo
  con mocap, que la IA intente interceptar pases, animación de pase.
