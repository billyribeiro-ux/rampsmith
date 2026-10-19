import { describe, expect, it } from 'vitest';
import { checkPins, miseNodeVersion, workspaceManifestGlobs, type PinInputs } from '../src/pins.ts';

const MISE = `min_version = "2026.10.12"\n\n[tools]\nnode = "26.12.0"\npnpm = "12.14.0"\n`;
const WORKSPACE = 'packages:\n  - apps/*\nsaveExact: true\nengineStrict: true\n';
const ENGINES = { node: '>=26.12.0 <27' };
const GOOD_JOB = `jobs:
  node:
    runs-on: ubuntu-24.04
    steps:
      - uses: jdx/mise-action@9b200bcecbfd6303e69a4a261b2e09e3757440a7 # v5.2.0
        with:
          install_args: node pnpm
      - name: Node version (ADR-029)
        run: |
          node --version
          node -p 'process.release.lts ?? "not an LTS release"'
  rust:
    runs-on: ubuntu-24.04
    steps:
      - run: cargo test
`;

function inputs(overrides: Partial<PinInputs> = {}): PinInputs {
  return {
    mise: MISE,
    workspace: WORKSPACE,
    packages: [
      {
        path: 'package.json',
        json: { engines: ENGINES, devDependencies: { '@types/node': '26.6.5' } },
      },
      { path: 'apps/web/package.json', json: { engines: ENGINES } },
    ],
    dockerfiles: [
      {
        path: 'infra/web.Dockerfile',
        text: `# node:26.12.0-trixie-slim\nFROM node:26.12.0-trixie-slim@sha256:${'a'.repeat(64)} AS build\nFROM debian:trixie-slim@sha256:${'b'.repeat(64)}\n`,
      },
    ],
    workflows: [{ path: '.github/workflows/ci.yml', text: GOOD_JOB }],
    ...overrides,
  };
}

describe('miseNodeVersion', () => {
  it('reads the node pin from the [tools] table', () => {
    expect(miseNodeVersion(MISE)).toBe('26.12.0');
  });

  it('ignores a node key outside [tools]', () => {
    expect(miseNodeVersion('[env]\nnode = "1.0.0"\n[tools]\npnpm = "12.14.0"\n')).toBeNull();
  });
});

describe('workspaceManifestGlobs', () => {
  it('lists the root manifest and one per workspace glob', () => {
    const yaml =
      "packages:\n  - apps/*\n  - 'packages/*/'\n  - '!packages/skip'\n\nsaveExact: true\n";
    expect(workspaceManifestGlobs(yaml)).toEqual([
      'package.json',
      'apps/*/package.json',
      'packages/*/package.json',
    ]);
  });
});

describe('checkPins', () => {
  it('accepts a tree where every pin agrees', () => {
    expect(checkPins(inputs())).toEqual([]);
  });

  it('requires an exact 26.x pin in .mise.toml', () => {
    expect(checkPins(inputs({ mise: '[tools]\nnode = "26"\n' }))).toEqual([
      '.mise.toml: node must be an exact 26.x.y version (ADR-029), found "26"',
    ]);
    expect(checkPins(inputs({ mise: '[tools]\nnode = "24.22.0"\n' }))[0]).toMatch(
      /exact 26\.x\.y version/,
    );
    expect(checkPins(inputs({ mise: '[tools]\npnpm = "12.14.0"\n' }))).toEqual([
      '.mise.toml: [tools] has no node pin (ADR-029)',
    ]);
  });

  it('requires engines.node in every package.json to match the pin', () => {
    const problems = checkPins(
      inputs({
        packages: [
          { path: 'package.json', json: { engines: { node: '>=26.0.0 <27' } } },
          { path: 'packages/ui/package.json', json: {} },
        ],
      }),
    );
    expect(problems).toEqual([
      'package.json: engines.node must be ">=26.12.0 <27", found ">=26.0.0 <27"',
      'packages/ui/package.json: engines.node must be ">=26.12.0 <27", found nothing',
    ]);
  });

  it('requires @types/node to be an exact 26.x version wherever it is declared', () => {
    const problems = checkPins(
      inputs({
        packages: [
          {
            path: 'package.json',
            json: { engines: ENGINES, devDependencies: { '@types/node': '^24.1.0' } },
          },
          {
            path: 'apps/web/package.json',
            json: { engines: ENGINES, dependencies: { '@types/node': '26.6.5' } },
          },
        ],
      }),
    );
    expect(problems).toEqual([
      'package.json: @types/node must be an exact 26.x.y version, found "^24.1.0"',
    ]);
  });

  it('requires engineStrict in pnpm-workspace.yaml', () => {
    expect(checkPins(inputs({ workspace: 'packages:\n  - apps/*\n' }))).toEqual([
      'pnpm-workspace.yaml: engineStrict must be true, or pnpm installs on any Node (ADR-029)',
    ]);
  });

  it('requires Node base images on the pinned trixie-slim tag and a digest', () => {
    const problems = checkPins(
      inputs({
        dockerfiles: [
          { path: 'infra/engine.Dockerfile', text: 'FROM node:26.12.0-trixie-slim AS build\n' },
          {
            path: 'infra/web.Dockerfile',
            text: `FROM node:26.11.0-trixie-slim@sha256:${'c'.repeat(64)}\n`,
          },
          {
            path: 'infra/x.Dockerfile',
            text: `from --platform=linux/amd64 node:26-slim@sha256:${'d'.repeat(64)}\n`,
          },
        ],
      }),
    );
    expect(problems).toEqual([
      'infra/engine.Dockerfile:1: Node images must be node:26.12.0-trixie-slim@sha256:<digest>, found "node:26.12.0-trixie-slim"',
      `infra/web.Dockerfile:1: Node images must be node:26.12.0-trixie-slim@sha256:<digest>, found "node:26.11.0-trixie-slim@sha256:${'c'.repeat(64)}"`,
      `infra/x.Dockerfile:1: Node images must be node:26.12.0-trixie-slim@sha256:<digest>, found "node:26-slim@sha256:${'d'.repeat(64)}"`,
    ]);
  });

  it('rejects setup-node and node-version in workflows', () => {
    const text = `jobs:\n  a:\n    steps:\n      - uses: actions/setup-node@0000000000000000000000000000000000000000\n        with:\n          node-version: 26\n`;
    expect(checkPins(inputs({ workflows: [{ path: '.github/workflows/x.yml', text }] }))).toEqual([
      '.github/workflows/x.yml:4: install Node with mise from .mise.toml, not actions/setup-node',
      '.github/workflows/x.yml:6: install Node with mise from .mise.toml, not node-version',
    ]);
  });

  it('requires every job that installs Node to log its version and LTS name', () => {
    const text = `jobs:
  e2e:
    steps:
      - uses: jdx/mise-action@9b200bcecbfd6303e69a4a261b2e09e3757440a7 # v5.2.0
        with:
          install_args: node pnpm
      - run: node --version
  contracts:
    steps:
      - uses: jdx/mise-action@9b200bcecbfd6303e69a4a261b2e09e3757440a7 # v5.2.0
        with:
          install_args: pnpm
`;
    expect(checkPins(inputs({ workflows: [{ path: '.github/workflows/ci.yml', text }] }))).toEqual([
      '.github/workflows/ci.yml: job "e2e" installs Node but does not log process.release.lts (ADR-029)',
    ]);
  });
});
