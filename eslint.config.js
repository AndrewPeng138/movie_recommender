/**
 * ESLint flat config (ESLint 10).
 *
 * The project has two distinct JS environments that need different globals, so they get separate
 * config blocks:
 *
 *   1. `server.js`        — Node / CommonJS (require, module, process, __dirname)
 *   2. `public/index.html` — browser (window, document, fetch, console)
 *
 * The frontend JS currently lives inline in a <script> tag inside index.html, which ESLint cannot
 * read on its own. `eslint-plugin-html` extracts <script> contents and lints them as JS. Once the
 * frontend is split into public/app.js (planned in Phase 6), the plugin can be dropped and the
 * `files` glob changed to 'public/  *.js'.
 *
 * @see https://eslint.org/docs/latest/use/configure/configuration-files
 */

const html = require('eslint-plugin-html');

module.exports = [
    // Never lint dependencies or generated data.
    {
        ignores: ['node_modules/**', 'data/**'],
    },

    // ---------------------------------------------------------------------------------------------
    // Backend: Node + CommonJS
    // ---------------------------------------------------------------------------------------------
    {
        files: ['server.js', 'lib/**/*.js', 'scripts/**/*.js', 'eval/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly',
                module: 'writable',
                process: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                console: 'readonly',
                // Node 18+ exposes fetch globally; the node-fetch dependency was dropped in Phase 1.
                fetch: 'readonly',
                URL: 'readonly',
                URLSearchParams: 'readonly',
                Buffer: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
            },
        },
        rules: {
            // Correctness — these catch real bugs, so they are errors.
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'no-undef': 'error',
            'no-unreachable': 'error',
            'no-dupe-keys': 'error',
            'no-dupe-args': 'error',
            'no-const-assign': 'error',
            'no-constant-condition': 'error',

            // Async correctness. The recommendation pipeline is async-heavy and these are exactly
            // the mistakes that produce silent wrong results rather than crashes.
            'require-atomic-updates': 'error',
            'no-async-promise-executor': 'error',
            'no-await-in-loop': 'warn',

            // Style / hygiene — warnings, so they never block a run.
            eqeqeq: ['warn', 'smart'],
            'prefer-const': 'warn',
            'no-var': 'warn',
        },
    },

    // ---------------------------------------------------------------------------------------------
    // Frontend: browser globals, extracted from inline <script> blocks
    // ---------------------------------------------------------------------------------------------
    {
        files: ['public/**/*.html', 'public/**/*.js'],
        plugins: { html },
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'script',
            globals: {
                window: 'readonly',
                document: 'readonly',
                console: 'readonly',
                fetch: 'readonly',
                localStorage: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                AbortController: 'readonly',
                Map: 'readonly',
                Set: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'no-undef': 'error',
            'no-unreachable': 'error',
            'no-dupe-keys': 'error',

            'require-atomic-updates': 'error',
            'no-await-in-loop': 'warn',

            eqeqeq: ['warn', 'smart'],
            'prefer-const': 'warn',
            'no-var': 'warn',
        },
    },
];
