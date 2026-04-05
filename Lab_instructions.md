# Creating Training Exercises

This guide outlines the requirements and best practices for creating exercises for the Security Testing Training Platform.

## Exercise Structure
```
exercise_name/
├── Dockerfile           # Container configuration (MUST expose 8080)
├── metadata.json        # Exercise metadata and task definitions
├── check-completion.sh  # Task reporting script
├── package.json         # Dependencies (if applicable)
├── server.js            # Main application (or any entry point)
├── public/              # Static files
│   ├── index.html
│   └── script.js
└── readme.md            # Exercise documentation
```

## Required Files

### 1. metadata.json
```json
{
    "title": "Exercise Name",
    "version": "1.0.0",
    "description": "Brief description of the exercise",
    "level": "beginner",
    "goals": [
        {
            "id": "task_1",
            "description": "Description of the first task/check",
            "hint": "Optional hint"
        },
        {
            "id": "task_2",
            "description": "Description of the second task/check",
            "hint": "Optional hint"
        }
    ],
    "resources": {
        "memory": "512M",
        "cpu_shares": 1024
    }
}
```

**Fields:**
- `title` (required): Display name
- `version` (required): Semantic version
- `description` (required): Brief description shown to users
- `level` (required): `beginner`, `intermediate`, or `advanced`
- `goals` (required): Array of tasks/checks the user must complete. Each needs a unique `id` and a `description`. The `hint` is shown to users.
- `resources` (optional): Container resource limits. `memory` accepts values like `256M`, `1G`. `cpu_shares` is relative CPU weight (default 1024).

### 2. Dockerfile
```dockerfile
FROM node:18-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r appuser && useradd -r -g appuser -s /bin/false appuser

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

COPY check-completion.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/check-completion.sh

RUN chown -R appuser:appuser /usr/src/app
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s \
    CMD curl -f http://localhost:8080/ || exit 1

CMD [ "node", "server.js" ]
```

### 3. Application Code

The app **must** listen on port 8080 and bind to 0.0.0.0:

```javascript
const port = 8080;
app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
});
```

### 4. Task Reporting

When the exercise determines a user has completed a task/check, report it using the `check-completion.sh` script or a direct API call.

**Using the script:**
```bash
check-completion.sh task_1
check-completion.sh task_2 '{"method":"UNION-based","query":"SELECT..."}'
```

**Using curl directly:**
```bash
curl -X POST "$CALLBACK_URL" \
  -H "Content-Type: application/json" \
  -H "X-Callback-Token: $CALLBACK_TOKEN" \
  -d '{"task_id": "task_1", "evidence": {"notes": "user found the issue"}}'
```

**Using JavaScript (from within the exercise app):**
```javascript
const axios = require('axios');

async function reportTask(taskId, evidence = null) {
    await axios.post(process.env.CALLBACK_URL, {
        task_id: taskId,
        evidence
    }, {
        headers: { 'X-Callback-Token': process.env.CALLBACK_TOKEN }
    });
}
```

### Container Environment Variables

The platform injects these into every container:

| Variable | Description |
|----------|-------------|
| `CALLBACK_URL` | Full URL to POST task completions |
| `CALLBACK_TOKEN` | Secret token for authenticating callbacks |
| `TRAINING_SUBDOMAIN` | Container's unique subdomain (UUID) |
| `PLATFORM_DOMAIN` | Platform's base domain |
| `TASK_IDS` | Comma-separated list of expected task IDs |

## Design Philosophy

This platform trains **methodological competency**, not flag-finding. When designing exercises:

1. **Define tasks as methodology steps**, not flags. Instead of "find the flag", define tasks like "Identify the injection point", "Demonstrate data extraction", "Verify the remediation".

2. **Automated vs. manual verification**: Tasks can be verified automatically (the exercise app detects the user's action and calls `check-completion.sh`) or manually (the user triggers completion themselves after demonstrating the skill).

3. **Evidence tracking**: Use the `evidence` field to capture how the user completed the task. This helps admins review methodology quality.

4. **Progressive difficulty**: Order goals from basic to advanced. Earlier tasks should build toward later ones.

## Critical Requirements

### Port Configuration
- The application MUST listen on port 8080
- The server MUST bind to 0.0.0.0 (not localhost/127.0.0.1)
- The Dockerfile MUST expose port 8080

### Security
- Run containers as non-root user
- Include health checks
- Remove unnecessary packages after installation

### Container
- Base image should be stable and slim
- Keep container size minimal
- Include only necessary dependencies
- Proper error handling and logging

## Testing

Before submitting an exercise:
1. Build the container locally: `docker build -t test-exercise .`
2. Run it: `docker run -p 8080:8080 -e CALLBACK_URL=http://localhost:3000/test -e CALLBACK_TOKEN=test -e TASK_IDS=task_1,task_2 test-exercise`
3. Verify the app is accessible at `http://localhost:8080`
4. Test each task completion path
5. Verify health check passes
6. Validate metadata.json format
