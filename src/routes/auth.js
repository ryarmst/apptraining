const express = require('express');
const argon2 = require('argon2');
const { body, validationResult } = require('express-validator');
const { db } = require('../db/init');
const { logger } = require('../utils/logger');
const { SystemLogger } = require('../services/logger');

const router = express.Router();

// Set up periodic session cleanup
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
setInterval(async () => {
    try {
        await SystemLogger.cleanupExpiredSessions();
    } catch (error) {
        logger.error('Session cleanup failed:', error);
    }
}, CLEANUP_INTERVAL);

// Middleware to check if user is authenticated
const isAuthenticated = async (req, res, next) => {
    if (req.session.userId) {
        try {
            // Update session activity
            await SystemLogger.updateSessionActivity(req.sessionID);
            next();
        } catch (error) {
            logger.error('Error updating session activity:', error);
            next(); // Continue despite error to not disrupt user experience
        }
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Middleware to check if user is admin
const isAdmin = (req, res, next) => {
    if (req.session.userRole === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Forbidden' });
    }
};

// Check authentication status
router.get('/check', (req, res) => {
    if (req.session.userId) {
        res.status(200).json({
            authenticated: true,
            user: {
                id: req.session.userId,
                isAdmin: req.session.userRole === 'admin'
            }
        });
    } else {
        res.status(401).json({
            authenticated: false,
            error: 'Not authenticated'
        });
    }
});

// Register new user
router.post('/register', [
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').isLength({ min: 15 }).withMessage('Password must be at least 15 characters long'),
], async (req, res) => {
    const { username, password } = req.body;

    try {
        // Check if username exists
        const existingUser = await new Promise((resolve, reject) => {
            db.get('SELECT id FROM users WHERE username = ?', [username], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (existingUser) {
            await SystemLogger.logEvent('register_failed', null, username, {
                reason: 'Username already exists',
                ip: req.ip
            });
            return res.status(400).json({ error: 'Username already exists' });
        }

        if (password.length < 15) {
            await SystemLogger.logEvent('register_failed', null, username, {
                reason: 'Password too short',
                ip: req.ip
            });
            return res.status(400).json({ error: 'Password must be at least 15 characters long' });
        }

        // Hash password with Argon2id (recommended variant)
        const hashedPassword = await argon2.hash(password, {
            type: argon2.argon2id,
            memoryCost: 65536, // 64MB
            timeCost: 3, // 3 iterations
            parallelism: 4,
            saltLength: 16
        });

        const result = await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
                [username, hashedPassword, 'user'],
                function(err) {
                    if (err) reject(err);
                    resolve(this.lastID);
                }
            );
        });

        await SystemLogger.logEvent('user_created', result, null, {
            username,
            ip: req.ip
        });

        res.json({ message: 'Registration successful' });
    } catch (error) {
        logger.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Login
router.post('/login', [
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').exists(),
], async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!user || !(await argon2.verify(user.password, password))) {
            await SystemLogger.logEvent('login_failed', null, username, {
                reason: 'Invalid credentials',
                ip: req.ip
            });
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        req.session.userId = user.id;
        req.session.userRole = user.role;

        // Track session
        await SystemLogger.trackSession(req.sessionID, user.id, req);
        await SystemLogger.logEvent('login_success', user.id, null, {
            ip: req.ip
        });

        res.json({ 
            message: 'Login successful',
            isAdmin: user.role === 'admin'
        });
    } catch (error) {
        logger.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Logout
router.post('/logout', async (req, res) => {
    try {
        if (req.session.userId) {
            await SystemLogger.logEvent('logout', req.session.userId, null, {
                ip: req.ip
            });
            await SystemLogger.removeSession(req.sessionID);
        }
        
        req.session.destroy();
        res.json({ message: 'Logout successful' });
    } catch (error) {
        logger.error('Logout error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get current user
router.get('/me', isAuthenticated, async (req, res) => {
    try {
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT id, username, role FROM users WHERE id = ?', [req.session.userId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            user: {
                id: user.id,
                username: user.username,
                isAdmin: user.role === 'admin'
            }
        });
    } catch (error) {
        logger.error('Get user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = {
    router,
    isAuthenticated,
    isAdmin
}; 