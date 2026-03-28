const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = [
    js.configs.recommended,
    prettier,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-console': 'warn',
            'eqeqeq': ['error', 'always', { null: 'ignore' }],
        },
    },
    {
        files: ['tests/**/*.js', 'e2e/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.jest,
            },
        },
        rules: {
            'no-console': 'off',
        },
    },
    {
        ignores: ['node_modules/', 'coverage/', 'uploads/', 'public/'],
    },
];
