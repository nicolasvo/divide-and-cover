import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// API_PROXY_TARGET lets compose point Vite at http://api:8000 (compose network).
// When running on host (make frontend), it defaults to the published port.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': apiTarget
    },
    // ensure HMR connects back to localhost when running inside a container
    hmr: { clientPort: 5173 }
  }
});
