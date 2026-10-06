import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS in dev: phone browsers only allow the camera on a secure origin, so the guard
// phone on the LAN needs https. The certificate is self-signed; accept the warning once per device.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': 'http://localhost:4000' },
  },
});
