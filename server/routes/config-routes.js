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

  // Individual user token mode: when enabled, users provide their own
  // Dynatrace platform tokens via the UI instead of relying on .env tokens.
  const individualUserToken = process.env.INDIVIDUAL_USER_TOKEN === 'true';

  // Token management URLs per environment (shown in UI instructions)
  const tokenUrls = {};
  if (individualUserToken) {
    if (process.env.DYNATRACE_NONPROD_TOKEN_URL) {
      tokenUrls['NON-PROD'] = process.env.DYNATRACE_NONPROD_TOKEN_URL;
    }
    if (process.env.DYNATRACE_PROD_TOKEN_URL) {
      tokenUrls['PROD'] = process.env.DYNATRACE_PROD_TOKEN_URL;
    }
  }

  res.json({ envHostnamePatterns, environments, individualUserToken, tokenUrls });
});

module.exports = router;
