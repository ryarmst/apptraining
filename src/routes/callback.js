const express = require('express');
const { DockerService } = require('../services/docker');
const { logger } = require('../utils/logger');

const router = express.Router();

router.post('/:subdomain/task', async (req, res) => {
    try {
        const { subdomain } = req.params;
        const token = req.headers['x-callback-token'] || req.body.token;
        const { task_id, evidence } = req.body;

        if (!token) {
            return res.status(401).json({ error: 'Missing callback token' });
        }

        if (!task_id) {
            return res.status(400).json({ error: 'Missing task_id' });
        }

        const result = await DockerService.handleTaskCompletion(subdomain, token, task_id, evidence);
        res.json(result);
    } catch (error) {
        logger.error('Callback error:', error);
        const status = error.message.includes('token') ? 403
            : error.message.includes('not found') ? 404
            : error.message.includes('Unknown task') ? 400
            : 500;
        res.status(status).json({ error: error.message });
    }
});

module.exports = { router };
