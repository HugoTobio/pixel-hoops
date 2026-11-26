# Mocap → animaciones del juego

Fuente: **CMU Graphics Lab Motion Capture Database** (mocap.cs.cmu.edu), conversión BVH de Bruce Hahn
(espejo: github.com/Shriinivas/cmubvh).

Licencia (web oficial de CMU): *"The motion capture data may be copied, modified, or redistributed without
permission."* · *"You may include this data in commercially-sold products, but you may not resell this data
directly, even in converted form."* → se puede usar dentro del juego; no vender los datos sueltos.
Conviene acreditar a CMU en los créditos del juego.

## Clips usados

| Clip del juego | BVH | Tramo |
|---|---|---|
| `dribble` (tronco y brazos) | 06_02 forward dribble | 2,5–5,25 s, bucle de 2 botes |
| `run` (piernas) | 09_01 run | bucle de una zancada |
| `shoot` | 06_15 dribble, shoot | 2,15–3,6 s (recogida → salto → aterrizaje) |

## Regenerar

```sh
mkdir -p tools/mocap/bvh && cd tools/mocap/bvh
for f in 06_02 06_15; do curl -sLO https://github.com/Shriinivas/cmubvh/raw/main/Sequence-001-009/06/Data/$f.zip; done
curl -sLO https://github.com/Shriinivas/cmubvh/raw/main/Sequence-001-009/09/Data/09_01.zip
unzip -o '*.zip' && rm *.zip && cd -
npm run bake:mocap      # → apps/client/src/content/anims/clips.json
npx tsx tools/mocap/analyze.ts tools/mocap/bvh/06_15.bvh   # para buscar tramos nuevos
```

Otros clips interesantes de CMU para más adelante: sujeto 06 (crossover 06_14, regates con giros 06_10) y
sujeto 102 (baloncesto: fintas de tiro, defensa, pivotes, penetraciones).
