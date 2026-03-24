#!/usr/bin/env node
/**
 * scripts/impact-map.js
 *
 * Dependency graph for the Kosca AR System.
 * Given an absolute path to a changed file, returns:
 *   { tier, reason, unitTests[], e2eSpecs[], smokeEndpoints[] }
 *
 * Tier values (ascending blast radius):
 *   test     — only the modified test file itself
 *   view     — a page-specific EJS template
 *   partial  — a shared partial (affects multiple pages)
 *   route    — a route handler (unit + e2e)
 *   worker   — background job code
 *   config   — shared config / categories
 *   global   — auth, server, schema — run everything
 */

const path = require('path');
const PROJECT_DIR = path.resolve(__dirname, '..');

// Smoke endpoints: fast HTTP checks to verify the app didn't break
const SMOKE = {
    health:    'http://localhost:3001/health',
    login:     'http://localhost:3001/login',
    dashboard: 'http://localhost:3001/ar',
    directory: 'http://localhost:3001/ar/directory',
};

// All E2E specs (for global/regression runs)
const ALL_E2E = [
    'e2e/auth.spec.js',
    'e2e/navigation.spec.js',
    'e2e/dashboard.spec.js',
    'e2e/directory.spec.js',
    'e2e/filters-interaction.spec.js',
    'e2e/customer-details.spec.js',
    'e2e/upload.spec.js',
    'e2e/admin.spec.js',
    'e2e/key-accounts.spec.js',
    'e2e/sub-distributors.spec.js',
];

const ALL_UNIT = ['tests/routes/ar'];

// ── Impact rules ─────────────────────────────────────────────────────────────

/** Files whose change cascades to EVERYTHING */
const GLOBAL_FILES = new Set([
    'src/middleware/auth.js',
    'src/server.js',
    'src/prisma.js',
    'prisma/schema.prisma',
    'tests/setup.js',
    'src/routes/index.js',
]);

/**
 * Route files → { unitTests[], e2eSpecs[], smokeEndpoints[] }
 * Add new routes here when you create them.
 */
const ROUTE_MAP = {
    'src/routes/ar/customers.js': {
        unitTests:      ['tests/routes/ar/customers.test.js'],
        e2eSpecs:       ['e2e/customer-details.spec.js'],
        smokeEndpoints: [SMOKE.directory],
    },
    'src/routes/ar/directory.js': {
        unitTests:      ['tests/routes/ar/directory.test.js'],
        e2eSpecs:       ['e2e/directory.spec.js', 'e2e/filters-interaction.spec.js'],
        smokeEndpoints: [SMOKE.directory],
    },
    'src/routes/ar/invoices.js': {
        unitTests:      ['tests/routes/ar/invoices.test.js'],
        e2eSpecs:       ['e2e/directory.spec.js', 'e2e/customer-details.spec.js'],
        smokeEndpoints: [SMOKE.directory],
    },
    'src/routes/ar/dashboard.js': {
        unitTests:      ['tests/routes/ar/dashboard.test.js'],
        e2eSpecs:       ['e2e/dashboard.spec.js'],
        smokeEndpoints: [SMOKE.dashboard],
    },
    'src/routes/ar/upload.js': {
        unitTests:      ['tests/routes/ar/upload.test.js'],
        e2eSpecs:       ['e2e/upload.spec.js'],
        smokeEndpoints: [SMOKE.health],
    },
    'src/routes/ar/comments.js': {
        unitTests:      ['tests/routes/ar/comments.test.js'],
        e2eSpecs:       ['e2e/customer-details.spec.js'],
        smokeEndpoints: [SMOKE.directory],
    },
    'src/routes/ar/_shared.js': {
        unitTests:      ['tests/routes/ar/invoices.test.js', 'tests/routes/ar/directory.test.js'],
        e2eSpecs:       ['e2e/directory.spec.js', 'e2e/filters-interaction.spec.js'],
        smokeEndpoints: [SMOKE.directory],
    },
    'src/routes/admin.js': {
        unitTests:      [],
        e2eSpecs:       ['e2e/admin.spec.js', 'e2e/key-accounts.spec.js', 'e2e/sub-distributors.spec.js'],
        smokeEndpoints: [SMOKE.health],
    },
    'src/routes/assignments.js': {
        unitTests:      [],
        e2eSpecs:       ['e2e/directory.spec.js'],
        smokeEndpoints: [SMOKE.directory],
    },
    'src/routes/auth.js': {
        unitTests:      [],
        e2eSpecs:       ['e2e/auth.spec.js', 'e2e/navigation.spec.js'],
        smokeEndpoints: [SMOKE.login],
    },
    'src/worker.js': {
        unitTests:      ['tests/routes/ar/upload.test.js'],
        e2eSpecs:       ['e2e/upload.spec.js'],
        smokeEndpoints: [SMOKE.health],
    },
    'src/scheduler.js': {
        unitTests:      [],
        e2eSpecs:       ['e2e/upload.spec.js'],
        smokeEndpoints: [SMOKE.health],
    },
    'src/queue.js': {
        unitTests:      ['tests/routes/ar/upload.test.js'],
        e2eSpecs:       ['e2e/upload.spec.js'],
        smokeEndpoints: [SMOKE.health],
    },
    'src/config/categories.js': {
        unitTests:      ['tests/routes/ar/invoices.test.js', 'tests/routes/ar/directory.test.js'],
        e2eSpecs:       ['e2e/key-accounts.spec.js', 'e2e/directory.spec.js'],
        smokeEndpoints: [SMOKE.directory],
    },
};

