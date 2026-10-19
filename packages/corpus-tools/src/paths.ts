import { join } from 'node:path';

/** The corpus directory at the repository root (`corpus/`). */
export const CORPUS_ROOT = join(import.meta.dirname, '..', '..', '..', 'corpus');
