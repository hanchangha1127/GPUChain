// Run from the Site source checkout. Dependencies are required only when bundling the Site.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sourceCrypto = resolve(here, '../../src/crypto.mjs');

await build({
  entryPoints:[resolve(here, 'worker.mjs')],
  outfile:resolve('dist/server/index.js'),
  format:'esm',
  platform:'browser',
  target:'es2022',
  bundle:true,
  minify:true,
  legalComments:'inline',
  plugins:[{
    name:'worker-crypto',
    setup(builder) {
      builder.onResolve({filter:/crypto\.mjs$/}, args => {
        if (resolve(args.resolveDir, args.path) === sourceCrypto) return {path:resolve(here, 'worker-crypto.mjs')};
      });
      builder.onResolve({filter:/^node:crypto$/}, () => ({path:'uuid', namespace:'worker-native'}));
      builder.onLoad({filter:/.*/, namespace:'worker-native'}, () => ({
        contents:'export function randomUUID() { return globalThis.crypto.randomUUID(); }',
        loader:'js'
      }));
    }
  }]
});
