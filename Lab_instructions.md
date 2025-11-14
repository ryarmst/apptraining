# Creating Training Exercises

This guide outlines the requirements and best practices for creating exercises for the Application Security Training Platform.

## Exercise Structure
```
exercise_name/
├── Dockerfile           # Container configuration
├── metadata.json       # Exercise metadata
├── package.json        # Dependencies
├── server.js          # Main application
├── public/            # Static files
│   ├── index.html    # Main interface
│   └── script.js     # Client-side code
└── readme.md         # Exercise documentation
```

## Required Files

### 1. metadata.json
```json
{
    "title": "Exercise Name",
    "version": "1.0.0",
    "description": "Brief description of the exercise",
    "level": "beginner|intermediate|advanced",
    "goals": [
        {
            "id": "goal_1",
            "description": "Description of the first goal",
            "hint": "Optional hint for the goal"
        }
    ]
}
```

### 2. Dockerfile
```dockerfile
FROM node:18-slim

WORKDIR /usr/src/app

# Install health check dependencies
RUN apt-get update && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser -s /bin/false appuser

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN chown -R appuser:appuser /usr/src/app

USER appuser

# IMPORTANT: Must expose port 8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1

CMD [ "node", "server.js" ]
```

### 3. server.js
```javascript
const app = express();
// IMPORTANT: Must listen on 0.0.0.0 and port 8080
const port = process.env.PORT || 8080;

// Your server code here

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
});
```

## Critical Requirements

### Port Configuration
- The application MUST listen on port 8080
- The server MUST bind to 0.0.0.0 (not localhost/127.0.0.1)
- The Dockerfile MUST expose port 8080
- Health checks MUST verify http://localhost:8080

### Security Configuration
- Run containers as non-root user
- Remove unnecessary packages after installation
- Set proper file permissions
- Include health checks
- Follow the principle of least privilege

### Container Requirements
- Base image should be stable (e.g., node:18-slim)
- Keep container size minimal
- Include only necessary dependencies
- Proper error handling and logging
- Clean up temporary files and build artifacts

### Exercise Metadata
- Valid metadata.json with required fields
- Proper level specification (beginner/intermediate/advanced)
- Clear goal descriptions and hints
- Version information

## Best Practices

### Documentation
1. Include clear setup instructions
2. Document exercise goals and success criteria
3. Provide hints without giving away solutions
4. Include troubleshooting guidance

### Code Quality
1. Use consistent code formatting
2. Include helpful comments
3. Handle errors gracefully
4. Log relevant information

### Security
1. Document intentional vulnerabilities
2. Mark security-critical code sections
3. Include warning about production use
4. Implement proper input validation

## Testing

Before submitting an exercise:
1. Build the container locally
2. Test all endpoints
3. Verify health checks
4. Confirm port configuration
5. Test as non-root user
6. Validate metadata format

## Common Issues
- Incorrect port configuration
- Missing 0.0.0.0 bind address
- Root user in container
- Missing health checks
- Invalid metadata format
- Missing dependencies
- Incorrect file permissions 