#!/usr/bin/env node
import { globSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import process from 'node:process';
import { checkPins, workspaceManifestGlobs } from './pins.ts';

const cwd = process.cwd();
const skipped = /(^|\/)(node_modules|target|\.svelte-kit|build|dist)(\/|$)/;

function files(patterns: string[]): string[] {
  return globSync(patterns, { cwd })
    .map((path) => path.split(sep).join('/'))
    .filter((path) => !skipped.test(path))
    .sort();
}

function read(path: string): string {
  return readFileSync(join(cwd, path), 'utf8');
}

const workspace = read('pnpm-workspace.yaml');
const problems = checkPins({
  mise: read('.mise.toml'),
  workspace,
  packages: files(workspaceManifestGlobs(workspace)).map((path) => ({
    path,
    json: JSON.parse(read(path)) as unknown,
  })),
  dockerfiles: files(['**/*.Dockerfile', '**/Dockerfile']).map((path) => ({
    path,
    text: read(path),
  })),
  workflows: files(['.github/workflows/*.yml', '.github/workflows/*.yaml']).map((path) => ({
    path,
    text: read(path),
  })),
});

if (problems.length === 0) {
  process.stdout.write('node-pins: every Node.js pin agrees with .mise.toml (ADR-029)\n');
} else {
  process.stdout.write(
    `${problems.join('\n')}\nnode-pins: ${String(problems.length)} disagreement(s)\n`,
  );
  process.exitCode = 1;
}
