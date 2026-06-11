# Peer-to-Peer File Synchronization Protocol

A peer-to-peer file synchronization service inspired by rsync. The system synchronizes files between two nodes using block-level delta synchronization, transferring only changed portions of files instead of entire files.

## Features

- Real-time file synchronization
- Delta synchronization using rolling hash and SHA-256
- File create, update, and delete synchronization
- Conflict detection and conflict file generation
- REST API based node-to-node communication
- Path traversal protection
- Rate limiting
- Configurable file size limits
- Dockerized deployment
- Contract and performance testing

---

## Project Structure

```text
.
├── src/
├── test/
├── sync_dir_a/
├── sync_dir_b/
├── docker-compose.yml
├── Dockerfile
├── .env.example
└── README.md
```

---

## Setup

### 1. Clone Repository

```bash
git clone https://github.com/karthikgarikina/Peer-to-Peer-file-synchronization-protocol

cd Peer-to-Peer-file-synchronization-protocol
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

Create a `.env` file from `.env.example`.

```bash
cp .env.example .env
```

---

## Running the Application

Build and start both nodes:

```bash
docker compose up --build
```

Check running containers:

```bash
docker compose ps
```

Stop services:

```bash
docker compose down
```

---

## Usage

### Create a File

Create a file inside:

```text
sync_dir_a/
```

The file should automatically appear in:

```text
sync_dir_b/
```

### Modify a File

Edit a synchronized file. The peer node should receive only the changed blocks.

### Delete a File

Deleting a file from one node should delete it from the peer node.

---

## Running Tests

### Contract Test

```bash
npm run test:contract
```

### Performance Test

```bash
npm run test:perf
```

---

## API Endpoints

### Health Check

```http
GET /health
```

### File Metadata

```http
GET /files/{filepath}/metadata
```

### Apply Delta Patch

```http
PATCH /files/{filepath}
```

---

## Conflict Handling

If the same file is modified independently on both nodes, the system detects the conflict and creates a conflict copy instead of overwriting data.

Example:

```text
document.txt
document.conflicted.txt
```

---

## Technologies Used

- Node.js
- Fastify
- Chokidar
- Docker
- Docker Compose
- SHA-256
- Rolling Hash
- Pact
- Mocha

---
