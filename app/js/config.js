'use strict';
/**
 * App configuration (live deployment — Jangaon district).
 */
window.APP_CONFIG = {
  ENDPOINT: 'https://script.google.com/macros/s/AKfycbxqh5SCxSluIykqBmFzXcXchNiCqQOQO8c6fh3IqIilYRVE_pq4_d3Yq0P4VQ8etcWrWA/exec',
  // Same script, two deployments: clients fail over if one serves errors.
  ENDPOINTS: ['https://script.google.com/macros/s/AKfycbxqh5SCxSluIykqBmFzXcXchNiCqQOQO8c6fh3IqIilYRVE_pq4_d3Yq0P4VQ8etcWrWA/exec', 'https://script.google.com/macros/s/AKfycbyX0oRc80SAH7VxkMB3c5-eyKx58lOsVh_vgaOZRZ8HqR2D0jr8NDF3J_A-hCEy3hc0EQ/exec'],
  DEMO: false,
  VERSION: '1.0.0'
};
