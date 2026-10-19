import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const backend =
  process.env.URUMI_DEV_BACKEND ?? 'http://dashboard.urumi.localhost';
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
