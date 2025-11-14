const Docker = require('dockerode');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/init');
const { logger } = require('../utils/logger');
const { SystemLogger } = require('./logger');

let docker;
try {
    docker = new Docker();
} catch (error) {
    logger.error('Failed to initialize Docker:', error);
    docker = null;
}

const CONTAINER_IDLE_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const CONTAINER_MAX_LIFETIME = 2 * 60 * 60 * 1000; // 2 hours

class DockerService {
    static isAvailable() {
        return docker !== null;
    }

    static async createContainer(imageId, userId) {
        if (!this.isAvailable()) {
            throw new Error('Docker service is not available');
        }

        try {
            // Ensure training network exists
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
            const containerName = `training-${subdomain}`;

            // Get image details from database
            const image = await new Promise((resolve, reject) => {
                db.get('SELECT * FROM docker_images WHERE id = ?', [imageId], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });

            if (!image) {
                throw new Error('Image not found');
            }

            logger.info('Creating container:', { imageId, imageName: image.image_id });

            // Create container
            const container = await docker.createContainer({
                Image: image.image_id,
                name: containerName,
                Env: [
                    `TRAINING_SUBDOMAIN=${subdomain}`,
                    `CALLBACK_URL=http://localhost:3000/api/containers/${subdomain}/complete`
                ],
                ExposedPorts: {
                    '8080/tcp': {}
                },
                HostConfig: {
                    NetworkMode: 'training_network',
                    PortBindings: {
                        '8080/tcp': [
                            {
                                HostPort: '0' // Dynamically assign a port
                            }
                        ]
                    },
                    RestartPolicy: {
                        Name: 'no'
                    }
                },
                Labels: {
                    'training.subdomain': subdomain,
                    'training.user': userId.toString(),
                    'training.image': imageId.toString()
                }
            });

            await container.start();

            // Get the assigned port
            const containerData = await container.inspect();
            const hostPort = containerData.NetworkSettings.Ports['8080/tcp'][0].HostPort;

            // Store container info in database
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO containers (container_id, image_id, user_id, subdomain, status, host_port) VALUES (?, ?, ?, ?, ?, ?)',
                    [container.id, imageId, userId, subdomain, 'running', hostPort],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            // Start container monitoring
            this.monitorContainer(container.id, subdomain);

            // Log container creation
            await SystemLogger.logEvent('container_created', userId, container.id, {
                image_id: imageId,
                subdomain,
                host_port: hostPort
            });

            return {
                containerId: container.id,
                subdomain: `${subdomain}.apptraining.dbg.local`
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
            // Get container info before stopping
            const containerInfo = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT user_id, image_id FROM containers WHERE container_id = ?',
                    [containerId],
                    (err, row) => {
                        if (err) reject(err);
                        resolve(row);
                    }
                );
            });

            const container = docker.getContainer(containerId);
            
            // Force stop the container
            try {
                await container.stop();
            } catch (error) {
                logger.warn('Container may already be stopped:', error.message);
            }

            // Force remove the container
            try {
                await container.remove({ force: true, v: true });
            } catch (error) {
                logger.warn('Error removing container:', error.message);
            }

            // Log container stop
            if (containerInfo) {
                await SystemLogger.logEvent('container_stopped', containerInfo.user_id, containerId, {
                    image_id: containerInfo.image_id
                });
            }

            // Update database and cleanup
            await Promise.all([
                new Promise((resolve, reject) => {
                    db.run(
                        'UPDATE containers SET status = ? WHERE container_id = ?',
                        ['stopped', containerId],
                        (err) => {
                            if (err) reject(err);
                            resolve();
                        }
                    );
                }),
                new Promise((resolve, reject) => {
                    db.get('SELECT subdomain FROM containers WHERE container_id = ?', [containerId], (err, row) => {
                        if (err) reject(err);
                        if (row && row.subdomain) {
                            global.containerActivity.delete(row.subdomain);
                        }
                        resolve();
                    });
                })
            ]);

        } catch (error) {
            logger.error('Error stopping container:', error);
            throw error;
        }
    }

    static async monitorContainer(containerId, subdomain) {
        if (!this.isAvailable()) {
            return;
        }

        const container = docker.getContainer(containerId);
        let lastActivity = Date.now();
        const startTime = Date.now();

        // Update last activity when requests are made
        this.setupActivityMonitoring(subdomain, () => {
            lastActivity = Date.now();
        });

        const checkActivity = async () => {
            const now = Date.now();
            const idleTime = now - lastActivity;
            const lifetime = now - startTime;

            if (idleTime >= CONTAINER_IDLE_TIMEOUT || lifetime >= CONTAINER_MAX_LIFETIME) {
                try {
                    await this.stopContainer(containerId);
                    logger.info(`Container ${containerId} stopped due to ${idleTime >= CONTAINER_IDLE_TIMEOUT ? 'inactivity' : 'lifetime limit'}`);
                } catch (error) {
                    logger.error('Error stopping inactive container:', error);
                }
                return;
            }

            setTimeout(checkActivity, 60000); // Check every minute
        };

        checkActivity();
    }

    static setupActivityMonitoring(subdomain, callback) {
        global.containerActivity = global.containerActivity || new Map();
        global.containerActivity.set(subdomain, callback);
    }

    static async handleExerciseCompletion(subdomain, data) {
        try {
            const containerInfo = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT * FROM containers WHERE subdomain = ?',
                    [subdomain],
                    (err, row) => {
                        if (err) reject(err);
                        resolve(row);
                    }
                );
            });

            if (!containerInfo) {
                throw new Error('Container not found');
            }

            // Log exercise completion
            await SystemLogger.logEvent('exercise_completed', containerInfo.user_id, containerInfo.container_id, {
                image_id: containerInfo.image_id,
                completion_data: data
            });

            // Update exercise progress and container status
            await Promise.all([
                new Promise((resolve, reject) => {
                    db.run(
                        `UPDATE exercise_progress 
                         SET status = 'completed', completed_at = CURRENT_TIMESTAMP 
                         WHERE user_id = ? AND image_id = ?`,
                        [containerInfo.user_id, containerInfo.image_id],
                        (err) => {
                            if (err) reject(err);
                            resolve();
                        }
                    );
                }),
                new Promise((resolve, reject) => {
                    db.run(
                        'UPDATE containers SET status = ? WHERE subdomain = ?',
                        ['completed', subdomain],
                        (err) => {
                            if (err) reject(err);
                            resolve();
                        }
                    );
                })
            ]);

            return true;
        } catch (error) {
            logger.error('Error handling exercise completion:', error);
            throw error;
        }
    }

    static async cleanupResources() {
        if (!this.isAvailable()) {
            return;
        }

        try {
            logger.info('Starting container cleanup process');

            // Get all containers from database
            const dbContainers = await new Promise((resolve, reject) => {
                db.all('SELECT * FROM containers', (err, rows) => {
                    if (err) reject(err);
                    resolve(rows || []);
                });
            });

            // Get all containers from Docker with our labels
            const dockerContainers = await docker.listContainers({
                all: true,
                filters: {
                    label: ['training.user']
                }
            });

            // Clean up database records older than 24 hours
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

            // Stop and remove any containers in Docker but not in DB (orphaned)
            for (const dockerContainer of dockerContainers) {
                const containerId = dockerContainer.Id;
                const dbContainer = dbContainers.find(c => c.container_id === containerId);
                
                if (!dbContainer) {
                    logger.warn('Found orphaned container in Docker, removing:', containerId);
                    try {
                        const container = docker.getContainer(containerId);
                        await container.remove({ force: true, v: true });
                    } catch (error) {
                        logger.error('Error removing orphaned container:', error);
                    }
                }
            }

            // Prune Docker resources
            await docker.pruneContainers();
            await docker.pruneNetworks();
            await docker.pruneVolumes();

            logger.info('Container cleanup process completed');
        } catch (error) {
            logger.error('Error during cleanup process:', error);
        }
    }
}

async function setupDockerEvents() {
    if (!DockerService.isAvailable()) {
        logger.warn('Docker service is not available, skipping Docker events setup');
        return;
    }

    try {
        // Create training network if it doesn't exist
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

// Setup periodic cleanup
async function setupPeriodicCleanup() {
    if (!DockerService.isAvailable()) {
        logger.warn('Docker service is not available, skipping periodic cleanup setup');
        return;
    }

    // Run cleanup every 6 hours
    const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000;
    let cleanupInProgress = false;

    const runCleanup = async () => {
        // Prevent multiple cleanups from running simultaneously
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

    // Run initial cleanup
    await runCleanup();

    // Schedule periodic cleanup
    const intervalId = setInterval(runCleanup, CLEANUP_INTERVAL);

    // Handle process termination
    const cleanup = () => {
        clearInterval(intervalId);
        logger.info('Cleanup scheduler stopped');
    };

    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    logger.info(`Periodic cleanup scheduled to run every ${CLEANUP_INTERVAL / (60 * 60 * 1000)} hours`);
}

module.exports = {
    DockerService,
    setupDockerEvents,
    setupPeriodicCleanup
}; 