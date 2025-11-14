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

/**
 * Initialize Express routers
 */
async function initializeRouters() {
    logger.info('Loading routers...');

    const routers = {
        auth: require('./routes/auth').router,
        exercises: require('./routes/exercises').router,
        admin: require('./routes/admin').router,
        containers: require('./routes/containers').router
    };

    // Log router status
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
        '/api/containers': routers.containers
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
 * Drop root privileges after binding to privileged ports
 */
function dropRootPrivileges() {
    if (process.getuid() === 0) {
        try {
            const username = process.env.SUDO_USER || process.env.USER || 'rarmstrong';
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
            // Drop root privileges after binding to port 443
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