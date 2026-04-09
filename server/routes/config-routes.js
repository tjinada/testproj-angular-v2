const express = require('express');
const router = express.Router();

/**
 * GET /api/config
 * Exposes a small set of frontend-relevant configuration values that are
 * sourced from the server's .env file.
 */
router.get('/', (req, res) => {
  const patternsRaw = process.env.ENV_HOSTNAME_PATTERNS || '';
  const envHostnamePatterns = patternsRaw
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  // Available environments. Non-Prod is always exposed; Prod is gated by
  // DYNATRACE_PROD_ENABLED so it can be hidden in restricted deployments.
  const environments = [
    { id: 'NON-PROD', label: 'Non-Prod', isProd: false }
  ];

  if (process.env.DYNATRACE_PROD_ENABLED === 'true') {
    environments.push({ id: 'PROD', label: 'Prod', isProd: true });
  }

  res.json({ envHostnamePatterns, environments });
});

module.exports = router;
