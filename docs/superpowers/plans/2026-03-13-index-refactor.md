# index.js Refactor + Integration Tests Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/routes/index.js` (1,482 lines) into 6 focused sub-routers under `src/routes/ar/` and add Supertest integration tests for each.

**Architecture:** `src/routes/index.js` becomes a ~25-line thin assembler that mounts 6 sub-routers. No logic moves between files — pure extraction with zero behaviour change. Tests use Jest + Supertest with mocked Prisma and BullMQ queue.

**Tech Stack:** Express 5, Prisma ORM, BullMQ/Redis, EJS templates, Jest 29, Supertest 7, pnpm, Docker Compose.

---

## Important context

- **No git** in this repo — skip all git commit steps.
- **All commands** run inside Docker: `docker compose exec web <cmd>` from `kosca_ar_system/`.
- **Package manager:** pnpm only. Never use npm.
- **Two inline `require` calls** in `index.js` must be promoted to top-level imports in the extracted files. Note the path change: `index.js` lives in `src/routes/` so it uses `'../queue'`; the new files live in `src/routes/ar/` so they must use `'../../queue'`:
  - Line 68: `require('../queue')` inside `GET /ar` handler → becomes `require('../../queue')` at top of `dashboard.js`
  - Line 696: `require('../queue')` inside `GET /ar/upload` handler → becomes `require('../../queue')` at top of `upload.js`
- **All `require` paths in sub-router files** (under `src/routes/ar/`) must use `../../` to reach `src/`:
  - `require('../../prisma')` — NOT `require('../prisma')`
  - `require('../../queue')` — NOT `require('../queue')`
  - `require('../../middleware/auth')` — already correct in this plan
- **`requireInvoicesAccess`** (lines 825–837 of index.js) goes into `_shared.js`, not `invoices.js`. It is NOT copied to invoices.js body.
- **`fetchStructuredComments`** (lines 1222–1251) is a module-level async function; it moves to `comments.js` as a local (non-exported) function placed before the route definitions.
- The `upload` middleware (multer instance) moves from top of `index.js` to `_shared.js`. The `upload.js` sub-router imports it from `./_shared`.
- `admin.js` and `server.js` are **not touched**.

---

## Chunk 1: Tooling + Test Infrastructure

### Task 1: Install test dependencies and create jest.config.js

**Files:**
- Modify: `package.json`
- Create: `jest.config.js`

- [ ] **Step 1: Add jest and supertest as dev dependencies**

```bash
docker compose exec web pnpm add -D jest@^29 supertest@^7
```

Expected: pnpm-lock.yaml updated, node_modules contains jest and supertest.

- [ ] **Step 2: Verify install**

```bash
docker compose exec web pnpm list jest supertest
```

Expected output contains: `jest 29.x.x` and `supertest 7.x.x`

- [ ] **Step 3: Add `"test"` script to package.json**

In `package.json`, add to the `"scripts"` block:
```json
"test": "jest"
```

Final scripts block should be:
```json
"scripts": {
  "start": "node src/server.js",
  "dev": "nodemon src/server.js",
  "worker": "node src/worker.js",
  "worker:dev": "nodemon --watch src/worker.js --watch src/queue.js --watch src/prisma.js src/worker.js",
  "db:push": "prisma db push",
  "db:generate": "prisma generate",
  "test": "jest"
}
```

- [ ] **Step 4: Create `jest.config.js` in project root**

```js
// jest.config.js
module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js']
};
```

- [ ] **Step 5: Verify jest runs (with no tests yet)**

```bash
docker compose exec web pnpm test
```

Expected: `No tests found, exiting with code 1` or similar — confirms jest is wired up.

---

### Task 2: Create directory structure and tests/setup.js

**Files:**
- Create: `tests/setup.js`
- Create: `tests/routes/ar/` (directory — no files yet)
- Create: `src/routes/ar/` (directory — no files yet)

- [ ] **Step 1: Create directory structure**

```bash
docker compose exec web mkdir -p tests/routes/ar src/routes/ar
```

- [ ] **Step 2: Create `tests/setup.js`**

This file exports two helpers used by every test file:
- `makePrismaMock()` — factory for jest.fn() stubs of all Prisma methods used across the codebase
- `makeApp(router, session)` — minimal Express app with EJS, fake session, and error handler

