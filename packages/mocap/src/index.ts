/**
 * @brawl/mocap — formato y proceso de las animaciones por captura de movimiento.
 *
 * Lo usan el estudio de mocap (apps/studio: captura, limpieza, retargeting, edición) y el juego
 * (apps/client: solo lee clips y aplica la pose). No depende de ninguno de los dos.
 */
export * from './pose';
export * from './rig';
export * from './ik';
export * from './retarget';
export * from './capture';
export * from './clip';
export * from './ball-detect';
