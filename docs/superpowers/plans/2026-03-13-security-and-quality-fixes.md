# Security and Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all CRITICAL, HIGH, and MEDIUM issues identified in the code review — hardcoded secrets, path traversal, XSS, missing auth checks, rate limiting, N+1 queries, and unbounded pagination.

**Architecture:** Fixes are surgical and in-place. No new modules are introduced except `express-rate-limit` for login brute-force protection. All changes stay within the existing Express/Prisma/BullMQ stack.

**Tech Stack:** Node.js 20, Express 5, Prisma 6, BullMQ 5, Redis (ioredis), express-rate-limit (new)

---

## Chunk 1: Critical Security Fixes

### Task 1: Fix hardcoded session secret (C-1)

**Files:**
- Modify: `.env`
- Modify: `src/server.js:36`

- [ ] **Step 1: Add SESSION_SECRET to .env**

Open `.env` and append after the last line:

```
SESSION_SECRET=replace_this_with_output_of_openssl_rand_hex_32
```

Generate a real value by running inside the container:
```bash
docker compose exec web node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Replace the placeholder with that output.

- [ ] **Step 2: Remove the hardcoded fallback in server.js**

In `src/server.js`, replace lines 34–44:

```js
// OLD
app.use(session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET || 'super_secret_kosca_key', // In prod, set this in .env
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
    }
}));
```

```js
// NEW
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) throw new Error('SESSION_SECRET env var is required — set it in .env');

