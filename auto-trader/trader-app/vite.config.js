import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the platform gateway runs on an internal port that is not publicly
// exposed, so we proxy API calls through the frontend origin. In production
// the app talks to the gateway directly via BACKEND_URL.
const backend = process.env.BACKEND_URL || 'http://localhost:5000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/trading-service': {
        target: backend,
        changeOrigin: true,
      },
    },
  },
});
