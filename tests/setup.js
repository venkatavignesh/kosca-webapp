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
        pendingSettlement:  { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({}) },
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
                'ar_assign', 'ar_groups', 'admin_key_accounts', 'admin_sub_distributors'
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
        const _MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
        res.locals.fmtDate = (date) => {
            if (!date) return '';
            const d = new Date(date);
            if (isNaN(d.getTime())) return '';
            return `${String(d.getDate()).padStart(2,'0')}-${_MONTHS[d.getMonth()]}-${d.getFullYear()}`;
        };
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