app.use(session({
    store: new RedisStore({ client: redisClient }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
    }
}));
```

- [ ] **Step 3: Verify the server starts**

```bash
docker compose up --build web
```
Expected: server starts without error, no "SESSION_SECRET env var is required" in logs.

---

### Task 2: Fix path traversal in group import (C-2)

**Files:**
- Modify: `src/routes/admin.js:624–654`

The fix is to reject any `filePath` that is not inside `uploadsDir`. Add a helper at the top of the file and use it in both `/group-import/reload-cols` and `/group-import/process`.

- [ ] **Step 1: Add `safeUploadPath` helper after the `uploadsDir` declaration (line 11)**

```js
// Add immediately after: const uploadsDir = path.join(__dirname, '../../uploads');
function safeUploadPath(filePath) {
    const resolved = path.resolve(uploadsDir, path.basename(filePath));
    if (!resolved.startsWith(uploadsDir + path.sep) && resolved !== uploadsDir) {
        throw new Error('Invalid file path');
    }
    return resolved;
}
```

- [ ] **Step 2: Use `safeUploadPath` in `/group-import/reload-cols` (line 625)**

Replace:
```js
router.post('/group-import/reload-cols', canManageGroups, async (req, res) => {
    const { filePath, sheet } = req.body;
    try {
        const wb = xlsx.readFile(filePath);
```

With:
```js
router.post('/group-import/reload-cols', canManageGroups, async (req, res) => {
    const { filePath, sheet } = req.body;
    try {
        const wb = xlsx.readFile(safeUploadPath(filePath));
```

- [ ] **Step 3: Use `safeUploadPath` in `/group-import/process` (line 649–653)**

Replace:
```js
router.post('/group-import/process', canManageGroups, async (req, res) => {
    const { filePath, sheet, groupCol, codeCol } = req.body;
    const groupIdx = parseInt(groupCol, 10);
    const codeIdx  = parseInt(codeCol,  10);
    try {
        const wb = xlsx.readFile(filePath);
```

With:
```js
router.post('/group-import/process', canManageGroups, async (req, res) => {
    const { filePath, sheet, groupCol, codeCol } = req.body;
    const groupIdx = parseInt(groupCol, 10);
    const codeIdx  = parseInt(codeCol,  10);
    try {
        const wb = xlsx.readFile(safeUploadPath(filePath));
```

- [ ] **Step 4: Verify the server reloads cleanly**

```bash
docker compose logs -f web
```
Expected: no startup errors.

---

### Task 3: Fix reflected XSS in upload response (M-2)

**Files:**
- Modify: `src/routes/index.js:723`

- [ ] **Step 1: Escape the filename before interpolation**

Replace lines 722–724:
```js
        res.send(`<div class="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded relative" role="alert">
      ${label}: ${req.file.originalname} uploaded and added to processing queue. <a href="/ar" class="underline font-semibold">View Dashboard</a>
    </div>`);
```

With:
```js
        const safeName = req.file.originalname
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        res.send(`<div class="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded relative" role="alert">
      ${label}: ${safeName} uploaded and added to processing queue. <a href="/ar" class="underline font-semibold">View Dashboard</a>
    </div>`);
```

---

## Chunk 2: Authentication and Authorization

### Task 4: Add rate limiting to login (H-1)

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `src/routes/auth.js`

- [ ] **Step 1: Install express-rate-limit inside the web container**

```bash
docker compose exec web npm install express-rate-limit
```

Expected: `express-rate-limit` appears in `package.json` dependencies.

- [ ] **Step 2: Add rate limiter to POST /login in auth.js**

Add after line 4 (`const bcrypt = require('bcrypt');`):

```js
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,                   // 10 attempts per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
    skipSuccessfulRequests: true
});
```

- [ ] **Step 3: Apply limiter to the POST /login route**

Replace:
```js
router.post('/login', async (req, res) => {
```

With:
```js
router.post('/login', loginLimiter, async (req, res) => {
```

- [ ] **Step 4: Rebuild and verify**

```bash
docker compose up --build web
```
Expected: server starts. Manual test: submit login form 11 times with wrong creds — 11th attempt returns 429.

---

### Task 5: Add authorization check to comment resolve (H-4)

**Files:**
- Modify: `src/routes/index.js:1330–1360`

Any authenticated user can currently mark any comment as resolved. Only the comment's author OR an ADMIN/MANAGER should be allowed to.

- [ ] **Step 1: Add ownership/role check after fetching `existing`**

Replace the block from line 1330:
```js
router.post('/ar/comments/:id/resolve', requireAuth, async (req, res) => {
    try {
        const commentId = req.params.id;
        const { customerCode } = req.body;

        const existing = await prisma.comment.findUnique({ where: { id: commentId } });
        if (!existing) return res.status(404).send('Comment not found');

        await prisma.comment.update({
```

With:
```js
router.post('/ar/comments/:id/resolve', requireAuth, async (req, res) => {
    try {
        const commentId = req.params.id;
        const { customerCode } = req.body;

        const existing = await prisma.comment.findUnique({ where: { id: commentId } });
        if (!existing) return res.status(404).send('Comment not found');

        const isAuthor = existing.createdBy === req.session.userId;
        const isAdminOrManager = req.session.userRole === 'ADMIN' || req.session.userRole === 'MANAGER';
        if (!isAuthor && !isAdminOrManager) {
            return res.status(403).send('<div class="text-red-500 text-sm p-4">Not authorized to resolve this comment</div>');
        }

        await prisma.comment.update({
```

---

### Task 6: Add requireAuth to the home route (M-6)

**Files:**
- Modify: `src/routes/index.js:38`

- [ ] **Step 1: Add requireAuth middleware**

Replace:
```js
router.get('/', (req, res) => {
    res.render('home');
});
```

With:
```js
router.get('/', requireAuth, (req, res) => {
    res.render('home');
});
```

- [ ] **Step 2: Verify unauthenticated users are redirected**

Navigate to `http://localhost:3001/` without a session. Expected: redirect to `/login`.

---

## Chunk 3: Input Validation and Performance

### Task 7: Clamp unbounded limit parameter (H-2)

**Files:**
- Modify: `src/routes/index.js:814`
- Modify: `src/routes/admin.js:155`, `250`, `343`

Replace every unguarded `parseInt(req.query.limit)` with a clamped version.

- [ ] **Step 1: Fix `src/routes/index.js:814`**

Replace:
```js
    const limit = parseInt(req.query.limit) || 10;
```
With:
```js
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 200);
```

- [ ] **Step 2: Fix key-accounts in `src/routes/admin.js:155`**

Replace:
```js
        const limit = parseInt(req.query.limit) || 20;
```
With:
```js
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 200);
```

- [ ] **Step 3: Fix others in `src/routes/admin.js:250`**

Replace:
```js
        const limit = parseInt(req.query.limit) || 20;
```
With:
```js
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 200);
```

- [ ] **Step 4: Fix sub-distributors in `src/routes/admin.js:343`**

Replace:
```js
        const limit = parseInt(req.query.limit) || 20;
```
With:
```js
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 200);
```

Note: These are the only three pages that have user-controlled pagination. There may be other `parseInt(req.query.limit)` usages — grep to be safe:
```bash
grep -n 'parseInt(req.query.limit)' src/routes/admin.js src/routes/index.js src/routes/assignments.js
```
Apply the same clamp to any additional hits.

---

### Task 8: Fix N+1 queries in admin account list pages (H-3)

**Files:**
- Modify: `src/routes/admin.js:172–182` (key accounts)
- Modify: `src/routes/admin.js:266–276` (others)
- Modify: `src/routes/admin.js:360–370` (sub distributors)

The pattern is identical in all three: loop over accounts, fire 1–2 queries per row to resolve a missing name. Replace with: collect missing codes → two batched queries → in-memory map.

- [ ] **Step 1: Fix key accounts name resolution (lines 172–182)**

Replace:
```js
        // Re-resolve names for entries that are still unknown
        for (const ka of keyAccounts) {
            if (!ka.customerName) {
                const master = await prisma.customerMaster.findUnique({ where: { customerCode: ka.customerCode }, select: { customerName: true } });
                const invoice = !master ? await prisma.invoice.findFirst({ where: { customerCode: ka.customerCode }, select: { customerName: true } }) : null;
                const resolvedName = master?.customerName || invoice?.customerName || null;
                if (resolvedName) {
                    await prisma.keyAccount.update({ where: { id: ka.id }, data: { customerName: resolvedName } });
                    ka.customerName = resolvedName;
                }
            }
        }
```

With:
```js
        // Batch-resolve missing names
        const missingKA = keyAccounts.filter(ka => !ka.customerName).map(ka => ka.customerCode);
        if (missingKA.length > 0) {
            const [masterRows, invoiceRows] = await Promise.all([
                prisma.customerMaster.findMany({ where: { customerCode: { in: missingKA } }, select: { customerCode: true, customerName: true } }),
                prisma.invoice.findMany({ where: { customerCode: { in: missingKA } }, select: { customerCode: true, customerName: true }, distinct: ['customerCode'] })
            ]);
            const masterMap = Object.fromEntries(masterRows.map(r => [r.customerCode, r.customerName]));
            const invoiceMap = Object.fromEntries(invoiceRows.map(r => [r.customerCode, r.customerName]));
            const toUpdate = [];
            for (const ka of keyAccounts) {
                if (!ka.customerName) {
                    const resolved = masterMap[ka.customerCode] || invoiceMap[ka.customerCode] || null;
                    if (resolved) { ka.customerName = resolved; toUpdate.push({ id: ka.id, name: resolved }); }
                }
            }
            await Promise.all(toUpdate.map(u => prisma.keyAccount.update({ where: { id: u.id }, data: { customerName: u.name } })));
        }
```

- [ ] **Step 2: Fix others name resolution (lines 266–276)**

Replace:
```js
        for (const oa of otherAccounts) {
            if (!oa.customerName) {
                const master = await prisma.customerMaster.findUnique({ where: { customerCode: oa.customerCode }, select: { customerName: true } });
                const invoice = !master ? await prisma.invoice.findFirst({ where: { customerCode: oa.customerCode }, select: { customerName: true } }) : null;
                const resolvedName = master?.customerName || invoice?.customerName || null;
                if (resolvedName) {
                    await prisma.otherAccount.update({ where: { id: oa.id }, data: { customerName: resolvedName } });
                    oa.customerName = resolvedName;
                }
            }
        }
```

With:
```js
        const missingOA = otherAccounts.filter(oa => !oa.customerName).map(oa => oa.customerCode);
        if (missingOA.length > 0) {
            const [masterRows, invoiceRows] = await Promise.all([
                prisma.customerMaster.findMany({ where: { customerCode: { in: missingOA } }, select: { customerCode: true, customerName: true } }),
                prisma.invoice.findMany({ where: { customerCode: { in: missingOA } }, select: { customerCode: true, customerName: true }, distinct: ['customerCode'] })
            ]);
            const masterMap = Object.fromEntries(masterRows.map(r => [r.customerCode, r.customerName]));
            const invoiceMap = Object.fromEntries(invoiceRows.map(r => [r.customerCode, r.customerName]));
            const toUpdate = [];
            for (const oa of otherAccounts) {
                if (!oa.customerName) {
                    const resolved = masterMap[oa.customerCode] || invoiceMap[oa.customerCode] || null;
                    if (resolved) { oa.customerName = resolved; toUpdate.push({ id: oa.id, name: resolved }); }
                }
            }
            await Promise.all(toUpdate.map(u => prisma.otherAccount.update({ where: { id: u.id }, data: { customerName: u.name } })));
        }
```

- [ ] **Step 3: Fix sub-distributors name resolution (lines 360–370)**

Replace:
```js
        // Re-resolve names for entries that are still unknown
        for (const sd of subDistributors) {
            if (!sd.customerName) {
                const master = await prisma.customerMaster.findUnique({ where: { customerCode: sd.customerCode }, select: { customerName: true } });
                const invoice = !master ? await prisma.invoice.findFirst({ where: { customerCode: sd.customerCode }, select: { customerName: true } }) : null;
                const resolvedName = master?.customerName || invoice?.customerName || null;
                if (resolvedName) {
                    await prisma.subDistributor.update({ where: { id: sd.id }, data: { customerName: resolvedName } });
                    sd.customerName = resolvedName;
                }
            }
        }
```

With:
```js
        const missingSD = subDistributors.filter(sd => !sd.customerName).map(sd => sd.customerCode);
        if (missingSD.length > 0) {
            const [masterRows, invoiceRows] = await Promise.all([
                prisma.customerMaster.findMany({ where: { customerCode: { in: missingSD } }, select: { customerCode: true, customerName: true } }),
                prisma.invoice.findMany({ where: { customerCode: { in: missingSD } }, select: { customerCode: true, customerName: true }, distinct: ['customerCode'] })
            ]);
            const masterMap = Object.fromEntries(masterRows.map(r => [r.customerCode, r.customerName]));
            const invoiceMap = Object.fromEntries(invoiceRows.map(r => [r.customerCode, r.customerName]));
            const toUpdate = [];
            for (const sd of subDistributors) {
                if (!sd.customerName) {
                    const resolved = masterMap[sd.customerCode] || invoiceMap[sd.customerCode] || null;
                    if (resolved) { sd.customerName = resolved; toUpdate.push({ id: sd.id, name: resolved }); }
                }
            }
            await Promise.all(toUpdate.map(u => prisma.subDistributor.update({ where: { id: u.id }, data: { customerName: u.name } })));
        }
```

---

### Task 9: Fix N+1 in processCustomerMaster worker (H-7)

**Files:**
- Modify: `src/worker.js:205–231`

- [ ] **Step 1: Batch-fetch all locked status before the loop, then upsert in parallel batches**

Replace lines 205–231:
```js
    const total = records.length;
    let count = 0;

    for (let i = 0; i < total; i++) {
        const rec = records[i];
        // Check if mobile number is manually locked — if so, don't overwrite it
        const existing = await prisma.customerMaster.findUnique({
            where: { customerCode: rec.customerCode },
            select: { mobileNoLocked: true }
        });
        const updateData = { ...rec, masterMobileNo: rec.mobileNo || null };
        if (existing && existing.mobileNoLocked) {
            delete updateData.mobileNo;
            delete updateData.phone;
        }
        await prisma.customerMaster.upsert({
            where: { customerCode: rec.customerCode },
            update: updateData,
            create: { ...rec, masterMobileNo: rec.mobileNo || null },
        });
        count++;

        if (i % 50 === 0 || i === total - 1) {
            const progress = 40 + Math.floor((count / total) * 59);
            await job.updateProgress(progress);
        }
    }
```

With:
```js
    const total = records.length;

    // Batch-fetch locked status for all codes in one query
    const allCodes = records.map(r => r.customerCode);
    const lockedRows = await prisma.customerMaster.findMany({
        where: { customerCode: { in: allCodes }, mobileNoLocked: true },
        select: { customerCode: true }
    });
    const lockedSet = new Set(lockedRows.map(r => r.customerCode));

    // Process in batches of 50 to stay within Prisma/DB connection limits
    const BATCH = 50;
    let count = 0;
    for (let i = 0; i < total; i += BATCH) {
        const batch = records.slice(i, i + BATCH);
        await Promise.all(batch.map(rec => {
            const createData = { ...rec, masterMobileNo: rec.mobileNo || null };
            const updateData = { ...createData };
            if (lockedSet.has(rec.customerCode)) {
                delete updateData.mobileNo;
                delete updateData.phone;
            }
            return prisma.customerMaster.upsert({
                where: { customerCode: rec.customerCode },
                update: updateData,
                create: createData,
            });
        }));
        count += batch.length;
        await job.updateProgress(40 + Math.floor((count / total) * 59));
    }
```

---

### Task 10: Fix unbounded recursive comment deletion (M-3)

**Files:**
- Modify: `src/routes/index.js:1369–1374`

- [ ] **Step 1: Replace recursive function with iterative BFS**

Replace lines 1368–1375:
```js
        // Delete all descendants first (replies of replies etc.)
        const deleteDescendants = async (parentId) => {
            const children = await prisma.comment.findMany({ where: { parentId }, select: { id: true } });
            for (const child of children) await deleteDescendants(child.id);
            await prisma.comment.deleteMany({ where: { parentId } });
        };
        await deleteDescendants(commentId);
        await prisma.comment.delete({ where: { id: commentId } });
```

With:
```js
        // Collect all descendant IDs via iterative BFS, then delete in one query
        const allDescendantIds = [];
        const queue = [commentId];
        while (queue.length > 0) {
            const parentId = queue.shift();
            const children = await prisma.comment.findMany({ where: { parentId }, select: { id: true } });
            for (const child of children) {
                allDescendantIds.push(child.id);
                queue.push(child.id);
            }
        }
        if (allDescendantIds.length > 0) {
            await prisma.comment.deleteMany({ where: { id: { in: allDescendantIds } } });
        }
        await prisma.comment.delete({ where: { id: commentId } });
```

---

### Task 11: Add MIME type validation to file uploads (M-1)

**Files:**
- Modify: `src/routes/index.js:26–35`
- Modify: `src/routes/admin.js:12–20`

- [ ] **Step 1: Add mimetype check to AR upload multer config (index.js:27–34)**

Replace:
```js
const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const allowed = ['.xlsx', '.xls'];
        if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
            cb(null, true);
        } else {
            cb(new Error('Only .xlsx and .xls files are allowed'));
        }
    }
});
```

With:
```js
const ALLOWED_EXCEL_MIMES = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/octet-stream' // some browsers send this for .xls
];
const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const extOk = ['.xlsx', '.xls'].includes(path.extname(file.originalname).toLowerCase());
        const mimeOk = ALLOWED_EXCEL_MIMES.includes(file.mimetype);
        if (extOk && mimeOk) {
            cb(null, true);
        } else {
            cb(new Error('Only .xlsx and .xls files are allowed'));
        }
    }
});
```

- [ ] **Step 2: Add mimetype check to group import multer config (admin.js:12–20)**

Replace:
```js
const groupUpload = multer({
    storage: multer.diskStorage({
        destination: (_, __, cb) => cb(null, uploadsDir),
        filename:    (_, f, cb)  => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(f.originalname))
    }),
    fileFilter: (_, f, cb) => {
        ['.xlsx', '.xls'].includes(path.extname(f.originalname).toLowerCase()) ? cb(null, true) : cb(new Error('Only .xlsx and .xls files are allowed'));
    }
});
```

With:
```js
const ALLOWED_EXCEL_MIMES = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/octet-stream'
];
const groupUpload = multer({
    storage: multer.diskStorage({
        destination: (_, __, cb) => cb(null, uploadsDir),
        filename:    (_, f, cb)  => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(f.originalname))
    }),
    fileFilter: (_, f, cb) => {
        const extOk = ['.xlsx', '.xls'].includes(path.extname(f.originalname).toLowerCase());
        const mimeOk = ALLOWED_EXCEL_MIMES.includes(f.mimetype);
        extOk && mimeOk ? cb(null, true) : cb(new Error('Only .xlsx and .xls files are allowed'));
    }
});
```

---

## Verification

After all tasks are complete, run this end-to-end smoke check:

```bash
# Rebuild containers with all changes
docker compose up --build

# Verify server starts without errors
docker compose logs web | grep -E 'error|Error|SESSION_SECRET'

# Verify rate limiter is in package.json
grep 'express-rate-limit' package.json
```

Manual checks:
- [ ] Log in successfully → works
- [ ] Log in 11 times with wrong password → 429 on 11th
- [ ] Upload a valid `.xlsx` → success message shows escaped filename
- [ ] Navigate to `/` without session → redirected to `/login`
- [ ] `/admin/group-import/reload-cols` with `filePath=../../etc/passwd` → 500 (not a server-read of /etc/passwd)
- [ ] Open key-accounts, others, sub-distributors admin pages → load correctly
