# Kosca AR System

A full-stack Accounts Receivable management system for tracking invoices, customer aging, and collections. Upload Excel reports, process them in the background, and view everything in a searchable dashboard.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 24 LTS |
| Framework | Express 5 |
| Database | PostgreSQL 17 |
| ORM | Prisma 7.6 |
| Cache / Queue | Redis 7, BullMQ |
| Templates | EJS 5, Tailwind CSS (CDN) |
| Interactivity | Alpine.js, HTMX |
| Logging | Pino (structured JSON) |
| Testing | Jest 30 (unit), Playwright (E2E) |
| Linting | ESLint 10, Prettier 3 |
| Package Manager | pnpm |

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows/Mac) or Docker Engine + Docker Compose (Linux)

No local Node.js, PostgreSQL, or Redis installation required.

---

## Getting Started

### 1. Clone and configure

```bash
git clone git@github.com:venkatavignesh/kosca-webapp.git
cd kosca-webapp/kosca_ar_system
cp .env.example .env
```

Edit `.env` and set at minimum:

```
SESSION_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
```

### 2. Start (Development)

```bash
docker compose up --build
```

The app starts with live reload (nodemon). Add `-d` to run in the background.

### 3. Start (Production)

```bash
DOCKER_TARGET=prod docker compose up -d --build
```

### 4. Access

| Service | URL |
|---------|-----|
| Web app | http://localhost:3001 |
| Health check | http://localhost:3001/health |

### 5. Stop

```bash
docker compose down
```

Database data is persisted in a Docker volume.

---

## Project Structure

```
kosca_ar_system/
├── src/
│   ├── server.js              # Express app, security, route registration
│   ├── worker.js              # BullMQ worker — Excel processing
│   ├── queue.js               # BullMQ queue + Redis connection
│   ├── scheduler.js           # Cron: auto-sync, settled invoice purge
│   ├── logger.js              # Pino structured logger
│   ├── cache.js               # Redis get-or-set cache helper
│   ├── prisma.js              # Prisma client
│   ├── validation.js          # Zod request schemas
│   ├── middleware/
│   │   ├── auth.js            # Auth, role/module access control
│   │   └── csrf.js            # CSRF token validation
│   └── routes/
│       ├── auth.js            # Login / logout
│       ├── assignments.js     # Customer assignments
│       ├── ar/                # AR feature routes
│       │   ├── dashboard.js
│       │   ├── directory.js
│       │   ├── invoices.js
│       │   ├── comments.js
│       │   ├── customers.js
│       │   ├── upload.js
│       │   └── pending_settlement.js
│       └── admin/             # Admin routes
│           ├── users.js
│           ├── categories.js
│           ├── groups.js
│           ├── site-assignments.js
│           └── branding.js
├── views/                     # EJS templates
│   ├── ar/                    # AR pages
│   ├── admin/                 # Admin pages
│   └── partials/              # Shared layout components
├── prisma/
│   └── schema.prisma          # Database schema (10 models)
├── tests/                     # Jest unit tests
├── e2e/                       # Playwright E2E specs
├── scripts/
│   ├── smart-test.sh          # Tiered smart test runner
│   └── impact-map.js          # Dependency analysis for test selection
├── Dockerfile                 # Multi-stage (dev, prod, worker-dev, worker-prod)
├── docker-compose.yml         # PostgreSQL, Redis, web, worker
└── .github/workflows/ci.yml   # CI pipeline
```

---

## Docker Services

| Service | Image | Host Port | Container Port |
|---------|-------|-----------|----------------|
| **db** | postgres:17-alpine | 5434 | 5432 |
| **redis** | redis:7-alpine | 6381 | 6379 |
| **web** | node:24-alpine | 3001 | 3000 |
| **worker** | node:24-alpine | — | — |

All services have health checks. Worker depends on web; web depends on db and redis.