```js
// tests/setup.js
const path = require('path');
const express = require('express');

/**
 * Returns a fresh Prisma mock object with jest.fn() stubs for all methods
 * used by the ar/ route files. All methods default to returning [] or null.
 * Use this inside jest.mock('../../../src/prisma', () => require('../../setup').makePrismaMock())
 */
function makePrismaMock() {
    return {
        keyAccount:      { findMany: jest.fn().mockResolvedValue([]) },
        subDistributor:  { findMany: jest.fn().mockResolvedValue([]) },
        otherAccount:    { findMany: jest.fn().mockResolvedValue([]) },
        customerDispute: {
            findMany:   jest.fn().mockResolvedValue([]),
            findUnique: jest.fn().mockResolvedValue(null),
            create:     jest.fn().mockResolvedValue({}),
            delete:     jest.fn().mockResolvedValue({})
        },
        invoice: {
            findMany: jest.fn().mockResolvedValue([]),
            groupBy:  jest.fn().mockResolvedValue([]),
            count:    jest.fn().mockResolvedValue(0)
        },
        customerGroup: {
            findMany:   jest.fn().mockResolvedValue([]),
            findUnique: jest.fn().mockResolvedValue(null)
        },
        customerMaster: {
            findMany:   jest.fn().mockResolvedValue([]),
            findUnique: jest.fn().mockResolvedValue(null),
            upsert:     jest.fn().mockResolvedValue({}),
            update:     jest.fn().mockResolvedValue({})
        },
        comment: {
            findMany:   jest.fn().mockResolvedValue([]),
            create:     jest.fn().mockResolvedValue({
                id: 'c1', customerCode: 'TEST001', comment: 'test comment',
                createdBy: 1, createdByName: 'Test User', replies: [],
                createdAt: new Date(), updatedAt: new Date(),
                parentId: null, followUpDate: null, resolved: false, invoiceNo: null
            }),
            findUnique: jest.fn().mockResolvedValue(null),
            update:     jest.fn().mockResolvedValue({}),
            delete:     jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({})
        },
        aRSnapshot:         { findMany: jest.fn().mockResolvedValue([]) },
        user:               { findMany: jest.fn().mockResolvedValue([]) },
        customerAssignment: {
            findMany:   jest.fn().mockResolvedValue([]),
            findUnique: jest.fn().mockResolvedValue(null)
        }
    };
}

/**
 * Creates a minimal Express app wrapping the given router.
 * Sets up EJS view engine, fake session, res.locals, and error handler.
 *
 * @param {express.Router} router - The sub-router under test
 * @param {object} session - Session overrides. Pass { userId: null } to simulate unauthenticated.
 */
function makeApp(router, session = {}) {
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '../views'));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => {
        const s = {
            userId:      1,
            userRole:    'ADMIN',
            userName:    'Test User',
            userModules: [
                'ar_dashboard', 'ar_directory', 'ar_upload', 'ar_comments',
                'ar_key_accounts', 'ar_sub_distributors', 'ar_others', 'ar_assign', 'ar_groups'
            ],
            ...session
        };
        req.session = s;
        const role = s.userRole;
        const mods  = s.userModules || [];
        res.locals.user = s.userId
            ? { id: s.userId, name: s.userName, role, modules: mods }
            : null;
        res.locals.hasModule   = (mod) => !!s.userId && (role === 'ADMIN' || mods.includes(mod));
        res.locals.currentPath = req.path;
        next();
    });
    app.use(router);
    // Required: Express 5 error propagation — multer rejections become 400, others 500
    app.use((err, req, res, next) => {
        if (err && (err.message?.includes('Only .xlsx') || err.code === 'LIMIT_FILE_SIZE')) {
            return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: err.message || 'Internal error' });
    });
    return app;
}

module.exports = { makePrismaMock, makeApp };
```

- [ ] **Step 3: Verify setup.js has no syntax errors**

```bash
docker compose exec web node --check tests/setup.js
```

Expected: no output (clean).

---

## Chunk 2: Shared Utilities + Dashboard

### Task 3: Create src/routes/ar/_shared.js

**Files:**
- Create: `src/routes/ar/_shared.js`

This file centralises the three things that `ar/` sub-routers share: `uploadsDir`, `upload` (multer instance), and `requireInvoicesAccess`.

- [ ] **Step 1: Create `src/routes/ar/_shared.js`**

```js
// src/routes/ar/_shared.js
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');

const uploadsDir = path.join(__dirname, '../../../uploads');

// Ensure uploads directory exists on startup (was in index.js lines 12–15)
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const ALLOWED_EXCEL_MIMES = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/octet-stream'
];

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadsDir),
        filename:    (req, file, cb) => cb(null,
            Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname)
        )
    }),
    fileFilter: (req, file, cb) => {
        const extOk  = ['.xlsx', '.xls'].includes(path.extname(file.originalname).toLowerCase());
        const mimeOk = ALLOWED_EXCEL_MIMES.includes(file.mimetype);
        extOk && mimeOk ? cb(null, true) : cb(new Error('Only .xlsx and .xls files are allowed'));
    }
});

// Access control for /ar/invoices — checks query-param-dependent module flags.
// Exact HTMX HTML response bodies are preserved from source (zero behaviour change).
function requireInvoicesAccess(req, res, next) {
    const role    = req.session.userRole;
    const modules = req.session.userModules || [];
    const has     = (m) => role === 'ADMIN' || modules.includes(m);
    const keyOnly    = req.query.keyOnly    === '1';
    const subOnly    = req.query.subOnly    === '1';
    const othersOnly = req.query.othersOnly === '1';
    if (keyOnly    && !has('ar_key_accounts'))     return res.status(403).send('<div class="text-red-500 p-4">Access denied.</div>');
    if (subOnly    && !has('ar_sub_distributors')) return res.status(403).send('<div class="text-red-500 p-4">Access denied.</div>');
    if (othersOnly && !has('ar_others'))           return res.status(403).send('<div class="text-red-500 p-4">Access denied.</div>');
    if (!keyOnly && !subOnly && !othersOnly && !has('ar_directory')) return res.status(403).send('<div class="text-red-500 p-4">Module not assigned.</div>');
    next();
}

module.exports = { uploadsDir, upload, requireInvoicesAccess };
```

- [ ] **Step 2: Verify no syntax errors**

```bash
docker compose exec web node --check src/routes/ar/_shared.js
```

Expected: no output.

---

### Task 4: dashboard.js — extract, test, and wire

**Files:**
- Create: `tests/routes/ar/dashboard.test.js`
- Create: `src/routes/ar/dashboard.js`
- Modify: `src/routes/index.js` (lines 50–349 replaced with router.use)

**Source lines:** `GET /ar` route is lines 50–349 in `src/routes/index.js`.
The inline `const { connection } = require('../queue');` at line 68 must be moved to the top-level import in `dashboard.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/routes/ar/dashboard.test.js`:

