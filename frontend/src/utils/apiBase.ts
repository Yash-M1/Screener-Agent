// Address of the separately deployed backend, set at build time via VITE_API_BASE_URL
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

if (!API_BASE_URL) {
  console.error(
    'VITE_API_BASE_URL is not set, so /api calls go to this website instead of the backend. ' +
      'Set it in frontend/.env and run "npm run build" again.'
  );
}
