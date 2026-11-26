import { networkInterfaces } from 'node:os';
import { defineConfig } from 'vite';

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
  },
  server: { host: true, port: 5180 },
  preview: { host: true },
});