```js
// tests/routes/ar/dashboard.test.js
jest.mock('../../../src/prisma', () => require('../../setup').makePrismaMock());
jest.mock('../../../src/queue', () => ({
    uploadQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
    connection:  { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
}));

const request = require('supertest');
const prisma  = require('../../../src/prisma');
const { makeApp } = require('../../setup');

// Import AFTER mocks are declared
const router = require('../../../src/routes/ar/dashboard');

describe('GET /ar — AR metrics dashboard', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns 200 for authenticated ADMIN with ar_dashboard module', async () => {
        const res = await request(makeApp(router)).get('/ar');
        expect(res.status).toBe(200);
        expect(res.text.length).toBeGreaterThan(50);
    });

    it('redirects to /login when unauthenticated', async () => {
        const res = await request(makeApp(router, { userId: null })).get('/ar');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/login');
    });

    it('returns 403 when user has no ar_dashboard module and is not ADMIN', async () => {
        const res = await request(makeApp(router, {
            userRole:    'USER',
            userModules: []
        })).get('/ar');
        expect(res.status).toBe(403);
    });

    it('calls prisma.invoice.findMany to fetch invoices', async () => {
        prisma.invoice.findMany.mockResolvedValue([
            { balanceAmount: 5000, agingDays: 45, customerCode: 'BNG001', siteName: 'Bangalore' }
        ]);
        const res = await request(makeApp(router)).get('/ar');
        expect(res.status).toBe(200);
        expect(prisma.invoice.findMany).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test — confirm it fails with "Cannot find module"**

```bash
docker compose exec web pnpm test tests/routes/ar/dashboard.test.js
```

Expected: FAIL — `Cannot find module '../../../src/routes/ar/dashboard'`

- [ ] **Step 3: Create `src/routes/ar/dashboard.js`**

```js
// src/routes/ar/dashboard.js
const express = require('express');
const router  = express.Router();
const prisma  = require('../../prisma');
const { connection }             = require('../../queue');
const { requireAuth, requireModule } = require('../../middleware/auth');
```

Then copy lines **50–349** from `src/routes/index.js` verbatim, with ONE change:
- **Delete** line 68: `const { connection } = require('../queue');`
  (it is now the top-level import above)

Then append:
```js
module.exports = router;
```

- [ ] **Step 4: Verify no syntax errors in the new file**

```bash
docker compose exec web node --check src/routes/ar/dashboard.js
```

Expected: no output.

- [ ] **Step 5: Run test — confirm it passes**

```bash
docker compose exec web pnpm test tests/routes/ar/dashboard.test.js
```

Expected: PASS — 4 tests passing.

- [ ] **Step 6: Wire dashboard.js into index.js**

In `src/routes/index.js`:
1. Delete lines 50–349 (the entire `GET /ar` route handler block).
2. In place of those deleted lines, add: `router.use(require('./ar/dashboard'));`
3. Also remove from the top of `index.js`:
   - The `upload` const and `ALLOWED_EXCEL_MIMES` const and `storage` const (lines 17–42) — these move to `_shared.js`
   - The `uploadsDir` const and `fs.existsSync`/`mkdirSync` guard (lines 12–15) — these are in `_shared.js` now
   - Remove `const ExcelJS = require('exceljs');` from the top (it stays only in the files that use it)
   - Remove `const { uploadQueue } = require('../queue');` from the top (it moves to upload.js)
   - Keep only: `express`, `router`, `prisma`, `requireAuth`, `requireModule`, `requireRole`, `path`, `fs` at the top

   **Important:** Only remove `upload`/`ExcelJS`/`uploadQueue` from the top if they are no longer needed by the remaining routes in index.js at this stage. Since all those routes still exist in index.js at this step, **do not** remove those yet. The top-of-file cleanup happens in Task 10.

   So at this step, just **replace lines 50–349** with `router.use(require('./ar/dashboard'));`.

- [ ] **Step 7: Re-run test to confirm it still passes after wiring**

```bash
docker compose exec web pnpm test tests/routes/ar/dashboard.test.js
```

Expected: PASS — still 4 tests passing.

---

## Chunk 3: Directory Routes

### Task 5: directory.js — extract, test, and wire

**Files:**
- Create: `tests/routes/ar/directory.test.js`
- Create: `src/routes/ar/directory.js`
- Modify: `src/routes/index.js`

**Source lines:** Lines **351–692** in `src/routes/index.js`.
This block contains:
- `GET /ar/directory` (lines 351–374)
- `GET /ar/groups` (lines 376–381)
- `GET /ar/groups-data` (lines 383–677)
- `GET /ar/key-accounts` (lines 679–682)
- `GET /ar/sub-distributors` (lines 684–687)
- `GET /ar/others` (lines 689–692)

No inline require promotions needed for this block.

- [ ] **Step 1: Write the failing test**

Create `tests/routes/ar/directory.test.js`:

```js
// tests/routes/ar/directory.test.js
jest.mock('../../../src/prisma', () => require('../../setup').makePrismaMock());
jest.mock('../../../src/queue', () => ({
    uploadQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
    connection:  { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
}));

const request  = require('supertest');
const prisma   = require('../../../src/prisma');
const { makeApp } = require('../../setup');
const router   = require('../../../src/routes/ar/directory');

describe('Directory routes', () => {
    beforeEach(() => jest.clearAllMocks());

    describe('GET /ar/directory', () => {
        it('returns 200 for authenticated user with ar_directory module', async () => {
            prisma.invoice.findMany.mockResolvedValue([]);
            prisma.customerGroup.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/directory');
            expect(res.status).toBe(200);
        });

        it('redirects to /login when unauthenticated', async () => {
            const res = await request(makeApp(router, { userId: null })).get('/ar/directory');
            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/login');
        });

        it('returns 403 when user lacks ar_directory module', async () => {
            const res = await request(makeApp(router, { userRole: 'USER', userModules: [] })).get('/ar/directory');
            expect(res.status).toBe(403);
        });
    });

    describe('GET /ar/groups', () => {
        it('returns 200', async () => {
            const res = await request(makeApp(router)).get('/ar/groups');
            expect(res.status).toBe(200);
        });
    });

    describe('GET /ar/groups-data', () => {
        it('returns 200 with HTML content for tab=key', async () => {
            prisma.keyAccount.findMany.mockResolvedValue([
                { customerCode: 'BNG001', customerName: 'Test Co' }
            ]);
            prisma.invoice.findMany.mockResolvedValue([
                { customerCode: 'BNG001', balanceAmount: 1000, agingDays: 30 }
            ]);
            const res = await request(makeApp(router)).get('/ar/groups-data?tab=key');
            expect(res.status).toBe(200);
            expect(res.text).toContain('<');
        });

        it('returns 200 for tab=ungrouped', async () => {
            prisma.otherAccount.findMany.mockResolvedValue([]);
            prisma.customerGroup.findMany.mockResolvedValue([]);
            prisma.keyAccount.findMany.mockResolvedValue([]);
            prisma.subDistributor.findMany.mockResolvedValue([]);
            prisma.invoice.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/groups-data?tab=ungrouped');
            expect(res.status).toBe(200);
        });
    });

    describe('GET /ar/key-accounts, /ar/sub-distributors, /ar/others', () => {
        it('GET /ar/key-accounts returns 200', async () => {
            const res = await request(makeApp(router)).get('/ar/key-accounts');
            expect(res.status).toBe(200);
        });

        it('GET /ar/sub-distributors returns 200', async () => {
            const res = await request(makeApp(router)).get('/ar/sub-distributors');
            expect(res.status).toBe(200);
        });

        it('GET /ar/others returns 200', async () => {
            const res = await request(makeApp(router)).get('/ar/others');
            expect(res.status).toBe(200);
        });
    });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
docker compose exec web pnpm test tests/routes/ar/directory.test.js
```

Expected: FAIL — `Cannot find module '../../../src/routes/ar/directory'`

- [ ] **Step 3: Create `src/routes/ar/directory.js`**

```js
// src/routes/ar/directory.js
const express = require('express');
const router  = express.Router();
const prisma  = require('../../prisma');
const { requireAuth, requireModule } = require('../../middleware/auth');
```

Copy lines **351–692** from `src/routes/index.js` verbatim. No inline require promotions needed.

Append:
```js
module.exports = router;
```

- [ ] **Step 4: Verify no syntax errors**

```bash
docker compose exec web node --check src/routes/ar/directory.js
```

- [ ] **Step 5: Run test — confirm it passes**

```bash
docker compose exec web pnpm test tests/routes/ar/directory.test.js
```

Expected: PASS — all tests passing.

- [ ] **Step 6: Wire into index.js**

In `src/routes/index.js`, replace lines **351–692** with:
```js
router.use(require('./ar/directory'));
```

- [ ] **Step 7: Re-run test to confirm still passes**

```bash
docker compose exec web pnpm test tests/routes/ar/directory.test.js
```

Expected: PASS.

---

## Chunk 4: Upload Routes

### Task 6: upload.js — extract, test, and wire

**Files:**
- Create: `tests/routes/ar/upload.test.js`
- Create: `src/routes/ar/upload.js`
- Modify: `src/routes/index.js`

**Source lines:** Lines **694–822** in `src/routes/index.js`.
This block contains:
- `GET /ar/upload` (lines 694–710)
- `POST /ar/upload` (lines 712–742)
- `POST /ar/sync-now` (lines 744–767)
- `GET /ar/upload/status` (lines 768–822)

**Inline require to promote:** Line 696 has `const { connection } = require('../queue');` inside the `GET /ar/upload` handler. In `upload.js`, add this as a top-level import instead.

- [ ] **Step 1: Write the failing test**

Create `tests/routes/ar/upload.test.js`:

```js
// tests/routes/ar/upload.test.js
jest.mock('../../../src/prisma', () => require('../../setup').makePrismaMock());
jest.mock('../../../src/queue', () => ({
    uploadQueue: {
        add:          jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
        getActive:    jest.fn().mockResolvedValue([]),
        getWaiting:   jest.fn().mockResolvedValue([]),
        getCompleted: jest.fn().mockResolvedValue([])
    },
    connection: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
}));

const request      = require('supertest');
const { makeApp }  = require('../../setup');
const { uploadQueue } = require('../../../src/queue');
const router       = require('../../../src/routes/ar/upload');

describe('Upload routes', () => {
    beforeEach(() => jest.clearAllMocks());

    describe('GET /ar/upload', () => {
        it('returns 200 for authenticated user with ar_upload module', async () => {
            const res = await request(makeApp(router)).get('/ar/upload');
            expect(res.status).toBe(200);
        });

        it('redirects to /login when unauthenticated', async () => {
            const res = await request(makeApp(router, { userId: null })).get('/ar/upload');
            expect(res.status).toBe(302);
        });
    });

    describe('POST /ar/upload', () => {
        it('returns 200 with success HTML when valid xlsx uploaded', async () => {
            const res = await request(makeApp(router))
                .post('/ar/upload')
                .attach('excelFile', Buffer.from('fake-xlsx-content'), {
                    filename:    'report.xlsx',
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                });
            expect(res.status).toBe(200);
            expect(res.text).toContain('bg-green-100');
            expect(uploadQueue.add).toHaveBeenCalledWith('process-excel', expect.objectContaining({
                type: 'ar_report'
            }));
        });

        it('returns 400 when file has wrong MIME type', async () => {
            const res = await request(makeApp(router))
                .post('/ar/upload')
                .attach('excelFile', Buffer.from('not-excel'), {
                    filename:    'report.xlsx',
                    contentType: 'text/plain'
                });
            expect(res.status).toBe(400);
        });
    });

    describe('POST /ar/sync-now', () => {
        it('returns 403 when user is USER role (not ADMIN/MANAGER)', async () => {
            const res = await request(makeApp(router, { userRole: 'USER', userModules: [] }))
                .post('/ar/sync-now');
            expect(res.status).toBe(403);
        });

        it('returns 400 when no env paths configured (ADMIN role)', async () => {
            // AR_REPORT_PATH and CUSTOMER_MASTER_PATH are not set in test env
            const res = await request(makeApp(router)).post('/ar/sync-now');
            expect(res.status).toBe(400);
        });
    });

    describe('GET /ar/upload/status', () => {
        it('returns 200 with hidden progress div when no jobs active', async () => {
            const res = await request(makeApp(router)).get('/ar/upload/status');
            expect(res.status).toBe(200);
            expect(res.text).toContain('ar-upload-progress');
        });
    });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
docker compose exec web pnpm test tests/routes/ar/upload.test.js
```

Expected: FAIL — `Cannot find module '../../../src/routes/ar/upload'`

- [ ] **Step 3: Create `src/routes/ar/upload.js`**

```js
// src/routes/ar/upload.js
const express = require('express');
const router  = express.Router();
const { upload }                        = require('./_shared');
const { uploadQueue, connection }       = require('../../queue');
const { requireAuth, requireModule, requireRole } = require('../../middleware/auth');
```

Copy lines **694–822** from `src/routes/index.js` verbatim, with ONE change:
- **Delete** line 696: `const { connection } = require('../queue');`
  (it is now the top-level import above)

Append:
```js
module.exports = router;
```

- [ ] **Step 4: Verify no syntax errors**

```bash
docker compose exec web node --check src/routes/ar/upload.js
```

- [ ] **Step 5: Run test — confirm it passes**

```bash
docker compose exec web pnpm test tests/routes/ar/upload.test.js
```

Expected: PASS.

- [ ] **Step 6: Wire into index.js**

In `src/routes/index.js`, replace lines **694–822** with:
```js
router.use(require('./ar/upload'));
```

- [ ] **Step 7: Re-run test**

```bash
docker compose exec web pnpm test tests/routes/ar/upload.test.js
```

Expected: PASS.

---

## Chunk 5: Invoice Routes

### Task 7: invoices.js — extract, test, and wire

**Files:**
- Create: `tests/routes/ar/invoices.test.js`
- Create: `src/routes/ar/invoices.js`
- Modify: `src/routes/index.js`

**Source lines:** The invoices routes are lines **840–1103** in `src/routes/index.js`.
- `requireInvoicesAccess` function (lines 824–837) goes to `_shared.js` (already done in Task 3) — **do NOT copy it into invoices.js**
- `GET /ar/invoices` (lines 840–1063)
- `GET /ar/invoices/:customerCode` (lines 1065–1103)

When wiring into index.js in Step 6, also remove the `requireInvoicesAccess` function block (lines 824–837) from index.js.

- [ ] **Step 1: Write the failing test**

Create `tests/routes/ar/invoices.test.js`:

```js
// tests/routes/ar/invoices.test.js
jest.mock('../../../src/prisma', () => require('../../setup').makePrismaMock());
jest.mock('../../../src/queue', () => ({
    uploadQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
    connection:  { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
}));

const request  = require('supertest');
const prisma   = require('../../../src/prisma');
const { makeApp } = require('../../setup');
const router   = require('../../../src/routes/ar/invoices');

describe('Invoice routes', () => {
    beforeEach(() => jest.clearAllMocks());

    describe('GET /ar/invoices', () => {
        it('returns 200 for ADMIN (default — no filter flags)', async () => {
            const res = await request(makeApp(router)).get('/ar/invoices');
            expect(res.status).toBe(200);
        });

        it('returns 200 for keyOnly=1 with ADMIN role', async () => {
            const res = await request(makeApp(router)).get('/ar/invoices?keyOnly=1');
            expect(res.status).toBe(200);
        });

        it('returns 403 for keyOnly=1 when USER lacks ar_key_accounts module', async () => {
            const res = await request(makeApp(router, {
                userRole:    'USER',
                userModules: ['ar_directory']
            })).get('/ar/invoices?keyOnly=1');
            expect(res.status).toBe(403);
            expect(res.text).toContain('Access denied');
        });

        it('returns 403 for subOnly=1 when USER lacks ar_sub_distributors', async () => {
            const res = await request(makeApp(router, {
                userRole:    'USER',
                userModules: ['ar_directory']
            })).get('/ar/invoices?subOnly=1');
            expect(res.status).toBe(403);
        });

        it('returns 403 when USER lacks ar_directory (default view)', async () => {
            const res = await request(makeApp(router, {
                userRole:    'USER',
                userModules: []
            })).get('/ar/invoices');
            expect(res.status).toBe(403);
            expect(res.text).toContain('Module not assigned');
        });

        it('calls prisma.invoice.groupBy for pagination', async () => {
            prisma.invoice.groupBy.mockResolvedValue([]);
            await request(makeApp(router)).get('/ar/invoices');
            expect(prisma.invoice.groupBy).toHaveBeenCalled();
        });
    });

    describe('GET /ar/invoices/:customerCode', () => {
        it('returns 200 with customer invoices', async () => {
            prisma.invoice.findMany.mockResolvedValue([
                { invoiceNo: 'INV001', customerCode: 'BNG001', customerName: 'Test Co',
                  balanceAmount: 1000, agingDays: 30, status: 'ACTIVE',
                  invoiceDate: new Date(), dueDate: new Date() }
            ]);
            prisma.customerMaster.findUnique.mockResolvedValue(null);
            prisma.customerDispute.findUnique.mockResolvedValue(null);
            prisma.customerGroup.findUnique.mockResolvedValue(null);
            prisma.customerGroup.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/invoices/BNG001');
            expect(res.status).toBe(200);
        });
    });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
docker compose exec web pnpm test tests/routes/ar/invoices.test.js
```

Expected: FAIL — `Cannot find module '../../../src/routes/ar/invoices'`

- [ ] **Step 3: Create `src/routes/ar/invoices.js`**

```js
// src/routes/ar/invoices.js
const express = require('express');
const router  = express.Router();
const prisma  = require('../../prisma');
const { requireAuth, requireModule }    = require('../../middleware/auth');
const { requireInvoicesAccess }         = require('./_shared');
```

Copy lines **840–1103** from `src/routes/index.js` verbatim. No inline require promotions needed.

Append:
```js
module.exports = router;
```

- [ ] **Step 4: Verify no syntax errors**

```bash
docker compose exec web node --check src/routes/ar/invoices.js
```

- [ ] **Step 5: Run test — confirm it passes**

```bash
docker compose exec web pnpm test tests/routes/ar/invoices.test.js
```

Expected: PASS.

- [ ] **Step 6: Wire into index.js**

In `src/routes/index.js`, replace lines **824–1103** (the `requireInvoicesAccess` function + both invoice routes) with:
```js
router.use(require('./ar/invoices'));
```

- [ ] **Step 7: Re-run test**

```bash
docker compose exec web pnpm test tests/routes/ar/invoices.test.js
```

Expected: PASS.

---

## Chunk 6: Customer Routes

### Task 8: customers.js — extract, test, and wire

**Files:**
- Create: `tests/routes/ar/customers.test.js`
- Create: `src/routes/ar/customers.js`
- Modify: `src/routes/index.js`

**Source lines (non-contiguous):**
- Lines **1105–1217**: dispute toggle, export, statement, trend
- Lines **1442–1480**: mobile update, mobile fetch

When creating customers.js, copy the first block (1105–1217), then add the second block (1442–1480).

- [ ] **Step 1: Write the failing test**

Create `tests/routes/ar/customers.test.js`:

```js
// tests/routes/ar/customers.test.js
jest.mock('../../../src/prisma', () => require('../../setup').makePrismaMock());
jest.mock('../../../src/queue', () => ({
    uploadQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
    connection:  { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
}));

const request  = require('supertest');
const prisma   = require('../../../src/prisma');
const { makeApp } = require('../../setup');
const router   = require('../../../src/routes/ar/customers');

describe('Customer routes', () => {
    beforeEach(() => jest.clearAllMocks());

    describe('POST /ar/customers/:code/dispute', () => {
        it('returns 200 and creates a dispute for a new code', async () => {
            prisma.customerDispute.findUnique.mockResolvedValue(null);
            prisma.customerMaster.findUnique.mockResolvedValue({ customerName: 'Test Co' });
            prisma.customerDispute.create.mockResolvedValue({});
            const res = await request(makeApp(router)).post('/ar/customers/BNG001/dispute');
            expect(res.status).toBe(200);
            expect(res.text).toContain('Disputed');
        });
    });

    describe('GET /ar/customers/:code/export', () => {
        it('returns 200 with xlsx content-type', async () => {
            prisma.invoice.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/customers/BNG001/export');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain(
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
        });
    });

    describe('GET /ar/customers/:code/statement', () => {
        it('returns 200 and renders a statement', async () => {
            prisma.invoice.findMany.mockResolvedValue([]);
            prisma.customerMaster.findUnique.mockResolvedValue({ customerName: 'Test Co', mobileNo: null });
            const res = await request(makeApp(router)).get('/ar/customers/BNG001/statement');
            expect(res.status).toBe(200);
        });
    });

    describe('GET /ar/customer/:code/trend (singular path)', () => {
        it('returns 200 and renders trend view', async () => {
            prisma.aRSnapshot.findMany.mockResolvedValue([]);
            prisma.invoice.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/customer/BNG001/trend');
            expect(res.status).toBe(200);
        });
    });

    describe('PUT /ar/customers/:customerCode/mobile', () => {
        it('returns 200 and saves the mobile number', async () => {
            prisma.customerMaster.upsert.mockResolvedValue({});
            const res = await request(makeApp(router))
                .put('/ar/customers/BNG001/mobile')
                .send({ mobileNo: '9876543210' });
            expect(res.status).toBe(200);
            expect(res.text).toContain('9876543210');
        });

        it('returns 403 for USER role', async () => {
            const res = await request(makeApp(router, { userRole: 'USER', userModules: [] }))
                .put('/ar/customers/BNG001/mobile')
                .send({ mobileNo: '9876543210' });
            expect(res.status).toBe(403);
        });
    });

    describe('POST /ar/customers/:customerCode/mobile/fetch', () => {
        it('returns 404 when no master number exists', async () => {
            prisma.customerMaster.findUnique.mockResolvedValue(null);
            const res = await request(makeApp(router))
                .post('/ar/customers/BNG001/mobile/fetch');
            expect(res.status).toBe(404);
        });

        it('returns 200 and restores master mobile number', async () => {
            prisma.customerMaster.findUnique.mockResolvedValue({ masterMobileNo: '9876543210' });
            prisma.customerMaster.update.mockResolvedValue({});
            const res = await request(makeApp(router))
                .post('/ar/customers/BNG001/mobile/fetch');
            expect(res.status).toBe(200);
            expect(res.text).toContain('9876543210');
        });
    });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
docker compose exec web pnpm test tests/routes/ar/customers.test.js
```

Expected: FAIL — `Cannot find module '../../../src/routes/ar/customers'`

- [ ] **Step 3: Create `src/routes/ar/customers.js`**

```js
// src/routes/ar/customers.js
const express  = require('express');
const router   = express.Router();
const prisma   = require('../../prisma');
const ExcelJS  = require('exceljs');
const { requireAuth, requireModule, requireRole } = require('../../middleware/auth');
```

Copy lines **1105–1217** from `src/routes/index.js` verbatim.

Then copy lines **1442–1480** from `src/routes/index.js` verbatim.

Append:
```js
module.exports = router;
```

- [ ] **Step 4: Verify no syntax errors**

```bash
docker compose exec web node --check src/routes/ar/customers.js
```

- [ ] **Step 5: Run test — confirm it passes**

```bash
docker compose exec web pnpm test tests/routes/ar/customers.test.js
```

Expected: PASS.

- [ ] **Step 6: Wire into index.js**

In `src/routes/index.js`:
1. Replace lines **1105–1217** with: `router.use(require('./ar/customers'));`
2. Replace lines **1442–1480** with nothing (they are now in customers.js).
   Since those lines are at the end of the file, delete them so `module.exports = router;` remains the last line.

   **Exact result after this step:** the customers section is replaced by one `router.use(require('./ar/customers'));` line. The mobile routes at the end of index.js are deleted.

- [ ] **Step 7: Re-run test**

```bash
docker compose exec web pnpm test tests/routes/ar/customers.test.js
```

Expected: PASS.

---

## Chunk 7: Comments Routes + Final index.js

### Task 9: comments.js — extract, test, and wire

**Files:**
- Create: `tests/routes/ar/comments.test.js`
- Create: `src/routes/ar/comments.js`
- Modify: `src/routes/index.js`

**Source lines:** Lines **1219–1439** in `src/routes/index.js`.
This block includes:
- `fetchStructuredComments` helper function (lines 1222–1251) — local function, not exported
- `GET /ar/comments/:customerCode` (lines 1253–1275)
- `POST /ar/comments` (lines 1277–1313)
- `PUT /ar/comments/:id` (lines 1315–1357)
- `POST /ar/comments/:id/resolve` (lines 1359–1397)
- `POST /ar/comments/:id/delete` (lines 1398–1428)
- `POST /ar/comments/:customerCode/delete-all` (lines 1429–1438)

- [ ] **Step 1: Write the failing test**

Create `tests/routes/ar/comments.test.js`:

```js
// tests/routes/ar/comments.test.js
jest.mock('../../../src/prisma', () => require('../../setup').makePrismaMock());
jest.mock('../../../src/queue', () => ({
    uploadQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
    connection:  { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
}));

const request  = require('supertest');
const prisma   = require('../../../src/prisma');
const { makeApp } = require('../../setup');
const router   = require('../../../src/routes/ar/comments');

describe('Comment routes', () => {
    beforeEach(() => jest.clearAllMocks());

    describe('GET /ar/comments/:customerCode', () => {
        it('returns 200 and renders comment panel', async () => {
            prisma.comment.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/comments/BNG001');
            expect(res.status).toBe(200);
        });

        it('returns 403 when user lacks ar_directory', async () => {
            const res = await request(makeApp(router, { userRole: 'USER', userModules: [] }))
                .get('/ar/comments/BNG001');
            expect(res.status).toBe(403);
        });
    });

    describe('POST /ar/comments', () => {
        it('returns 200 with rendered comment panel after creating comment', async () => {
            prisma.comment.create.mockResolvedValue({
                id: 'c1', customerCode: 'BNG001', comment: 'test',
                createdBy: 1, createdByName: 'Test User',
                replies: [], createdAt: new Date(), updatedAt: new Date(),
                parentId: null, followUpDate: null, resolved: false, invoiceNo: null
            });
            prisma.comment.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router))
                .post('/ar/comments')
                .send({ customerCode: 'BNG001', comment: 'Test comment', invoiceNo: '', parentId: '' });
            expect(res.status).toBe(200);
            expect(res.text).toContain('<');
        });

        it('returns 403 when USER has no ar_comments module and is not ADMIN/MANAGER', async () => {
            const res = await request(makeApp(router, { userRole: 'USER', userModules: [] }))
                .post('/ar/comments')
                .send({ customerCode: 'BNG001', comment: 'Test', invoiceNo: '', parentId: '' });
            expect(res.status).toBe(403);
        });
    });

    describe('PUT /ar/comments/:id', () => {
        it('returns 200 when author edits their own comment', async () => {
            prisma.comment.findUnique.mockResolvedValue({
                id: 'c1', createdBy: 1, customerCode: 'BNG001'
            });
            prisma.comment.update.mockResolvedValue({});
            prisma.comment.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router))
                .put('/ar/comments/c1')
                .send({ commentBody: 'updated', customerCode: 'BNG001', followUpDate: '' });
            expect(res.status).toBe(200);
        });

        it('returns 403 when non-author non-admin tries to edit', async () => {
            prisma.comment.findUnique.mockResolvedValue({
                id: 'c1', createdBy: 99, customerCode: 'BNG001'  // different user
            });
            const res = await request(makeApp(router, { userId: 1, userRole: 'USER', userModules: [] }))
                .put('/ar/comments/c1')
                .send({ commentBody: 'hack', customerCode: 'BNG001', followUpDate: '' });
            expect(res.status).toBe(403);
        });
    });

    describe('POST /ar/comments/:id/resolve', () => {
        it('returns 200 when author resolves their comment', async () => {
            prisma.comment.findUnique.mockResolvedValue({
                id: 'c1', createdBy: 1, resolved: false, customerCode: 'BNG001'
            });
            prisma.comment.update.mockResolvedValue({});
            prisma.comment.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).post('/ar/comments/c1/resolve');
            expect(res.status).toBe(200);
        });

        it('returns 403 when non-author USER tries to resolve', async () => {
            prisma.comment.findUnique.mockResolvedValue({
                id: 'c1', createdBy: 99, resolved: false, customerCode: 'BNG001'
            });
            const res = await request(makeApp(router, { userId: 1, userRole: 'USER', userModules: [] }))
                .post('/ar/comments/c1/resolve');
            expect(res.status).toBe(403);
        });
    });

    describe('POST /ar/comments/:id/delete (ADMIN only)', () => {
        it('returns 200 when ADMIN deletes a comment', async () => {
            prisma.comment.findUnique.mockResolvedValue({
                id: 'c1', customerCode: 'BNG001', parentId: null
            });
            prisma.comment.findMany.mockResolvedValueOnce([]).mockResolvedValue([]);
            prisma.comment.delete.mockResolvedValue({});
            const res = await request(makeApp(router)).post('/ar/comments/c1/delete');
            expect(res.status).toBe(200);
        });

        it('returns 403 when non-ADMIN tries to delete', async () => {
            const res = await request(makeApp(router, { userRole: 'USER', userModules: [] }))
                .post('/ar/comments/c1/delete');
            expect(res.status).toBe(403);
        });
    });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
docker compose exec web pnpm test tests/routes/ar/comments.test.js
```

Expected: FAIL — `Cannot find module '../../../src/routes/ar/comments'`

- [ ] **Step 3: Create `src/routes/ar/comments.js`**

```js
// src/routes/ar/comments.js
const express = require('express');
const router  = express.Router();
const prisma  = require('../../prisma');
const { requireAuth, requireModule, requireRole } = require('../../middleware/auth');
```

Copy lines **1219–1439** from `src/routes/index.js` verbatim.

Append:
```js
module.exports = router;
```

- [ ] **Step 4: Verify no syntax errors**

```bash
docker compose exec web node --check src/routes/ar/comments.js
```

- [ ] **Step 5: Run test — confirm it passes**

```bash
docker compose exec web pnpm test tests/routes/ar/comments.test.js
```

Expected: PASS.

- [ ] **Step 6: Wire into index.js**

In `src/routes/index.js`, replace lines **1219–1439** with:
```js
router.use(require('./ar/comments'));
```

- [ ] **Step 7: Re-run test**

```bash
docker compose exec web pnpm test tests/routes/ar/comments.test.js
```

Expected: PASS.

---

### Task 10: Replace index.js with thin assembler and run all tests

**Files:**
- Modify: `src/routes/index.js` (full rewrite)

After Tasks 4–9, `src/routes/index.js` has been progressively stripped down to approximately:
- The original top-of-file setup (lines 1–43: requires, uploadsDir, storage, multer, etc.)
- `GET /` home route (lines 44–47)
- Six `router.use(require('./ar/...'))` lines (added in Tasks 4–9)
- `module.exports = router;`

This task rewrites index.js to its clean final form.

- [ ] **Step 1: Rewrite `src/routes/index.js` to its final form**

Replace the entire file with:

```js
// src/routes/index.js
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');

// Hub home
router.get('/', requireAuth, (req, res) => res.render('home'));

// AR sub-routers
router.use(require('./ar/dashboard'));
router.use(require('./ar/directory'));
router.use(require('./ar/upload'));
router.use(require('./ar/invoices'));
router.use(require('./ar/customers'));
router.use(require('./ar/comments'));

module.exports = router;
```

- [ ] **Step 2: Verify index.js has no syntax errors**

```bash
docker compose exec web node --check src/routes/index.js
```

- [ ] **Step 3: Run the full test suite**

```bash
docker compose exec web pnpm test
```

Expected: ALL tests pass. You should see 6 test suites, all green.

- [ ] **Step 4: Verify the app starts cleanly**

```bash
docker compose logs web --tail=30
```

Expected: `Server listening on port 3000` — no errors or unhandled exceptions.
If the app was already running: `docker compose restart web` first.

- [ ] **Step 5: Smoke-test the running app**

Open a browser or use curl to verify the key pages load:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/login
```

Expected: `200`

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ar
```

Expected: `302` (redirects to login — not logged in)

---

## Final verification checklist

- [ ] `pnpm test` inside Docker passes all 6 suites with zero failures
- [ ] `node --check` passes on all 8 new/modified source files:
  - `src/routes/index.js`
  - `src/routes/ar/_shared.js`
  - `src/routes/ar/dashboard.js`
  - `src/routes/ar/directory.js`
  - `src/routes/ar/upload.js`
  - `src/routes/ar/invoices.js`
  - `src/routes/ar/customers.js`
  - `src/routes/ar/comments.js`
- [ ] The web container starts without errors
- [ ] Admin and auth routes still work (they were not modified)
