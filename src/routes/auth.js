const express = require('express');
const router = express.Router();
const prisma = require('../prisma');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const logger = require('../logger');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,                   // 10 attempts per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
    skipSuccessfulRequests: true
});

// Render login page
router.get('/login', (req, res) => {
    // Redirect if already logged in
    if (req.session.userId) {
        return res.redirect('/');
    }
    res.render('login', { error: null });
});

// Handle login attempt
router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.render('login', { error: 'Please enter both email and password.' });
    }

    try {
        const user = await prisma.user.findUnique({
            where: { email },
        });

        if (!user) {
            return res.render('login', { error: 'Invalid email or password.' });
        }

        const isValid = await bcrypt.compare(password, user.password);

        if (!isValid) {
            return res.render('login', { error: 'Invalid email or password.' });
        }

        // Establish session
        req.session.userId = user.id;
        req.session.userRole = user.role;
        req.session.userName = user.name;
        req.session.userModules = user.modules || [];

        // Determine redirect path based on modules
        // If they have dashboard access, send to dashboard. Otherwise send to first available module.
        if (user.modules.includes('ar_dashboard')) {
            return res.redirect('/ar');
        } else if (user.modules.includes('ar_directory')) {
            return res.redirect('/ar/directory');
        } else if (user.modules.includes('ar_upload')) {
            return res.redirect('/ar/upload');
        } else if (user.role === 'ADMIN') {
            return res.redirect('/admin/users');
        }

        // Fallback for user with no modules
        res.redirect('/');

    } catch (error) {
        logger.error({ err: error, route: 'POST /login' }, 'Login error');
        res.render('login', { error: 'An internal server error occurred.' });
    }
});

// Handle logout
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            logger.error({ err, route: 'GET /logout' }, 'Session destruction error');
        }
        res.redirect('/login');
    });
});

module.exports = router;
