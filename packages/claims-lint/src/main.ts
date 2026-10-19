#!/usr/bin/env node
import process from 'node:process';
import { run } from './cli.ts';

const result = run({ cwd: process.cwd(), githubActions: process.env['GITHUB_ACTIONS'] === 'true' });
process.stdout.write(`${result.output.join('\n')}\n`);
process.exitCode = result.exitCode;
