// Where the API lives.
// - Page served by Express (npm start locally, or the Render backend itself): same origin.
// - Page served by Vercel: the Render backend below. Set BACKEND once Render gives you the URL.
const BACKEND = 'https://REPLACE-WITH-YOUR-RENDER-SERVICE.onrender.com';

const sameOrigin = ['localhost', '127.0.0.1'].includes(location.hostname)
  || location.hostname.endsWith('.onrender.com');
window.API_BASE = sameOrigin ? '' : BACKEND.replace(/\/+$/, '');
