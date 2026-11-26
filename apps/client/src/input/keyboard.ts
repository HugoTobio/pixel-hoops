const down = new Set<string>();

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') e.preventDefault();
  down.add(e.code);
});
window.addEventListener('keyup', (e) => down.delete(e.code));
window.addEventListener('blur', () => down.clear());

export const isDown = (code: string) => down.has(code);

/** Vector de movimiento de teclado en coordenadas de pantalla (y abajo). */
export function keyboardVector(): { x: number; y: number } {
  const x = (down.has('KeyD') || down.has('ArrowRight') ? 1 : 0) - (down.has('KeyA') || down.has('ArrowLeft') ? 1 : 0);
  const y = (down.has('KeyS') || down.has('ArrowDown') ? 1 : 0) - (down.has('KeyW') || down.has('ArrowUp') ? 1 : 0);
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}
