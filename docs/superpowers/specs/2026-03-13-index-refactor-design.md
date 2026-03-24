# index.js Refactor + Integration Tests Design

## Goal

Split `src/routes/index.js` (1,482 lines) into focused sub-routers under `src/routes/ar/`, then add Supertest integration tests for every sub-router that assert both HTTP status codes and key response body fields.

## Architecture

`src/routes/index.js` becomes a ~25-line thin assembler that mounts 6 sub-routers. No logic moves between files — this is a pure extraction with zero behaviour change.

The existing `admin.js` and `assignments.js` files are **not touched**.

## File Structure

```
src/routes/
  index.js               (~25 lines — thin assembler)
  ar/
    _shared.js           (~40 lines — shared utilities)
    dashboard.js         (~300 lines — GET /ar)
    directory.js         (~330 lines — GET /ar/directory, /ar/groups, /ar/groups-data)
    upload.js            (~145 lines — GET+POST /ar/upload, POST /ar/sync-now, GET /ar/upload/status)
    invoices.js          (~265 lines — GET /ar/invoices, GET /ar/invoices/:customerCode)
    customers.js         (~200 lines — dispute, export, statement, trend, mobile)
    comments.js          (~185 lines — all 5 comment CRUD endpoints)

tests/
  setup.js               (global Jest setup: mock session helper)
  routes/ar/
    dashboard.test.js
    directory.test.js
    upload.test.js
    invoices.test.js
    customers.test.js
    comments.test.js

jest.config.js
```

## Shared Utilities (`_shared.js`)

Exports three things used across `ar/` sub-routers:

```js
const uploadsDir = path.join(__dirname, '../../../uploads');

// Ensure uploads directory exists on startup (moved from index.js lines 12–15)
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
        filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
    }),
    fileFilter: (req, file, cb) => {
        const extOk = ['.xlsx', '.xls'].includes(path.extname(file.originalname).toLowerCase());
        const mimeOk = ALLOWED_EXCEL_MIMES.includes(file.mimetype);
        extOk && mimeOk ? cb(null, true) : cb(new Error('Only .xlsx and .xls files are allowed'));
    }
});

// Exact response bodies preserved from source (HTMX partial-swap format — zero behaviour change)
function requireInvoicesAccess(req, res, next) {
    const role = req.session.userRole;
    const modules = req.session.userModules || [];
    const has = (m) => role === 'ADMIN' || modules.includes(m);
    const keyOnly = req.query.keyOnly === '1';
    const subOnly = req.query.subOnly === '1';
    const othersOnly = req.query.othersOnly === '1';
    if (keyOnly    && !has('ar_key_accounts'))     return res.status(403).send('<div class="text-red-500 p-4">Access denied.</div>');
    if (subOnly    && !has('ar_sub_distributors')) return res.status(403).send('<div class="text-red-500 p-4">Access denied.</div>');
    if (othersOnly && !has('ar_others'))           return res.status(403).send('<div class="text-red-500 p-4">Access denied.</div>');
    if (!keyOnly && !subOnly && !othersOnly && !has('ar_directory')) return res.status(403).send('<div class="text-red-500 p-4">Module not assigned.</div>');
    next();
}

module.exports = { uploadsDir, upload, requireInvoicesAccess };
```

`admin.js` keeps its own `uploadsDir` and multer setup — not merged.

## New `index.js`

```js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, (req, res) => res.render('home'));
router.use(require('./ar/dashboard'));
router.use(require('./ar/directory'));
router.use(require('./ar/upload'));
router.use(require('./ar/invoices'));
router.use(require('./ar/customers'));
router.use(require('./ar/comments'));

module.exports = router;
```

## Sub-router Route Map

### `dashboard.js`
- `GET /ar` — AR metrics dashboard (requires `ar_dashboard` module)

### `directory.js`
- `GET /ar/directory` — customer directory (requires `ar_directory`)
- `GET /ar/groups` — customer groups page (requires `ar_directory`)
- `GET /ar/groups-data` — paginated/filtered customer groups JSON (requires `ar_directory`)
- `GET /ar/key-accounts` — key accounts page render (requires `ar_key_accounts`)
- `GET /ar/sub-distributors` — sub distributors page render (requires `ar_sub_distributors`)
- `GET /ar/others` — others page render (requires `ar_others`)

### `upload.js`
- `GET /ar/upload` — upload form (requires `ar_upload`)
- `POST /ar/upload` — receive file, enqueue BullMQ job (requires `ar_upload`)
- `POST /ar/sync-now` — trigger immediate sync (requires ADMIN or MANAGER role)
- `GET /ar/upload/status` — job status polling (requires auth)

### `invoices.js`
- `GET /ar/invoices` — invoice list with filters, pagination (requires `requireInvoicesAccess`)
- `GET /ar/invoices/:customerCode` — invoice detail for one customer (requires `ar_directory`)

