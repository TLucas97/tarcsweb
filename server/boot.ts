import { enableCompileCache } from 'node:module';
import { join } from 'node:path';

// Imports are hoisted, so the cache must be on before index.ts and its graph load.
const { CACHE_DIR } = await import('./config.ts');
enableCompileCache(join(CACHE_DIR, 'v8'));
await import('./index.ts');
