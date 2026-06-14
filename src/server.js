const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { initializeDatabase } = require('./db/init');
const { setupDockerEvents, setupPeriodicCleanup } = require('./services/docker');
const { logger } = require('./utils/logger');
const { createSubdomainHandler } = require('./middleware/subdomain');
require('dotenv').config();

// Ensure required directories exist
['data', 'logs', 'uploads/exercises'].forEach(dir => {
    const dirPath = path.join(__dirname, '..', dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
});

/**
 * Application configuration
 */
const CONFIG = {
    port: process.env.PORT || 3000,
    sslPort: process.env.SSL_PORT || 443,
    sslCert: process.env.SSL_CERT_PATH || '/etc/ssl/certs/apptraining/apptraining.pem',
    sslKey: process.env.SSL_KEY_PATH || '/etc/ssl/private/apptraining/apptraining.key',
    sessionSecret: process.env.SESSION_SECRET || 'your-secret-key'
};

if (CONFIG.sessionSecret === 'your-secret-key') {
    logger.warn('Using default SESSION_SECRET -- set a secure value in .env for production');
}

/**
 * Initialize Express routers
 */
async function initializeRouters() {
    logger.info('Loading routers...');

    const routers = {
        auth: require('./routes/auth').router,
        exercises: require('./routes/exercises').router,
        admin: require('./routes/admin').router,
        containers: require('./routes/containers').router,
        callback: require('./routes/callback').router
    };

    Object.entries(routers).forEach(([name, router]) => {
        logger.info(`${name} router:`, { type: typeof router });
    });

    return routers;
}

/**
 * Configure session handling
 */
function configureSession() {
    // Create SQLite session store
    const sessionStore = new SQLiteStore({
        dir: './data',
        db: 'sessions.db',
        table: 'sessions',
        concurrentDB: true // Enable WAL mode for better concurrency
    });

    // Handle session store errors
    sessionStore.on('error', (error) => {
        logger.error('Session store error:', error);
    });

    return session({
        store: sessionStore,
        secret: CONFIG.sessionSecret,
        resave: false, // Changed to false since SQLite store supports touch
        saveUninitialized: false,
        rolling: true,
        cookie: {
            secure: process.env.NODE_ENV === 'production',
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        }
    });
}

/**
 * Configure SSL for HTTPS server
 */
function configureSSL() {
    return {
        cert: fs.readFileSync(CONFIG.sslCert),
        key: fs.readFileSync(CONFIG.sslKey)
    };
}

/**
 * Configure and mount API routes
 * @param {Express} app - Express application instance
 * @param {Object} routers - Object containing router instances
 */
function mountAPIRoutes(app, routers) {
    logger.info('Setting up API routes...');

    const routes = {
        '/api/auth': routers.auth,
        '/api/exercises': routers.exercises,
        '/api/admin': routers.admin,
        '/api/containers': routers.containers,
        '/api/callback': routers.callback
    };

    Object.entries(routes).forEach(([path, router]) => {
        if (router) {
            app.use(path, router);
        } else {
            logger.error(`${path} router is undefined`);
        }
    });
}

/**
 * Configure and start the HTTP server that redirects to HTTPS
 * @param {number} port - Port to listen on
 */
function startHTTPServer(port) {
    const httpApp = express();
    httpApp.use((req, res) => {
        res.redirect(`https://${req.headers.host}${req.url}`);
    });
    httpApp.listen(port, () => {
        logger.info(`HTTP Server running on port ${port} (redirecting to HTTPS)`);
    });
}

/**
 * Allow Docker containers to reach the host's HTTPS port for task callbacks.
 * Adds an iptables INPUT ACCEPT rule for RFC-1918 172.16.0.0/12 (covers all
 * default Docker bridge ranges) scoped to the SSL port. Must run as root.
 */
function configureDockerCallbackAccess() {
    if (process.getuid() !== 0) {
        logger.warn('Not running as root — skipping iptables callback rule. Containers may not be able to reach the callback endpoint.');
        return;
    }
    const { execSync } = require('child_process');
    const port = CONFIG.sslPort;
    const subnet = '172.16.0.0/12';
    const rule = `-s ${subnet} -p tcp --dport ${port} -j ACCEPT`;
    try {
        execSync(`iptables -C INPUT ${rule} 2>/dev/null || iptables -I INPUT ${rule}`);
        logger.info(`iptables: allowed INPUT from ${subnet} to port ${port} for container callbacks`);
    } catch (e) {
        logger.error('iptables: failed to add callback rule:', e.message);
    }
}

/**
 * Drop root privileges after binding to privileged ports
 */
function dropRootPrivileges() {
    if (fs.existsSync('/.dockerenv')) {
        logger.info('Running in container — keeping root for Docker socket access');
        return;
    }
    if (process.getuid() === 0) {
        try {
            const username = process.env.SUDO_USER || process.env.USER || 'nobody';
            const userInfo = require('os').userInfo(username);
            process.setgid(userInfo.gid);
            process.setuid(userInfo.uid);
            logger.info(`Dropped root privileges, now running as ${username}`);
        } catch (error) {
            logger.error('Failed to drop root privileges:', error);
        }
    }
}

/**
 * Initialize and start the application
 */
async function startServer() {
    try {
        // Initialize core services
        await initializeDatabase();
        await setupDockerEvents();
        await setupPeriodicCleanup();
        const routers = await initializeRouters();

        // Initialize global container activity tracking
        global.containerActivity = new Map();

        // Create and configure Express app
        const app = express();

        // Disable CORS
        app.use(cors({
            origin: false,
            credentials: false
        }));

        // Configure session before any routes
        const sessionMiddleware = configureSession();
        app.use((req, res, next) => {
            sessionMiddleware(req, res, (err) => {
                if (err) {
                    logger.error('Session middleware error:', err);
                    return res.status(500).json({ error: 'Internal server error' });
                }
                next();
            });
        });

        // Request parsing
        app.use(express.json());
        app.use(express.urlencoded({ extended: true }));

        // Check for subdomain requests first 
        app.use((req, res, next) => {
            if (req.subdomains.length > 0) {
                return createSubdomainHandler()(req, res, next);
            }
            next();
        });

        // Mount API routes
        mountAPIRoutes(app, routers);

        // Serve static files
        app.use(express.static(path.join(__dirname, '../public')));

        // Redirect all non-API routes to index.html
        app.get('*', (req, res, next) => {
            // Skip if it's an API request or static file
            if (req.path.startsWith('/api') || req.path.includes('.')) {
                return next();
            }
            res.redirect('/');
        });

        // Error handling
        app.use((err, req, res, next) => {
            logger.error('Application error:', err);
            res.status(500).json({
                error: 'Internal Server Error',
                message: process.env.NODE_ENV === 'development' ? err.message : undefined
            });
        });

        // Start HTTPS server
        const httpsServer = https.createServer(configureSSL(), app);
        httpsServer.listen(CONFIG.sslPort, () => {
            logger.info(`HTTPS Server running on port ${CONFIG.sslPort}`);
            configureDockerCallbackAccess();
            dropRootPrivileges();
        });

        // Start HTTP redirect server
        startHTTPServer(CONFIG.port);

    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Start the server
startServer(); 