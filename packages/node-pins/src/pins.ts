/**
 * The Node.js pin rules of ADR-029: one exact 26.x version, taken from `.mise.toml`, used by
 * every `package.json`, every Node base image and every CI job. Pure functions over file
 * contents, so the rules are tested without a repository.
 */

interface PackageFile {
  readonly path: string;
  readonly json: unknown;
}

interface TextFile {
  readonly path: string;
  readonly text: string;
}

export interface PinInputs {
  /** Contents of `.mise.toml`. */
  readonly mise: string;
  /** Contents of `pnpm-workspace.yaml`. */
  readonly workspace: string;
  readonly packages: readonly PackageFile[];
  readonly dockerfiles: readonly TextFile[];
  readonly workflows: readonly TextFile[];
}

const EXACT_26 = /^26\.\d+\.\d+$/;
const MAJOR = 26;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `node` pin in the `[tools]` table of `.mise.toml`, or null when it has none. */
export function miseNodeVersion(mise: string): string | null {
  let inTools = false;
  for (const raw of mise.split('\n')) {
    const line = raw.trim();
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      inTools = table[1] === 'tools';
      continue;
    }
    if (!inTools) {
      continue;
    }
    const pin = /^node\s*=\s*"([^"]*)"/.exec(line);
    if (pin) {
      return pin[1] ?? null;
    }
  }
  return null;
}

/**
 * The `package.json` globs of the pnpm workspace: the root plus each `packages:` entry, so
 * generated or vendored manifests outside the workspace are never checked.
 */
export function workspaceManifestGlobs(workspace: string): string[] {
  const globs = ['package.json'];
  let inPackages = false;
  for (const raw of workspace.split('\n')) {
    if (/^packages:\s*$/.test(raw)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const entry = /^\s+-\s+['"]?([^'"#\s]+)['"]?/.exec(raw);
    if (entry?.[1] !== undefined) {
      if (!entry[1].startsWith('!')) {
        globs.push(`${entry[1].replace(/\/+$/, '')}/package.json`);
      }
      continue;
    }
    if (/^\S/.test(raw)) {
      inPackages = false;
    }
  }
  return globs;
}

function checkPackage(file: PackageFile, engines: string): string[] {
  const problems: string[] = [];
  const json = isRecord(file.json) ? file.json : {};
  const declared = isRecord(json['engines']) ? json['engines']['node'] : undefined;
  if (declared !== engines) {
    const found = typeof declared === 'string' ? `"${declared}"` : 'nothing';
    problems.push(`${file.path}: engines.node must be "${engines}", found ${found}`);
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = json[field];
    if (!isRecord(deps)) {
      continue;
    }
    const types = deps['@types/node'];
    if (types !== undefined && !(typeof types === 'string' && EXACT_26.test(types))) {
      problems.push(
        `${file.path}: @types/node must be an exact ${String(MAJOR)}.x.y version, found ${JSON.stringify(types)}`,
      );
    }
  }
  return problems;
}

function checkDockerfile(file: TextFile, version: string): string[] {
  const problems: string[] = [];
  const wanted = new RegExp(
    `^node:${version.replaceAll('.', '\\.')}-trixie-slim@sha256:[0-9a-f]{64}$`,
  );
  file.text.split('\n').forEach((raw, index) => {
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i.exec(raw);
    const image = from?.[1];
    if (image === undefined || !/^(?:docker\.io\/)?(?:library\/)?node[:@]/.test(image)) {
      return;
    }
    if (!wanted.test(image)) {
      problems.push(
        `${file.path}:${String(index + 1)}: Node images must be node:${version}-trixie-slim@sha256:<digest>, found "${image}"`,
      );
    }
  });
  return problems;
}

interface Job {
  readonly name: string;
  readonly text: string;
}

/** Splits a workflow into its jobs by indentation, without a YAML parser. */
function jobsOf(text: string): Job[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start === -1) {
    return [];
  }
  const jobs: { name: string; lines: string[] }[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header?.[1] !== undefined) {
      jobs.push({ name: header[1], lines: [] });
      continue;
    }
    jobs.at(-1)?.lines.push(line);
  }
  return jobs.map((job) => ({ name: job.name, text: job.lines.join('\n') }));
}

function checkWorkflow(file: TextFile): string[] {
  const problems: string[] = [];
  file.text.split('\n').forEach((line, index) => {
    const where = `${file.path}:${String(index + 1)}`;
    if (/uses:\s*actions\/setup-node@/.test(line)) {
      problems.push(`${where}: install Node with mise from .mise.toml, not actions/setup-node`);
    }
    if (/^\s*node-version(?:-file)?:/.test(line)) {
      problems.push(`${where}: install Node with mise from .mise.toml, not node-version`);
    }
  });
  for (const job of jobsOf(file.text)) {
    if (!/install_args:.*\bnode\b/.test(job.text)) {
      continue;
    }
    if (!job.text.includes('node --version') || !job.text.includes('process.release.lts')) {
      problems.push(
        `${file.path}: job "${job.name}" installs Node but does not log process.release.lts (ADR-029)`,
      );
    }
  }
  return problems;
}

/** Every disagreement with ADR-029, as one human-readable line each; empty when all agree. */
export function checkPins(inputs: PinInputs): string[] {
  const version = miseNodeVersion(inputs.mise);
  if (version === null) {
    return ['.mise.toml: [tools] has no node pin (ADR-029)'];
  }
  if (!EXACT_26.test(version)) {
    return [
      `.mise.toml: node must be an exact ${String(MAJOR)}.x.y version (ADR-029), found "${version}"`,
    ];
  }
  const engines = `>=${version} <${String(MAJOR + 1)}`;
  const problems: string[] = [];
  for (const file of inputs.packages) {
    problems.push(...checkPackage(file, engines));
  }
  if (!/^engineStrict:\s*true\s*$/m.test(inputs.workspace)) {
    problems.push(
      'pnpm-workspace.yaml: engineStrict must be true, or pnpm installs on any Node (ADR-029)',
    );
  }
  for (const file of inputs.dockerfiles) {
    problems.push(...checkDockerfile(file, version));
  }
  for (const file of inputs.workflows) {
    problems.push(...checkWorkflow(file));
  }
  return problems;
}
