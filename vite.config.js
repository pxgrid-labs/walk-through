import { defineConfig } from 'vite';

// Draco デコーダは three 同梱のものを DRACOLoader が import.meta.url で参照し、
// Vite が自動でバンドルする（src/main.js の DRACO_GLTF_CONFIG 参照）。
export default defineConfig( {
	base: './',
} );
