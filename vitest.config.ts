import { defineConfig } from 'vitest/config';

// The back end's own tests. The front end is its own project with its own test run.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
