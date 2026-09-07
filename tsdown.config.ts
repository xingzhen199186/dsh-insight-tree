import { defineConfig } from 'tsdown'

export default defineConfig([
  { entry: { index: 'src/index.ts' }, format: ['esm'], dts: true, outDir: 'lib', outExtensions: () => ({ js: '.js' }) },
  { entry: { client: 'src/client/index.tsx' }, format: ['cjs'], dts: false, outDir: 'lib', outExtensions: () => ({ js: '.cjs' }) },
])
