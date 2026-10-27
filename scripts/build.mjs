import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
await rm('lib', { recursive: true, force: true });
await mkdir('lib', { recursive: true });
await build({
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
});
await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  loader: { '.css': 'text' },
  format: 'cjs',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
  banner: {
    js: 'window.__ModuleLoader__.load({id:"dsh-boss",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
  },
  footer: { js: 'return module.exports;}});' },
  sourcemap: true,
});
