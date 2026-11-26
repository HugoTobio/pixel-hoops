import { defineConfig } from 'vite';
import { fsUrl, MP_WASM, studioServer } from './studio-server';

/** Estudio de mocap: app propia (puerto 5190), independiente del juego (5180). Solo existe en local. */
export default defineConfig({
  define: {
    /** Ficheros WASM de MediaPipe (servidos desde node_modules). */
    __MP_WASM__: JSON.stringify(fsUrl(MP_WASM)),
  },
  plugins: [studioServer()],
  server: { port: 5190 },
});
