// Which Chromium the browser tests launch. @sparticuz/chromium's build is the one
// docs/ENVIRONMENT.md verifies here and the only one ci.yml's node job can reach without a
// browser download. CHROMIUM_EXECUTABLE_PATH (and CHROMIUM_ARGS, a JSON array) select another
// build; only the test harness reads them.

/** Path of the Chromium binary: CHROMIUM_EXECUTABLE_PATH, or @sparticuz/chromium's build. */
export async function chromiumPath(): Promise<string> {
  const override = process.env['CHROMIUM_EXECUTABLE_PATH'];
  if (override !== undefined && override !== '') return override;
  const { default: sparticuz } = await import('@sparticuz/chromium');
  return sparticuz.executablePath();
}

/** Extra switches from CHROMIUM_ARGS. */
export function extraArgs(): string[] {
  const raw = process.env['CHROMIUM_ARGS'];
  if (raw === undefined || raw.trim() === '') return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((a): a is string => typeof a === 'string')) {
    throw new Error('CHROMIUM_ARGS must be a JSON array of strings');
  }
  return parsed;
}
