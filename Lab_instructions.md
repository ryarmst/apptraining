# Creating Training Exercises

This guide outlines the requirements and best practices for creating exercises for the Security Testing Training Platform.

## Repository Layout

Labs are organised by topic in numbered folders. Each topic contains one or more labs:

```
labs/
├── 0-templates/
│   └── exercise-template/   # Copy this to start a new lab
├── 1-surface-area-mapping/
│   └── web-content-discovery/
├── 2-javascript-analysis/
│   └── basic-js-analysis/
├── 3-injection/
│   └── sql-injection-basic/
└── Lab_instructions.md      # This file
```

## Exercise Structure
```
topic-folder/exercise_name/
├── Dockerfile           # Container configuration (MUST expose 8080)
├── metadata.json        # Exercise metadata and task definitions
├── README.md            # Lab purpose, topic, and architecture
├── CHALLENGES.json      # Structured challenge documentation and solutions
├── check-completion.sh  # Task reporting script
├── package.json         # Dependencies (if applicable)
├── server.js            # Main application (or any entry point)
├── public/              # Static files
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

### 2. README.md

Each lab must include a `README.md` for instructors and maintainers. It should explain what the lab is for without revealing the solution.

Include these sections:

- `Purpose`: What skill or concept the lab teaches.
- `Topic`: The application security topic, such as SQL injection, JavaScript analysis, authorization, or file upload security.
- `Architecture`: The major components, data stores, routes, services, and trust boundaries.
- `Candidate Flow`: What the candidate is expected to interact with at a high level.
- `Operational Notes`: Anything needed to run, reset, or troubleshoot the lab.

Example:

```markdown
# SQL Injection Basic

## Purpose

Teach candidates to identify query manipulation opportunities and validate impact through controlled data extraction.

## Topic

SQL injection in server-rendered web applications.

## Architecture

The lab is a Node.js and Express application backed by SQLite. The login and search routes issue SQL queries against the local database. The app listens on port 8080 and reports completion events to the platform callback API.

## Candidate Flow

Candidates start at the login page, investigate input handling, and use observed behavior to access protected data.

## Operational Notes

