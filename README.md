# Security Testing Training Platform

A Docker-based platform for training security testers through hands-on exercises. Unlike CTF-style flag hunting, this platform tracks **methodological competency** -- users demonstrate proficiency by completing defined checks/test cases within each exercise, and the platform records what was completed, when, and how.

## Architecture

- **Main Application** (Node.js/Express) -- Hosts exercises, manages Docker containers, tracks progress, provides admin dashboards.
- **Exercise Containers** -- Each exercise runs in an isolated Docker container with a unique subdomain. Containers report task completions back to the main app via an authenticated callback API.
- **Tech-agnostic** -- Exercises can be built with any technology (Node, Python, Go, etc.) as long as they expose port 8080 and include the callback script.

## Requirements

- Node.js 18+
- Docker Engine
- SQLite3
- Linux environment with wildcard subdomain DNS (e.g. `*.apptraining.dbg.local`)

## Installation

```bash
# Clone and install
git clone <repository-url>
cd app-security-training
npm install

# Create required directories
mkdir -p data logs uploads/exercises

# Configure environment
cp .env.example .env
# Edit .env with your settings (domain, SSL paths, admin credentials, etc.)

# Start the application
npm start        # Production (HTTPS on 443)
npm run dev      # Development (auto-reload with nodemon)
```

## How It Works

### Exercise Lifecycle

1. Admin uploads an exercise package (`.tar.gz` / `.zip`) containing a `Dockerfile`, `metadata.json`, and the exercise code.
2. The platform builds a Docker image from the package.
3. Users browse available exercises and launch containers. Each container gets:
   - A unique subdomain (UUID-based)
   - An authenticated callback token
   - Environment variables for reporting task completions
4. As users work through the exercise, the container reports completed tasks via `check-completion.sh` or direct API calls.
5. The platform tracks individual task completions per user per exercise.
6. Containers auto-stop after 15 min idle or 2 hours total lifetime.

### Task Completion Tracking

Each exercise defines **goals** (tasks/checks) in `metadata.json`. The platform tracks:
- Which tasks each user has completed
- When each task was completed (timestamps)
- Optional evidence/notes submitted with completions
- Overall exercise completion (all tasks done)

Containers report completions via:

```bash
# Using the provided script inside the container
check-completion.sh <task_id> ['{"evidence":"json"}']

# Or via direct API call
curl -X POST "$CALLBACK_URL" \
  -H "Content-Type: application/json" \
  -H "X-Callback-Token: $CALLBACK_TOKEN" \
  -d '{"task_id": "auth_bypass", "evidence": {"method": "UNION-based"}}'
```

## Exercise Format

Exercises are packaged as archives with this structure:

```
exercise.tar.gz
├── Dockerfile          # Must expose port 8080
├── metadata.json       # Exercise metadata and task definitions
├── check-completion.sh # Task reporting script (provided in examples/)
├── package.json        # Dependencies (if Node-based)
├── server.js           # Main app (or any entry point)
└── public/             # Static files
```

### metadata.json

```json
{
    "title": "SQL Injection Basic",
    "version": "1.0.0",
    "description": "Identify and exploit basic SQL injection vulnerabilities",
    "level": "beginner",
    "goals": [
        {
            "id": "auth_bypass",
            "description": "Bypass login authentication using SQL injection",
            "hint": "Try manipulating the login form input"
        },
        {
            "id": "data_extract",
            "description": "Extract hidden user data from the database",
            "hint": "Look for ways to modify SQL queries in the UI"
        }
    ],
    "resources": {
        "memory": "512M",
        "cpu_shares": 1024
    }
}
```

### Dockerfile Requirements

- Must listen on port **8080** and bind to **0.0.0.0**
- Should run as non-root user
- Should include a health check
- See `examples/exercise-template/Dockerfile` and `Lab_instructions.md` for full guidance.

## API Endpoints

### Authentication
- `POST /api/auth/register` -- Register new user
- `POST /api/auth/login` -- Login
- `POST /api/auth/logout` -- Logout
- `GET /api/auth/check` -- Check auth status
- `GET /api/auth/me` -- Get current user

### Exercises & Progress
- `GET /api/exercises` -- List exercises with per-user task progress
- `GET /api/exercises/progress` -- Detailed progress for current user
- `POST /api/exercises/upload` -- Upload new exercise (admin)
- `PUT /api/exercises/:id` -- Update exercise metadata (admin)
- `DELETE /api/exercises/:id` -- Delete exercise (admin)

### Containers
- `GET /api/containers` -- List user's running containers
- `POST /api/containers/launch/:imageId` -- Launch exercise container
- `POST /api/containers/:containerId/stop` -- Stop container

### Callback (from containers)
- `POST /api/callback/:subdomain/task` -- Report task completion (token-authenticated)

### Admin
- `GET /api/admin/users` -- List users
- `DELETE /api/admin/users/:userId` -- Delete user
- `GET /api/admin/users/:userId/progress` -- User's detailed progress
- `GET /api/admin/results` -- All users' results matrix
- `GET /api/admin/stats` -- System statistics
- `GET /api/admin/containers` -- Running containers
- `POST /api/admin/containers/:containerId/stop` -- Force stop
- `GET /api/admin/images/health` -- Docker image health status
- `GET /api/admin/logs` -- System event logs
- `GET /api/admin/sessions` -- Active sessions
- `POST /api/admin/sessions/:sessionId/terminate` -- Terminate session

## Container Management

- **Idle timeout**: Containers stop after 15 minutes of inactivity (configurable)
- **Max lifetime**: 2 hours per container (configurable)
- **Per-user limit**: 3 concurrent containers (configurable)
- **Periodic cleanup**: Every 6 hours, orphaned containers are removed and stale DB records cleaned
- **Graceful shutdown**: All training containers are stopped when the server shuts down
- **Resource limits**: Memory and CPU limits applied per exercise metadata
- **Admin visibility**: Real-time view of all running containers, image health status, and system logs
