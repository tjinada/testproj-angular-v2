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

  res.json({ envHostnamePatterns });
});

module.exports = router;
