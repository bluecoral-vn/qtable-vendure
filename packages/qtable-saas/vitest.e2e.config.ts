import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [
        // SWC required to support decorators used in QTablePlugin
        swc.vite({
            jsc: {
                transform: {
                    useDefineForClassFields: false,
                    legacyDecorator: true,
                    decoratorMetadata: true,
                },
            },
        }),
    ],
    test: {
        include: ['e2e/**/*.e2e-spec.ts'],
        testTimeout: 30_000,
        hookTimeout: 120_000,
        poolOptions: {
            forks: {
                singleFork: true,
            },
        },
    },
});
