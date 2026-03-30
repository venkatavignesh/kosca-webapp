const express = require('express');
const path = require('path');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const logger = require('./logger');
const routes = require('./routes');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use(
    helmet({
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                defaultSrc: ["'self'"],
                // unsafe-inline + unsafe-eval required: Tailwind CDN uses eval() for config,
                // Alpine.js uses inline event handlers (@click). To remove these, migrate to
                // a local Tailwind build and Alpine CSP-compatible build.
                scriptSrc: [
                    "'self'",
                    "'unsafe-inline'",
                    "'unsafe-eval'",
                    'https://cdn.tailwindcss.com',
                    'https://unpkg.com',
                    'https://cdn.jsdelivr.net',
                ],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
                fontSrc: ["'self'", 'https://fonts.gstatic.com'],
                imgSrc: ["'self'", 'data:'],
                connectSrc: ["'self'", 'https://cdn.jsdelivr.net'],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'self'"],
            },
        },
        crossOriginEmbedderPolicy: false,
        hsts: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
    })
);

// Set up ejs view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Middleware
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Request logging
app.use(
    pinoHttp({
        logger,
        autoLogging: {
            ignore: (req) => req.url === '/health',
        },
    })
);

const session = require('express-session');
const { RedisStore } = require('connect-redis');
const Redis = require('ioredis');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const assignmentRoutes = require('./routes/assignments');
const { injectUserToLocals } = require('./middleware/auth');
const { csrfProtection } = require('./middleware/csrf');
const { setupScheduler } = require('./scheduler');

// Initialize Redis client for sessions
const redisClient = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

redisClient.on('error', (err) => logger.error({ err }, 'Redis client error'));
redisClient.on('connect', () => logger.info('Redis client connected'));

// If a reverse proxy (nginx, Traefik) is placed in front of this server,
// add: app.set('trust proxy', 1)
// This ensures express-rate-limit and session cookies use the real client IP/HTTPS status.
// Do NOT add it without a proxy — it would allow clients to spoof X-Forwarded-For.

// Session Middleware
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) throw new Error('SESSION_SECRET env var is required — set it in .env');

app.use(
    session({
        store: new RedisStore({ client: redisClient }),
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: process.env.NODE_ENV === 'production',
            httpOnly: true,
            sameSite: 'Strict',
            maxAge: 1000 * 60 * 60 * 24, // 24 hours
        },
    })
);

// Health check endpoint (before auth middleware)
app.get('/health', async (req, res) => {
    try {
        const dbOk = await require('./prisma').$queryRaw`SELECT 1`.then(() => true).catch(() => false);
        const redisOk = await redisClient
            .ping()
            .then(() => true)
            .catch(() => false);
        const healthy = dbOk && redisOk;
        res.status(healthy ? 200 : 503).json({
            status: healthy ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            checks: { database: dbOk ? 'ok' : 'fail', redis: redisOk ? 'ok' : 'fail' },
        });
    } catch {
        res.status(503).json({ status: 'error', timestamp: new Date().toISOString() });
    }
});

// Apply User Injector to all views
app.use(injectUserToLocals);

// CSRF protection (after session + body parsing, before routes)
app.use(csrfProtection);

// Authentication Routes
app.use('/', authRoutes);

// General Application Routes
app.use('/', routes);

// Admin Routes
app.use('/admin', adminRoutes);

// Assignment Management Routes
app.use('/ar/assignments', assignmentRoutes);

// Error Fallback
app.use((err, req, res, next) => {
    logger.error({ err, url: req.url, method: req.method }, 'Unhandled error');
    res.status(500).send('Something broke!');
});

const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Server listening');
    setupScheduler().catch((err) => logger.error({ err }, 'Scheduler setup failed'));
});

// Graceful shutdown
function gracefulShutdown(signal) {
    logger.info({ signal }, 'Shutting down gracefully');
    server.close(() => {
        logger.info('HTTP server closed');
        redisClient.quit().then(() => {
            logger.info('Redis connection closed');
            process.exit(0);
        });
    });
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
