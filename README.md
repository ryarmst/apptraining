# Application Security Training Platform

A Docker-based training platform for application security testing exercises. This system allows administrators to create and manage containerized security exercises.

## System Requirements

- Node.js 18 or higher
- Docker Engine
- SQLite3
- Linux environment with subdomain support

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd app-security-training
```

2. Install dependencies:
```bash
npm install
```

3. Create required directories:
```bash
mkdir -p data logs uploads/exercises
```

4. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

5. Initialize the database:
```bash
node src/db/init.js
```

6. Start the application:
```bash
npm start
```

## Exercise Format

Training exercises must be packaged following this structure:

```
exercise.tar.gz
├── Dockerfile
├── metadata.json
├── app/
│   └── (exercise files)
└── (additional resources)
```

### Container Communication

Exercises can report completion using the provided `check-completion.sh` script:

```bash
check-completion.sh <goal_id> <token> [data]
```

## API Endpoints

### Authentication
- POST `/api/auth/register` - Register new trainee
- POST `/api/auth/login` - User login
- POST `/api/auth/logout` - User logout
- GET `/api/auth/me` - Get current user

### Exercises
- GET `/api/exercises` - List available exercises
- POST `/api/exercises/launch/:id` - Launch exercise container
- POST `/api/exercises/:id/stop` - Stop exercise container

### Admin
- GET `/api/admin/users` - List all users
- GET `/api/admin/stats` - System statistics
- POST `/api/admin/exercises/upload` - Upload new exercise
- PUT `/api/admin/exercises/:id` - Update exercise
- DELETE `/api/admin/exercises/:id` - Delete exercise