The container is stateless. Restarting the instance resets the database to its seeded state.
```

### 3. CHALLENGES.json

Each lab must include `CHALLENGES.json`. This file documents the challenges, their dependencies, candidate-facing instructions, and instructor-facing solutions.

`CHALLENGES.json` is separate from `metadata.json`:

- `metadata.json` drives platform task tracking and visible task pills.
- `CHALLENGES.json` documents the challenge design and complete solution path.

Use this JSON schema:

```json
{
  "type": "array",
  "items": {
    "type": "object",
    "required": [
      "id",
      "name",
      "difficulty",
      "automatable",
      "description",
      "instructions",
      "solution"
    ],
    "properties": {
      "id": {
        "type": "string",
        "description": "Unique identifier for the challenge"
      },
      "name": {
        "type": "string",
        "description": "Short descriptive title"
      },
      "difficulty": {
        "type": "string",
        "enum": ["Easy", "Medium", "Hard"]
      },
      "automatable": {
        "type": "boolean"
      },
      "description": {
        "type": "string",
        "description": "Non-revealing description of the challenge"
      },
      "instructions": {
        "type": "string",
        "description": "Additional candidate instructions or special conditions"
      },
      "solution": {
        "type": "string",
        "description": "Full walkthrough of how the challenge is solved"
      },
      "prerequisites": {
        "type": "array",
        "description": "List of prerequisite challenge IDs",
        "items": {
          "type": "string"
        }
      }
    }
  }
}
```

Example:

```json
[
  {
    "id": "ch-001",
    "name": "Insecure Direct Object Reference",
    "difficulty": "Easy",
    "automatable": true,
    "description": "A web endpoint returns user-specific data based on an identifier in the request, but access control may not be properly enforced.",
    "instructions": "Use only the web UI and browser developer tools. Do not brute-force identifiers.",
    "solution": "Modify the object identifier in the request to access another user's data. The backend does not validate ownership of the requested resource.",
    "prerequisites": []
  },
  {
    "id": "ch-002",
    "name": "Boolean-Based SQL Injection",
    "difficulty": "Medium",
    "automatable": false,
    "description": "A search feature responds differently depending on whether backend query conditions evaluate to true or false.",
    "instructions": "Document at least one true condition and one false condition before extracting data.",
    "solution": "Inject boolean conditions into the query and observe differences in responses to infer database content step by step.",
    "prerequisites": ["ch-001"]
  }
]
```

Guidance:

- Use stable IDs like `ch-001` or `sql-login-bypass`.
- Keep `description` non-revealing. It should help candidates understand the task, not solve it.
- Put candidate constraints in `instructions`, such as allowed tools, required evidence, or special setup.
- Put the full walkthrough in `solution`, including payloads, requests, expected observations, and completion criteria.
- Use `automatable: true` only when the platform or lab can reliably detect completion without manual review.
- Keep `prerequisites` empty unless the challenge depends on another documented challenge.

### 4. Dockerfile
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

### 5. Application Code

The app **must** listen on port 8080 and bind to 0.0.0.0:

```javascript
const port = 8080;
app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
});
```

### 6. Task Reporting

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

## Challenge Status Page

The platform provides a live challenge status view at `/admin/challenges.html`. Admins can also view the status for a single exercise at `/admin/challenges.html?imageId=<id>`, and can reach it directly by clicking **Challenges** next to any exercise in the Images table.

The page auto-refreshes every 10 seconds and shows:
- Every launched instance for the exercise
- Unsolved instances first, followed by solved instances
- The solved fraction across all shown instances
- Started time, solved time, and time-to-solve for solved instances
- A progress bar showing tasks completed / total
- A CSV export for offline tracking
- Completed task pills that open a detail panel with timestamps and evidence

**Design your tasks and evidence with this view in mind:**
- Keep `description` values short and action-oriented — they appear directly on each pill (e.g. `"Identify the injection point"`, not `"SQL injection"`)
- The `hint` field is shown in the detail panel; use it for the expected technique or tool, not a spoiler
- Structure `evidence` as a JSON object with meaningful keys — it renders as formatted JSON in the detail panel. Prefer specific keys over a plain string (e.g. `{"method": "UNION-based", "payload": "..."}` rather than `"bypass"`)

## Design Philosophy

This platform trains **methodological competency**, not flag-finding. When designing exercises:

1. **Define tasks as methodology steps**, not flags. Instead of "find the flag", define tasks like "Identify the injection point", "Demonstrate data extraction", "Verify the remediation".

2. **Automated vs. manual verification**: Tasks can be verified automatically (the exercise app detects the user's action and calls `check-completion.sh`) or manually (the user triggers completion themselves after demonstrating the skill).

3. **Evidence tracking**: Use the `evidence` field to capture how the user completed the task. This helps admins review methodology quality.

4. **Progressive difficulty**: Order goals from basic to advanced. Earlier tasks should build toward later ones.

5. **Observable completions**: The challenge status page is typically visible to the instructor during a live session. Design task completions to fire at the moment the methodology step is correctly demonstrated — not at the end of the exercise — so the instructor can see progress in real time.

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
1. Build the container locally.
```bash
docker build -t test-exercise .
```

2. Run it with callback placeholders.
```bash
docker run -p 8080:8080 -e CALLBACK_URL=http://localhost:3000/test -e CALLBACK_TOKEN=test -e TASK_IDS=task_1,task_2 test-exercise
```

3. Verify the app is accessible at `http://localhost:8080`.

4. Test each task completion path.

5. Verify the health check passes.

6. Validate `metadata.json` format.

7. Validate `CHALLENGES.json` format and confirm every required field is present.

8. Review `README.md` for purpose, topic, architecture, candidate flow, and operational notes.
