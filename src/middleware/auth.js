const prisma = require('../prisma');
const logger = require('../logger');

// Middleware to check if user is logged in
const requireAuth = (req, res, next) => {
    if (req.session && req.session.userId) {
        return next();
    }
    // Set redirect to URL before login (optional improvement later)
    res.redirect('/login');
};

// Middleware to check if user has a specific role
const requireRole = (allowedRoles) => {
    return (req, res, next) => {
        if (!req.session || !req.session.userId) {
            return res.redirect('/login');
        }

        const userRole = req.session.userRole;
        if (allowedRoles.includes(userRole)) {
            return next();
        }

        res.status(403).render('error', {
            message: 'Access Denied',
            details: 'You do not have the required role to view this page.',
        });
    };
};

// Middleware to check if user has access to a specific module
const requireModule = (moduleName) => {
    return (req, res, next) => {
        if (!req.session || !req.session.userId) {
            return res.redirect('/login');
        }

        const userModules = req.session.userModules || [];
        const userRole = req.session.userRole;

        // ADMIN bypasses all module checks
        if (userRole === 'ADMIN' || userModules.includes(moduleName)) {
            return next();
        }

        res.status(403).render('error', {
            message: 'Module Not Assigned',
            details: `Your account has not been assigned the '${moduleName}' module. Please contact your administrator.`,
        });
    };
};

// In-memory TTL cache for user role/module lookups (avoids DB hit on every request)
const USER_CACHE_TTL = 30_000; // 30 seconds
const userCache = new Map(); // userId → { data, expiresAt }

function getCachedUser(userId) {
    const entry = userCache.get(userId);
    if (entry && Date.now() < entry.expiresAt) return entry.data;
    userCache.delete(userId);
    return null;
}

function setCachedUser(userId, data) {
    userCache.set(userId, { data, expiresAt: Date.now() + USER_CACHE_TTL });
    // Prevent unbounded growth — evict expired entries periodically
    if (userCache.size > 500) {
        const now = Date.now();
        for (const [k, v] of userCache) {
            if (now >= v.expiresAt) userCache.delete(k);
        }
    }
}

// Helper middleware to expose user session to views automatically
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const { connection: redisConn } = require('../queue');

const fmtSyncIST = (iso) => {
    if (!iso) return null;
    return new Date(iso).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    });
};

const PAGE_TITLES = {
    '/': 'Home',
    '/ar': 'Dashboard',
    '/ar/directory': 'Customers',
    '/ar/groups': 'Groups',
    '/ar/upload': 'Data Upload & Sync',
    '/ar/assignments': 'Assignments',
    '/admin/users': 'Users',
    '/admin/categories': 'Categories',
    '/admin/site-assignments': 'Site Assignments',
    '/admin/group-import': 'Group Import',
    '/admin/branding': 'Branding',
    '/login': 'Sign In',
};

const injectUserToLocals = async (req, res, next) => {
    let userRole = req.session.userRole || null;
    let userModules = req.session.userModules || [];

    // Re-read role+modules so admin changes take effect within 30s,
    // without requiring the user to log out and back in.
    if (req.session.userId) {
        let fresh = getCachedUser(req.session.userId);
        if (!fresh) {
            try {
                fresh = await prisma.user.findUnique({
                    where: { id: req.session.userId },
                    select: { role: true, modules: true, name: true },
                });
                if (fresh) setCachedUser(req.session.userId, fresh);
            } catch (err) {
                logger.warn({ err: err.message, userId: req.session.userId }, 'Failed to refresh user from DB');
            }
        }
        if (fresh) {
            userRole = fresh.role;
            userModules = fresh.modules || [];
            req.session.userRole = userRole;
            req.session.userModules = userModules;
            req.session.userName = fresh.name;
        }
    }

    // Dynamic page title + header name
    const path = req.path.replace(/\/$/, '') || '/';
    const title = PAGE_TITLES[path];
    if (title) {
        res.locals.pageName = title;
        res.locals.pageTitle = title + ' — Kosca Distribution LLP';
    } else if (path.startsWith('/ar/customer/')) {
        res.locals.pageName = 'Customer';
        res.locals.pageTitle = 'Customer — Kosca Distribution LLP';
    } else if (path.startsWith('/admin/')) {
        res.locals.pageName = 'Settings';
        res.locals.pageTitle = 'Settings — Kosca Distribution LLP';
    }

    res.locals.user = req.session.userId
        ? {
              id: req.session.userId,
              name: req.session.userName,
              role: userRole,
              modules: userModules,
          }
        : null;

    // Use this in every view instead of checking userRole directly
    res.locals.hasModule = (mod) => !!req.session.userId && (userRole === 'ADMIN' || userModules.includes(mod));

    res.locals.currentPath = req.path;

    // Global date formatter — produces 01-JAN-2026
    res.locals.fmtDate = (date) => {
        if (!date) return '';
        const d = new Date(date);
        if (isNaN(d.getTime())) return '';
        const day = String(d.getDate()).padStart(2, '0');
        return `${day}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
    };

    // Sync timestamps for header — lightweight Redis reads
    if (req.session.userId) {
        try {
            const [arSync, cmSync, psSync, arMtime, cmMtime] = await Promise.all([
                redisConn.get('kosca:last_ar_sync'),
                redisConn.get('kosca:last_cm_sync'),
                redisConn.get('kosca:last_ps_sync'),
                redisConn.get('kosca:last_ar_file_mtime'),
                redisConn.get('kosca:last_cm_file_mtime'),
            ]);
            res.locals.syncInfo = {
                arFileDate: fmtSyncIST(arMtime),
                arImportedAt: fmtSyncIST(arSync),
                cmFileDate: fmtSyncIST(cmMtime),
                cmImportedAt: fmtSyncIST(cmSync),
                psImportedAt: fmtSyncIST(psSync),
            };
        } catch (err) {
            logger.warn({ err: err.message }, 'Failed to read sync info from Redis');
            res.locals.syncInfo = null;
        }
    }

    next();
};

module.exports = {
    requireAuth,
    requireRole,
    requireModule,
    injectUserToLocals,
};