Memory limit: 512 MB per service (web, worker).

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SESSION_SECRET` | Yes | — | Session signing key |
| `DATABASE_URL` | Yes | (set in compose) | PostgreSQL connection string |
| `REDIS_URL` | Yes | (set in compose) | Redis connection string |
| `REDIS_PASSWORD` | Yes | (set in compose) | Redis auth password |
| `PORT` | No | 3000 | Express server port |
| `DOCKER_TARGET` | No | dev | Build stage: `dev` or `prod` |
| `TZ` | No | Asia/Kolkata | Timezone |
| `LOG_LEVEL` | No | debug (dev) / info (prod) | Pino log level |
| `AR_REPORT_PATH` | No | — | Path to AR Excel for auto-sync |
| `CUSTOMER_MASTER_PATH` | No | — | Path to Customer Master Excel |
| `PENDING_SETTLEMENT_PATH` | No | — | Path to Pending Settlement Excel |

---

## Access Control

Three-layer model applied at the route level:

| Layer | Values | Description |
|-------|--------|-------------|
| **Role** | ADMIN, MANAGER, USER | Controls feature-level access |
| **Module** | ar_dashboard, ar_upload, ar_comments, etc. | Per-user module permissions |
| **Site** | Bangalore, Hyderabad, etc. | Scopes data visibility |

ADMIN bypasses all module and site checks. Role/module data is cached in-memory for 30 seconds to avoid per-request DB queries.

---

## Background Jobs

### BullMQ Worker

Processes Excel uploads with retry (2 attempts, exponential backoff):

| Job Type | Description |
|----------|-------------|
| `ar_report` | Parse AR Excel, upsert invoices (batch 100), create daily snapshots, purge settled > 3 days |
| `customer_master` | Sync customer details (batch 50), respects locked mobile numbers |
| `pending_settlement` | Full replace of pending settlement data (batch 100) |

### Scheduler

| Task | Frequency |
|------|-----------|
| Settled invoice purge | Every 24 hours |
| Auto-sync (AR, Customer Master, Pending Settlement) | Every 30 min (at :10 and :40) |

Auto-sync only runs if the corresponding `*_PATH` environment variable is set.

---

## Security

| Feature | Implementation |
|---------|---------------|
| **CSRF** | Double-submit token per session, validates POST/PUT/DELETE/PATCH |
| **CSP** | Helmet with custom directives (script/style/font/img/connect sources) |
| **HSTS** | 1 year max-age with includeSubDomains (production only) |
| **Sessions** | Redis-backed, httpOnly, SameSite=Strict, secure in production |
| **Passwords** | bcrypt hashing |
| **Rate limiting** | express-rate-limit on auth routes |
| **Input validation** | Zod schemas on all POST routes |
| **Redis auth** | Password-protected in Docker |

---

## Testing

### Run tests

```bash
# Unit tests (Jest)
pnpm test

# Unit tests with coverage
pnpm test:coverage

# E2E tests (requires running app)
npx playwright test

# E2E report
npx playwright show-report

# Smart test runner (auto-selects tier based on changed file)
bash scripts/smart-test.sh <path-to-changed-file>
```

### Test counts

| Type | Count | Framework |
|------|-------|-----------|
| Unit / Integration | 56 | Jest 30 |
| End-to-End | 52 | Playwright |

### Smart test runner

`scripts/smart-test.sh` uses an impact map to select the minimum test tier needed for a given change:

```
Smoke → Unit → Integration → E2E → Full Regression
```

---

## Development Commands

All commands run inside Docker:

```bash
# Regenerate Prisma client after schema changes
docker compose exec web pnpm run db:generate

# Run database migrations
docker compose exec web npx prisma migrate dev

# Push schema to DB (dev only)
docker compose exec web npx prisma db push

# Visual DB browser
docker compose exec web npx prisma studio

# View logs
docker compose logs -f web
docker compose logs -f worker

# Lint
pnpm lint
pnpm lint:fix

# Format
pnpm format
pnpm format:check
```

---

## CI/CD

GitHub Actions runs on every push to `main` and on pull requests:

1. Lint (ESLint)
2. Test with coverage (Jest + PostgreSQL + Redis services)
3. Dependency audit (`pnpm audit --audit-level high`)

---

## Database Models

| Model | Purpose |
|-------|---------|
| **User** | Auth, role (ADMIN/MANAGER/USER), module permissions |
| **Invoice** | AR entries, unique on (invoiceNo, customerCode), status ACTIVE/SETTLED |
| **Comment** | Threaded discussions on invoices/customers |
| **CustomerMaster** | Customer details, PSR, lockable mobile numbers |
| **CustomerGroup** | Customer grouping |
| **CustomerAssignment** | User-to-customer access mapping |
| **CustomerSiteOverride** | Admin override for inferred customer site |
| **CustomerDispute** | Disputed customer flags |
| **ARSnapshot** | Daily per-customer balance snapshot |
| **PendingSettlement** | Pending reconciliation items |

---

## Excel Upload Format

**AR Report** — Required columns:
- Customer Name, Invoice Date, Due Date, Balance Amount, Aging (Days)

**Customer Master** — Syncs PSR names and mobile numbers.

**Pending Settlement** — Full replace on each import.

---

## License

Proprietary. Internal use only.
