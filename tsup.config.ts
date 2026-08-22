import { defineConfig } from 'tsup';

/**
 * One bundled file per entry, with every dependency inlined, so an install
 * of this package pulls nothing else down and the CLI starts without a
 * loader in front of it.
 *
 * Boundary: this builds the published artifact only. Development still runs
 * the TypeScript in `src/` directly through tsx, so an edit takes effect
 * without a build.
 */
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  bundle: true,
  // Nothing is left external: the point of bundling here is a package with
  // no runtime dependencies of its own.
  noExternal: [/.*/],
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: false,
  dts: false,
});