### `customers.js`
- `POST /ar/customers/:code/dispute` — flag dispute (requires `ar_directory`)
- `GET /ar/customers/:code/export` — export invoices as Excel (requires `ar_directory`)
- `GET /ar/customers/:code/statement` — render statement view (requires `ar_directory`)
- `GET /ar/customer/:code/trend` — AR trend data JSON (requires `ar_directory`) — NOTE: singular `/ar/customer/` is intentional, matching source. Do not change to `/ar/customers/`.
- `PUT /ar/customers/:customerCode/mobile` — update mobile (requires ADMIN or MANAGER)
- `POST /ar/customers/:customerCode/mobile/fetch` — restore master mobile (requires ADMIN or MANAGER)

### `comments.js`
- `GET /ar/comments/:customerCode` — list comments (requires `ar_directory`)
- `POST /ar/comments` — create comment (requires auth)
- `PUT /ar/comments/:id` — edit comment (requires auth)
- `POST /ar/comments/:id/resolve` — resolve/unresolve (requires auth; author or admin/manager)
- `POST /ar/comments/:id/delete` — delete one comment (requires ADMIN role)
- `POST /ar/comments/:customerCode/delete-all` — delete all comments for customer (requires ADMIN role)

**Local helper (not exported):** `fetchStructuredComments(customerCode)` — async function (source lines 1222–1251) that loads all comments for a customer and assembles them into a threaded tree (roots with nested `replies` arrays). Used by GET list, POST create, PUT edit, POST resolve, POST delete-all. Lives in `comments.js` only, not in `_shared.js`.

## Testing Approach

**Stack:** Jest + Supertest (dev dependencies). Run with `docker compose exec web pnpm test`.

**Pattern:** Each test file creates a minimal Express app with the router under test plus a fake-session middleware. Prisma and the BullMQ queue are mocked at the Jest module level.

```js
// Typical test file structure
jest.mock('../../../src/prisma');
jest.mock('../../../src/queue', () => ({
    uploadQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
    connection: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK')
    }
}));

const request = require('supertest');
const express = require('express');
const router = require('../../../src/routes/ar/dashboard');

function makeApp(session = {}) {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => {
        req.session = { userId: 1, userRole: 'ADMIN', userModules: ['ar_dashboard'], ...session };
        next();
    });
    app.use(router);
    // Error handler: converts multer/validation errors to 400; everything else to 500
    app.use((err, req, res, next) => {
        if (err && (err.message?.includes('Only .xlsx') || err.code === 'LIMIT_FILE_SIZE')) {
            return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: err.message });
    });
    return app;
}
```

The error handler in `makeApp()` is **required in all test apps** (not just `upload.test.js`) because Express 5 propagates errors differently from Express 4. Every `makeApp()` call must include it. The multer `fileFilter` rejection produces a 400; any other error produces a 500.

**Coverage per file:**

| Test file | Status assertions | Body assertions |
|---|---|---|
| `dashboard.test.js` | 200 (authed+module), 302 (no session), 403 (wrong module) | Response HTML contains aging bucket labels |
| `directory.test.js` | 200 /ar/directory, 200 /ar/groups, 200 /ar/groups-data (HTML partial), 302 unauthenticated, 403 missing module | groups-data response body contains HTML table rows |
| `upload.test.js` | 200 GET form, 200 POST success (HTMX HTML partial), 400 bad MIME (via error handler), 403 wrong role for sync | POST success body contains `bg-green-100` class |
| `invoices.test.js` | 200 default, 403 keyOnly without module, 200 keyOnly with module | Response contains invoice rows from mock |
| `customers.test.js` | 200 statement, 200 trend (HTML render), 200 export (xlsx content-type), 403 unauthenticated mobile update | Export response has `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `comments.test.js` | 200 POST comment (renders comment panel partial), 200 resolve (author), 403 resolve (non-author non-admin), 200 DELETE (admin) | POST response body contains rendered HTML comment panel |

**Mock setup:** `tests/setup.js` exports a `mockPrisma` object with jest.fn() stubs for all methods used. Each test resets mocks with `beforeEach(() => jest.clearAllMocks())`.

## Tooling Changes

- Add to `package.json` devDependencies: `jest ^29`, `supertest ^7`
- Add `jest.config.js`:
  ```js
  module.exports = {
      testEnvironment: 'node',
      testMatch: ['**/tests/**/*.test.js']
  };
  ```
- `tests/setup.js` is **not** a Jest framework-level setup file. It is a helper module that each test file imports explicitly (e.g. `const { mockPrisma } = require('../../setup')`). It exports pre-configured mock objects so tests don't repeat mock setup code.
- Add `"test": "jest"` to `package.json` scripts

## Constraints

- Zero behaviour change — pure file reorganisation
- `admin.js` untouched
- `server.js` untouched (it already requires `./routes` which re-exports the same router)
- pnpm for all package operations
