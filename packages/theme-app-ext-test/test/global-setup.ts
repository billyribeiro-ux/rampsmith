// Unpacks Chromium once, before any worker starts, so parallel test files never race to
// extract the same binary; each file then launches its own browser from this path.
import type { TestProject } from 'vitest/node';
import { chromiumPath } from '../src/chromium.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    chromiumPath: string;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  project.provide('chromiumPath', await chromiumPath());
}
