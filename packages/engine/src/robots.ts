/**
 * robots.txt as RFC 9309 defines it. The free scanner honours it for the Rampsmith user agent
 * (PLAN §16), and so do the spikes that load third-party stores (PLAN §11).
 */

interface Rule {
  readonly allow: boolean;
  readonly pattern: string;
  readonly regex: RegExp;
}

interface Group {
  readonly agents: string[];
  readonly rules: Rule[];
}

function compile(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export interface Robots {
  /** Whether `token` (a product token such as `RampsmithBot`) may fetch `path`. */
  allows(token: string, path: string): boolean;
}

/** Parses a robots.txt body. Malformed lines are ignored, as the RFC requires. */
export function parseRobots(text: string): Robots {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n|\r/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (current === undefined || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((field === 'allow' || field === 'disallow') && current !== undefined) {
      // An empty Disallow allows everything; an empty Allow says nothing.
      if (value === '') continue;
      current.rules.push({ allow: field === 'allow', pattern: value, regex: compile(value) });
    }
  }

  return {
    allows(token: string, path: string): boolean {
      const name = token.toLowerCase();
      let rules = groups.filter((g) => g.agents.includes(name)).flatMap((g) => g.rules);
      if (!groups.some((g) => g.agents.includes(name))) {
        rules = groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.rules);
      }
      let best: Rule | undefined;
      for (const rule of rules) {
        if (!rule.regex.test(path)) continue;
        if (
          best === undefined ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow)
        ) {
          best = rule;
        }
      }
      return best?.allow ?? true;
    },
  };
}

/** A fetched robots.txt, or `undefined` when the server could not be reached. */
export interface RobotsResponse {
  readonly status: number;
  readonly text: string;
}

/**
 * RFC 9309 §2.3.1: a 4xx answer means no rules apply; a 5xx answer or no answer means
 * the whole site is disallowed until robots.txt can be read. 429 is treated like a 5xx: the
 * server is asking crawlers to stay away.
 */
export function robotsAllows(
  response: RobotsResponse | undefined,
  token: string,
  path: string,
): boolean {
  if (response === undefined || response.status >= 500 || response.status === 429) return false;
  if (response.status >= 400) return true;
  return parseRobots(response.text).allows(token, path);
}
