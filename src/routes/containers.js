const express = require('express');
const { DockerService } = require('../services/docker');
const { isAuthenticated } = require('../routes/auth');
const { logger } = require('../utils/logger');
const { db } = require('../db/init');

const router = express.Router();

// Get user's running containers
router.get('/', isAuthenticated, async (req, res) => {
    try {
        const containers = await new Promise((resolve, reject) => {
            db.all(
                `SELECT c.*, i.name as image_name, i.level, i.description
                 FROM containers c 
                 JOIN docker_images i ON c.image_id = i.id 
                 WHERE c.user_id = ? AND c.status = 'running'
                 ORDER BY c.created_at DESC`,
                [req.session.userId],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });

        res.json({ containers });
    } catch (error) {
        logger.error('Error getting containers:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Launch new container
router.post('/launch/:imageId', isAuthenticated, async (req, res) => {
    try {
        const { imageId } = req.params;

        // Check if user already has a running container for this image
        const existingContainer = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM containers WHERE user_id = ? AND image_id = ? AND status = ?',
                [req.session.userId, imageId, 'running'],
                (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                }
            );
        });

        if (existingContainer) {
            return res.status(400).json({
                error: 'Container already running for this exercise',
                containerId: existingContainer.container_id,
                subdomain: `${existingContainer.subdomain}.apptraining.dbg.local`,
                message: 'You already have a running instance of this exercise. Please use the existing container or stop it first.'
            });
        }

        // Check total number of running containers for user
        const runningContainers = await new Promise((resolve, reject) => {
            db.get(
                'SELECT COUNT(*) as count FROM containers WHERE user_id = ? AND status = ?',
                [req.session.userId, 'running'],
                (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                }
            );
        });

        if (runningContainers.count >= 3) {
            return res.status(400).json({
                error: 'Maximum container limit reached',
                message: 'You can only have 3 active containers at a time. Please stop an existing container before launching a new one.'
            });
        }

        // Create new container
        const containerInfo = await DockerService.createContainer(imageId, req.session.userId);

        // Update exercise progress
        await new Promise((resolve, reject) => {
            db.run(
                `INSERT OR REPLACE INTO exercise_progress (user_id, image_id, status, attempts)
                 VALUES (?, ?, 'in_progress', COALESCE((SELECT attempts + 1 FROM exercise_progress 
                 WHERE user_id = ? AND image_id = ?), 1))`,
                [req.session.userId, imageId, req.session.userId, imageId],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });

        res.json(containerInfo);
    } catch (error) {
        logger.error('Error launching container:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Stop container
router.post('/:containerId/stop', isAuthenticated, async (req, res) => {
    try {
        const { containerId } = req.params;

        // Verify container belongs to user
        const container = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM containers WHERE container_id = ? AND user_id = ?',
                [containerId, req.session.userId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                }
            );
        });

        if (!container) {
            return res.status(404).json({ error: 'Container not found' });
        }

        await DockerService.stopContainer(containerId);
        res.json({ message: 'Container stopped successfully' });
    } catch (error) {
        logger.error('Error stopping container:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Handle exercise completion callback
router.post('/:subdomain/complete', async (req, res) => {
    try {
        const { subdomain } = req.params;
        const result = await DockerService.handleExerciseCompletion(subdomain, req.body);
        res.json({ success: result });
    } catch (error) {
        logger.error('Error handling exercise completion:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Track container activity
router.use('/:subdomain/*', (req, res, next) => {
    const { subdomain } = req.params;
    const activityCallback = global.containerActivity.get(subdomain);
    if (activityCallback) {
        activityCallback();
    }
    next();
});

module.exports = { router }; 