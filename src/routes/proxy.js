const express = require('express');
const { logger } = require('../utils/logger');

const router = express.Router();

// Extract subdomain from hostname
function extractSubdomain(hostname) {
    const parts = hostname.split('.');
    if (parts.length > 2) {
        return parts[0];
    }
    return null;
}

// Handle all requests
router.use((req, res, next) => {
    const subdomain = extractSubdomain(req.hostname);
    logger.info('Processing request:', { hostname: req.hostname, subdomain });

    if (!subdomain) {
        return next();
    }

    res.status(404).json({
        error: 'Container not found or not running',
        subdomain
    });
});

module.exports = { router }; 