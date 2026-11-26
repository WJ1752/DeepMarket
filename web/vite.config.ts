import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const api = env.VITE_API_TARGET || 'http://127.0.0.1:18080';

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': api,
        '/healthz': api,
      },
    },
  };
});
