import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const backend =
  process.env.STORELINK_DEV_BACKEND ?? 'http://dashboard.storelink.localhost';
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request) =>
            request.setHeader('origin', backend),
          );
        },
      },
    },
  },
});