/**
 * View / template files → e2eSpecs[]
 * Add new EJS views here when you create them.
 */
const VIEW_MAP = {
    'views/ar/directory.ejs':             ['e2e/directory.spec.js', 'e2e/filters-interaction.spec.js'],
    'views/ar/dashboard.ejs':             ['e2e/dashboard.spec.js'],
    'views/ar/customer_invoices.ejs':     ['e2e/customer-details.spec.js'],
    'views/ar/statement.ejs':             ['e2e/customer-details.spec.js'],
    'views/ar/upload.ejs':                ['e2e/upload.spec.js'],
    'views/ar/groups.ejs':                ['e2e/directory.spec.js'],
    'views/ar/assignments.ejs':           ['e2e/directory.spec.js'],
    'views/admin/key_accounts.ejs':       ['e2e/key-accounts.spec.js'],
    'views/admin/sub_distributors.ejs':   ['e2e/sub-distributors.spec.js'],
    'views/admin/users.ejs':              ['e2e/admin.spec.js'],
    'views/admin/categories.ejs':         ['e2e/admin.spec.js'],
    'views/admin/others.ejs':             ['e2e/admin.spec.js'],
    'views/admin/site_assignments.ejs':   ['e2e/admin.spec.js'],
    'views/admin/group_import.ejs':       ['e2e/admin.spec.js'],
    'views/admin/branding.ejs':           ['e2e/admin.spec.js'],
    // Shared partials — affect multiple pages
    'views/partials/table.ejs':           ['e2e/directory.spec.js', 'e2e/filters-interaction.spec.js', 'e2e/customer-details.spec.js'],
    'views/partials/layout_top.ejs':      ['e2e/auth.spec.js', 'e2e/navigation.spec.js', 'e2e/dashboard.spec.js', 'e2e/directory.spec.js'],
    'views/partials/layout_bottom.ejs':   ['e2e/navigation.spec.js'],
    'views/partials/comment_panel.ejs':   ['e2e/customer-details.spec.js'],
    'views/partials/invoice_details.ejs': ['e2e/customer-details.spec.js'],
};

// ── Main function ─────────────────────────────────────────────────────────────

function getImpactedTests(changedFile) {
    const rel = path.relative(PROJECT_DIR, path.resolve(changedFile)).replace(/\\/g, '/');

    // 1. Global files — run everything
    if (GLOBAL_FILES.has(rel)) {
        return {
            tier:           'global',
            reason:         `${rel} is a global dependency — running full suite`,
            unitTests:      ALL_UNIT,
            e2eSpecs:       ALL_E2E,
            smokeEndpoints: Object.values(SMOKE),
        };
    }

    // 2. Route / worker / config files
    if (ROUTE_MAP[rel]) {
        const tier = rel.startsWith('src/worker') || rel.startsWith('src/scheduler')  ? 'worker'
                   : rel.startsWith('src/config') || rel.startsWith('src/queue')      ? 'config'
                   : 'route';
        return { tier, reason: `Changed: ${rel}`, ...ROUTE_MAP[rel] };
    }

    // 3. EJS view / partial files
    if (VIEW_MAP[rel]) {
        const tier = rel.startsWith('views/partials/') ? 'partial' : 'view';
        return {
            tier,
            reason:         `Template changed: ${rel}`,
            unitTests:      [],
            e2eSpecs:       VIEW_MAP[rel],
            smokeEndpoints: [SMOKE.health, SMOKE.login],
        };
    }

    // 4. Test file changed — run that test file only + smoke
    if (rel.startsWith('tests/')) {
        return {
            tier:           'test',
            reason:         `Test file modified: ${rel}`,
            unitTests:      [rel],
            e2eSpecs:       ['e2e/auth.spec.js'],
            smokeEndpoints: [SMOKE.health],
        };
    }
    if (rel.startsWith('e2e/')) {
        return {
            tier:           'test',
            reason:         `E2E spec modified: ${rel}`,
            unitTests:      [],
            e2eSpecs:       [rel],
            smokeEndpoints: [SMOKE.health, SMOKE.login],
        };
    }

    // 5. Unknown — smoke only
    return {
        tier:           'unknown',
        reason:         `No impact rule for ${rel} — running smoke only`,
        unitTests:      [],
        e2eSpecs:       ['e2e/auth.spec.js', 'e2e/navigation.spec.js'],
        smokeEndpoints: [SMOKE.health, SMOKE.login],
    };
}

// CLI: node scripts/impact-map.js <file>
if (require.main === module) {
    const file = process.argv[2];
    if (!file) {
        console.error('Usage: node scripts/impact-map.js <changed-file-path>');
        process.exit(1);
    }
    const result = getImpactedTests(file);
    console.log(JSON.stringify(result, null, 2));
}

module.exports = { getImpactedTests };
