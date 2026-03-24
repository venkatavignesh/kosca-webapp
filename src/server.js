const express = require('express');
const path = require('path');
const helmet = require('helmet');
const routes = require('./routes');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: false,
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com", "https://unpkg.com", "https://cdn.jsdelivr.net"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
        }
    },
    crossOriginEmbedderPolicy: false,
    hsts: false,
}));

// Set up ejs view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Middleware
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const session = require('express-session');
const RedisStore = require('connect-redis').default;
const Redis = require('ioredis');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const assignmentRoutes = require('./routes/assignments');
const { injectUserToLocals } = require('./middleware/auth');
const { setupScheduler } = require('./scheduler');

// Initialize Redis client for sessions
const redisClient = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

redisClient.on('error', (err) => console.log('Redis Client Error', err));
redisClient.on('connect', () => console.log('Redis Client Connected'));

// If a reverse proxy (nginx, Traefik) is placed in front of this server,
// add: app.set('trust proxy', 1)
// This ensures express-rate-limit and session cookies use the real client IP/HTTPS status.
// Do NOT add it without a proxy — it would allow clients to spoof X-Forwarded-For.

// Session Middleware
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
        sameSite: 'Strict',
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
    }
}));

// Health check endpoint (before auth middleware)
app.get('/health', async (req, res) => {
    try {
        const dbOk = await require('./prisma').$queryRaw`SELECT 1`.then(() => true).catch(() => false);
        const redisOk = await redisClient.ping().then(() => true).catch(() => false);
        const healthy = dbOk && redisOk;
        res.status(healthy ? 200 : 503).json({
            status: healthy ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            checks: { database: dbOk ? 'ok' : 'fail', redis: redisOk ? 'ok' : 'fail' }
        });
    } catch {
        res.status(503).json({ status: 'error', timestamp: new Date().toISOString() });
    }
});

// Apply User Injector to all views
app.use(injectUserToLocals);

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
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

const server = app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    setupScheduler().catch(err => console.error('[Scheduler] Setup failed:', err));
});

// Graceful shutdown
function gracefulShutdown(signal) {
    console.log(`${signal} received. Shutting down gracefully...`);
    server.close(() => {
        console.log('HTTP server closed.');
        redisClient.quit().then(() => {
            console.log('Redis connection closed.');
            process.exit(0);
        });
    });
    setTimeout(() => {
        console.error('Forced shutdown after timeout.');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
