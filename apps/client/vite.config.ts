import { networkInterfaces } from 'node:os';
import { defineConfig } from 'vite';
import { fsUrl, MP_WASM, studioServer } from './studio-server';

/** IP del ordenador en la red local (para que el enlace de invitación funcione desde el móvil). */
function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return null;
}

export default defineConfig({
  define: {
    __LAN_HOST__: JSON.stringify(lanAddress()),
    /** Ficheros WASM de MediaPipe para el estudio de mocap (solo en desarrollo). */
    __MP_WASM__: JSON.stringify(fsUrl(MP_WASM)),
  },
  plugins: [studioServer()],
  server: { host: true, port: 5180 },
  preview: { host: true },
});
