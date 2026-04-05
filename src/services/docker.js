const Docker = require('dockerode');
const { v4: uuidv4 } = require('uuid');
const { db, runAsync } = require('../db/init');
const { logger } = require('../utils/logger');
const { SystemLogger } = require('./logger');
require('dotenv').config();

let docker;
try {
    docker = new Docker();
} catch (error) {
    logger.error('Failed to initialize Docker:', error);
    docker = null;
}

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'training.local';
const CONTAINER_IDLE_TIMEOUT = (parseInt(process.env.CONTAINER_IDLE_TIMEOUT_MINUTES, 10) || 15) * 60 * 1000;
const CONTAINER_MAX_LIFETIME = (parseInt(process.env.CONTAINER_MAX_LIFETIME_HOURS, 10) || 2) * 60 * 60 * 1000;

class DockerService {
    static isAvailable() {
        return docker !== null;
    }

    static async createContainer(imageId, userId) {
        if (!this.isAvailable()) {
            throw new Error('Docker service is not available');
        }

        try {
            const networks = await docker.listNetworks({
                filters: { name: ['training_network'] }
            });

            if (networks.length === 0) {
                logger.info('Creating training network...');
                await docker.createNetwork({
                    Name: 'training_network',
                    Driver: 'bridge'
                });
            }

            const subdomain = uuidv4();
            const callbackToken = uuidv4();
            const containerName = `training-${subdomain}`;

            const image = await new Promise((resolve, reject) => {
                db.get('SELECT * FROM docker_images WHERE id = ?', [imageId], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });

            if (!image) {
                throw new Error('Image not found');
            }

            let metadata = {};
            try {
                metadata = JSON.parse(image.metadata || '{}');
            } catch (e) {
                logger.warn('Failed to parse image metadata:', e);
            }

            const resources = metadata.resources || {};
            const envVars = metadata.environment_variables || {};

            logger.info('Creating container:', { imageId, imageName: image.image_id });

            const hostConfig = {
                NetworkMode: 'training_network',
                PortBindings: {
                    '8080/tcp': [{ HostPort: '0' }]
                },
                RestartPolicy: { Name: 'no' }
            };

            if (resources.memory) {
                const memStr = String(resources.memory).toUpperCase();
                let bytes;
                if (memStr.endsWith('G')) {
                    bytes = parseInt(memStr) * 1024 * 1024 * 1024;
                } else if (memStr.endsWith('M')) {
                    bytes = parseInt(memStr) * 1024 * 1024;
                } else {
                    bytes = parseInt(memStr);
                }
                if (!isNaN(bytes) && bytes > 0) {
                    hostConfig.Memory = bytes;
                    hostConfig.MemorySwap = bytes * 2;
                }
            }

            if (resources.cpu_shares) {
                const shares = parseInt(resources.cpu_shares, 10);
                if (!isNaN(shares) && shares > 0) {
                    hostConfig.CpuShares = shares;
                }
            }

            const taskIds = (metadata.goals || []).map(g => g.id).join(',');

            const containerEnv = [
                `TRAINING_SUBDOMAIN=${subdomain}`,
                `CALLBACK_TOKEN=${callbackToken}`,
                `CALLBACK_URL=http://host.docker.internal:${process.env.PORT || 3000}/api/callback/${subdomain}/task`,
                `PLATFORM_DOMAIN=${PLATFORM_DOMAIN}`,
                `TASK_IDS=${taskIds}`
            ];

            for (const [key, value] of Object.entries(envVars)) {
                containerEnv.push(`${key}=${value}`);
            }

            const container = await docker.createContainer({
                Image: image.image_id,
                name: containerName,
                Env: containerEnv,
                ExposedPorts: { '8080/tcp': {} },
                HostConfig: hostConfig,
                Labels: {
                    'training.subdomain': subdomain,
                    'training.user': userId.toString(),
                    'training.image': imageId.toString()
                }
            });

            await container.start();

            const containerData = await container.inspect();
            const hostPort = containerData.NetworkSettings.Ports['8080/tcp'][0].HostPort;

            await new Promise((resolve, reject) => {
                db.run(
                    `INSERT INTO containers (container_id, image_id, user_id, subdomain, callback_token, status, host_port)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [container.id, imageId, userId, subdomain, callbackToken, 'running', hostPort],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            this.monitorContainer(container.id, subdomain);

            await SystemLogger.logEvent('container_created', userId, container.id, {
                image_id: imageId,
                subdomain,
                host_port: hostPort
            });

            return {
                containerId: container.id,
                subdomain: `${subdomain}.${PLATFORM_DOMAIN}`
            };
        } catch (error) {
            logger.error('Error creating container:', error);
            throw error;
        }
    }

    static async stopContainer(containerId) {
        if (!this.isAvailable()) {
            throw new Error('Docker service is not available');
        }

        try {
            const containerInfo = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT user_id, image_id, subdomain FROM containers WHERE container_id = ?',
                    [containerId],
                    (err, row) => {
                        if (err) reject(err);
                        resolve(row);
                    }
                );
            });

            const container = docker.getContainer(containerId);

            try {
                await container.stop({ t: 5 });
            } catch (error) {
                if (error.statusCode !== 304) {
                    logger.warn('Container may already be stopped:', error.message);
                }
            }

            try {
                await container.remove({ force: true, v: true });
            } catch (error) {
                logger.warn('Error removing container:', error.message);
            }

            if (containerInfo) {
                await SystemLogger.logEvent('container_stopped', containerInfo.user_id, containerId, {
                    image_id: containerInfo.image_id
                });
                if (containerInfo.subdomain) {
                    global.containerActivity.delete(containerInfo.subdomain);
                }
            }

            await new Promise((resolve, reject) => {
                db.run(
                    'UPDATE containers SET status = ? WHERE container_id = ?',
                    ['stopped', containerId],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

        } catch (error) {
            logger.error('Error stopping container:', error);
            throw error;
        }
    }

    static async monitorContainer(containerId, subdomain) {
        if (!this.isAvailable()) return;

        const container = docker.getContainer(containerId);
        let lastActivity = Date.now();
        const startTime = Date.now();

        this.setupActivityMonitoring(subdomain, () => {
            lastActivity = Date.now();
        });

        const checkActivity = async () => {
            try {
                const info = await container.inspect();
                if (!info.State.Running) {
                    logger.info(`Container ${containerId} is no longer running`);
                    global.containerActivity.delete(subdomain);
                    return;
                }
            } catch (error) {
                logger.info(`Container ${containerId} no longer exists, stopping monitor`);
                global.containerActivity.delete(subdomain);
                return;
            }

            const now = Date.now();
            const idleTime = now - lastActivity;
            const lifetime = now - startTime;

            if (idleTime >= CONTAINER_IDLE_TIMEOUT || lifetime >= CONTAINER_MAX_LIFETIME) {
                try {
                    const reason = idleTime >= CONTAINER_IDLE_TIMEOUT ? 'inactivity' : 'lifetime limit';
                    await this.stopContainer(containerId);
                    logger.info(`Container ${containerId} stopped due to ${reason}`);
                } catch (error) {
                    logger.error('Error stopping inactive container:', error);
                }
                return;
            }

            setTimeout(checkActivity, 60000);
        };

        checkActivity();
    }

    static setupActivityMonitoring(subdomain, callback) {
        global.containerActivity = global.containerActivity || new Map();
        global.containerActivity.set(subdomain, callback);
    }

    static async handleTaskCompletion(subdomain, callbackToken, taskId, evidence) {
        const containerInfo = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM containers WHERE subdomain = ? AND status = ?',
                [subdomain, 'running'],
                (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                }
            );
        });

        if (!containerInfo) {
            throw new Error('Container not found or not running');
        }

        if (containerInfo.callback_token !== callbackToken) {
            throw new Error('Invalid callback token');
        }

        const image = await new Promise((resolve, reject) => {
            db.get('SELECT metadata FROM docker_images WHERE id = ?', [containerInfo.image_id], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        let metadata = {};
        try {
            metadata = JSON.parse(image?.metadata || '{}');
        } catch (e) { /* ignore */ }

        const validTaskIds = (metadata.goals || []).map(g => g.id);
        if (validTaskIds.length > 0 && !validTaskIds.includes(taskId)) {
            throw new Error(`Unknown task_id: ${taskId}`);
        }

        await new Promise((resolve, reject) => {
            db.run(
                `INSERT OR IGNORE INTO task_completions (user_id, image_id, container_id, task_id, evidence)
                 VALUES (?, ?, ?, ?, ?)`,
                [containerInfo.user_id, containerInfo.image_id, containerInfo.container_id, taskId, evidence ? JSON.stringify(evidence) : null],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });

        await SystemLogger.logEvent('task_completed', containerInfo.user_id, containerInfo.container_id, {
            image_id: containerInfo.image_id,
            task_id: taskId
        });

        const completedCount = await new Promise((resolve, reject) => {
            db.get(
                'SELECT COUNT(*) as count FROM task_completions WHERE user_id = ? AND image_id = ?',
                [containerInfo.user_id, containerInfo.image_id],
                (err, row) => {
                    if (err) reject(err);
                    resolve(row?.count || 0);
                }
            );
        });

        const totalTasks = validTaskIds.length;
        const allComplete = totalTasks > 0 && completedCount >= totalTasks;

        if (allComplete) {
            await new Promise((resolve, reject) => {
                db.run(
                    `UPDATE exercise_progress SET status = 'completed', completed_at = CURRENT_TIMESTAMP
                     WHERE user_id = ? AND image_id = ?`,
                    [containerInfo.user_id, containerInfo.image_id],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            await new Promise((resolve, reject) => {
                db.run(
                    'UPDATE containers SET status = ? WHERE subdomain = ?',
                    ['completed', subdomain],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            await SystemLogger.logEvent('exercise_completed', containerInfo.user_id, containerInfo.container_id, {
                image_id: containerInfo.image_id,
                tasks_completed: completedCount,
                tasks_total: totalTasks
            });
        }

        return {
            task_id: taskId,
            accepted: true,
            tasks_completed: completedCount,
            tasks_total: totalTasks,
            exercise_complete: allComplete
        };
    }

    static async cleanupResources() {
        if (!this.isAvailable()) return;

        try {
            logger.info('Starting container cleanup process');

            const dbContainers = await new Promise((resolve, reject) => {
                db.all('SELECT * FROM containers', (err, rows) => {
                    if (err) reject(err);
                    resolve(rows || []);
                });
            });

            const dockerContainers = await docker.listContainers({
                all: true,
                filters: { label: ['training.user'] }
            });

            await new Promise((resolve, reject) => {
                db.run(
                    `DELETE FROM containers
                     WHERE status = 'stopped'
                     AND datetime(created_at) < datetime('now', '-24 hours')`,
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            for (const dc of dockerContainers) {
                const containerId = dc.Id;
                const dbContainer = dbContainers.find(c => c.container_id === containerId);

                if (!dbContainer) {
                    logger.warn('Found orphaned container, removing:', containerId);
                    try {
                        const container = docker.getContainer(containerId);
                        await container.remove({ force: true, v: true });
                    } catch (error) {
                        logger.error('Error removing orphaned container:', error);
                    }
                    continue;
                }

                if (dbContainer.status === 'running') {
                    try {
                        const container = docker.getContainer(containerId);
                        const info = await container.inspect();
                        if (!info.State.Running) {
                            logger.info('Container in DB as running but actually stopped, updating:', containerId);
                            await new Promise((resolve, reject) => {
                                db.run('UPDATE containers SET status = ? WHERE container_id = ?', ['stopped', containerId], (err) => {
                                    if (err) reject(err);
                                    resolve();
                                });
                            });
                            try {
                                await container.remove({ force: true, v: true });
                            } catch (e) { /* ignore */ }
                        }
                    } catch (error) {
                        logger.warn('Could not inspect container during cleanup:', error.message);
                    }
                }
            }

            await docker.pruneContainers();
            await docker.pruneNetworks();

            logger.info('Container cleanup process completed');
        } catch (error) {
            logger.error('Error during cleanup process:', error);
        }
    }

    static async getImageHealth() {
        if (!this.isAvailable()) return [];

        try {
            const dbImages = await new Promise((resolve, reject) => {
                db.all('SELECT * FROM docker_images', (err, rows) => {
                    if (err) reject(err);
                    resolve(rows || []);
                });
            });

            const results = [];
            for (const dbImage of dbImages) {
                let dockerStatus = 'missing';
                let size = null;
                try {
                    const img = docker.getImage(dbImage.image_id);
                    const info = await img.inspect();
                    dockerStatus = 'available';
                    size = info.Size;
                } catch (e) {
                    dockerStatus = 'missing';
                }

                const activeContainers = await new Promise((resolve, reject) => {
                    db.get(
                        'SELECT COUNT(*) as count FROM containers WHERE image_id = ? AND status = ?',
                        [dbImage.id, 'running'],
                        (err, row) => {
                            if (err) reject(err);
                            resolve(row?.count || 0);
                        }
                    );
                });

                results.push({
                    id: dbImage.id,
                    name: dbImage.name,
                    version: dbImage.version,
                    image_tag: dbImage.image_id,
                    docker_status: dockerStatus,
                    size,
                    active_containers: activeContainers,
                    created_at: dbImage.created_at
                });
            }

            return results;
        } catch (error) {
            logger.error('Error checking image health:', error);
            return [];
        }
    }
}

async function setupDockerEvents() {
    if (!DockerService.isAvailable()) {
        logger.warn('Docker service is not available, skipping Docker events setup');
        return;
    }

    try {
        const networks = await docker.listNetworks({
            filters: { name: ['training_network'] }
        });

        if (networks.length === 0) {
            await docker.createNetwork({
                Name: 'training_network',
                Driver: 'bridge'
            });
        }

        logger.info('Docker events setup completed');
    } catch (error) {
        logger.error('Error setting up Docker events:', error);
        throw error;
    }
}

async function setupPeriodicCleanup() {
    if (!DockerService.isAvailable()) {
        logger.warn('Docker service is not available, skipping periodic cleanup setup');
        return;
    }

    const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000;
    let cleanupInProgress = false;

    const runCleanup = async () => {
        if (cleanupInProgress) {
            logger.warn('Cleanup already in progress, skipping this iteration');
            return;
        }

        cleanupInProgress = true;
        try {
            logger.info('Starting scheduled cleanup');
            await DockerService.cleanupResources();
            logger.info('Scheduled cleanup completed successfully');
        } catch (error) {
            logger.error('Error in scheduled cleanup:', error);
        } finally {
            cleanupInProgress = false;
        }
    };

    await runCleanup();

    const intervalId = setInterval(runCleanup, CLEANUP_INTERVAL);

    const cleanup = async () => {
        clearInterval(intervalId);
        logger.info('Shutting down -- stopping all training containers');
        try {
            const running = await new Promise((resolve, reject) => {
                db.all("SELECT container_id FROM containers WHERE status = 'running'", (err, rows) => {
                    if (err) reject(err);
                    resolve(rows || []);
                });
            });
            for (const c of running) {
                try {
                    await DockerService.stopContainer(c.container_id);
                } catch (e) {
                    logger.error('Error stopping container during shutdown:', e);
                }
            }
        } catch (e) {
            logger.error('Error during shutdown cleanup:', e);
        }
        process.exit(0);
    };

    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    logger.info(`Periodic cleanup scheduled every ${CLEANUP_INTERVAL / (60 * 60 * 1000)} hours`);
}

module.exports = {
    DockerService,
    setupDockerEvents,
    setupPeriodicCleanup
};
