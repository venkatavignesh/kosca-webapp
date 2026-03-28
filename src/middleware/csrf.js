const crypto = require('crypto');

function csrfProtection(req, res, next) {
    // Ensure token exists in session
    if (req.session && !req.session._csrf) {
        req.session._csrf = crypto.randomBytes(32).toString('hex');
    }

    // Make token available to views
    res.locals.csrfToken = req.session?._csrf || '';

    // Skip validation for safe methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    // Validate token from body or header
    const token = req.body?._csrf || req.headers['x-csrf-token'];
    if (!token || token !== req.session?._csrf) {
        if (req.headers['hx-request']) {
            return res.status(403).send(
                '<div class="text-red-600 text-sm font-medium">Session expired. Please refresh the page.</div>'
            );
        }
        return res.status(403).render('error', {
            message: 'Forbidden',
            details: 'Invalid or missing CSRF token. Please refresh the page and try again.'
        });
    }

    next();
}

module.exports = { csrfProtection };
