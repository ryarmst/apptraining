const { logger } = require('../utils/logger');
const { validate: validateUUID } = require('uuid');
const { db } = require('../db/init');
const httpProxy = require('http-proxy');

/**
 * Default proxy configuration
 */
const DEFAULT_PROXY_CONFIG = {
    xfwd: true,
    secure: false,
    changeOrigin: true,
    preserveHeaderKeyCase: true,
    proxyTimeout: 60000,
    timeout: 60000,
    ws: true,
    followRedirects: true
};

/**
 * Create a proxy server instance with error handling and request/response logging
 */
const proxy = httpProxy.createProxyServer(DEFAULT_PROXY_CONFIG);

// Error handling for proxy
proxy.on('error', (err, req, res) => {
    logger.error('Proxy error:', {
        error: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        headers: req.headers
    });

    if (!res.headersSent) {
        res.status(502).json({
            error: 'Proxy error',
            message: err.message
        });
    }
});

// Handle request body and headers
proxy.on('proxyReq', (proxyReq, req, res, options) => {
    if (req.method === 'POST' && req.body) {
        const bodyData = JSON.stringify(req.body);
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
        proxyReq.setHeader('Content-Type', req.headers['content-type'] || 'application/json');
        proxyReq.write(bodyData);
    }

    logger.debug('Proxy request created:', {
        url: req.url,
        method: req.method,
        headers: proxyReq._headers || {}
    });
});

// Log proxy responses
proxy.on('proxyRes', (proxyRes, req, res) => {
    logger.debug('Proxy response received:', {
        statusCode: proxyRes.statusCode,
        headers: proxyRes.headers,
        method: req.method,
        url: req.url
    });
});

/**
 * Extract subdomain from hostname
 * @param {string} hostname - The full hostname
 * @returns {string|null} - The subdomain or null if not found
 */
function extractSubdomain(hostname) { 
    const parts = hostname.split('.');
    return parts.length > 2 ? parts[0] : null;
}

/**
 * Get container information from the database
 * @param {string} subdomain - The subdomain to look up
 * @returns {Promise<Object>} - Container information
 */
async function getContainerInfo(subdomain) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT * FROM containers WHERE subdomain = ? AND status = ?',
            [subdomain, 'running'],
            (err, row) => {
                if (err) reject(err);
                resolve(row);
            }
        );
    });
}

/**
 * Create middleware for handling subdomain-based routing to containers
 * @returns {Function} Express middleware function
 */
function createSubdomainHandler() {
    return async function subdomainHandler(req, res, next) {
        const subdomain = extractSubdomain(req.hostname);
        
        logger.debug('Processing request:', { 
            hostname: req.hostname, 
            subdomain, 
            url: req.url,
            method: req.method,
            headers: req.headers
        });

        // Pass through to main app if no valid subdomain
        if (!subdomain || !validateUUID(subdomain)) {
            return next();
        }

        try {
            const container = await getContainerInfo(subdomain);

            if (!container) {
                logger.warn('Container not found or not running:', { subdomain });
                return res.status(404).json({
                    error: 'Container not found or not running',
                    subdomain
                });
            }

            // Update container activity timestamp
            const activityCallback = global.containerActivity.get(subdomain);
            if (activityCallback) {
                activityCallback();
            }

            const target = `http://localhost:${container.host_port}`;
            
            logger.debug('About to proxy request:', { 
                subdomain, 
                target, 
                url: req.url,
                method: req.method,
                headers: req.headers,
                body: req.body
            });

            // Proxy the request with default config
            proxy.web(req, res, { 
                ...DEFAULT_PROXY_CONFIG,
                target
            }, (err) => {
                if (err) {
                    logger.error('Proxy web error:', {
                        error: err.message,
                        stack: err.stack,
                        target,
                        url: req.url,
                        method: req.method
                    });
                    if (!res.headersSent) {
                        res.status(502).json({
                            error: 'Proxy error',
                            message: err.message
                        });
                    }
                }
            });

            logger.debug('proxy.web called:', {
                target,
                url: req.url,
                method: req.method
            });

        } catch (error) {
            logger.error('Error handling subdomain request:', {
                error: error.message,
                stack: error.stack,
                url: req.url,
                method: req.method
            });
            if (!res.headersSent) {
                res.status(500).json({
                    error: 'Internal server error',
                    message: error.message
                });
            }
        }
    };
}

module.exports = { createSubdomainHandler }; 