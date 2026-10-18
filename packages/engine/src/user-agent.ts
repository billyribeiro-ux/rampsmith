/**
 * The scanner's user agent (PLAN §11): it names Rampsmith and links to a page that explains
 * the bot and how to block it. `BOT_TOKEN` is the product token robots.txt groups match.
 */
export const BOT_TOKEN = 'RampsmithBot';

/** Where the bot is explained until the product site has its own page. */
export const DEFAULT_BOT_INFO_URL =
  'https://github.com/billyribeiro-ux/rampsmith/blob/main/docs/bot.md';

export function userAgent(version: string, infoUrl: string = DEFAULT_BOT_INFO_URL): string {
  return `${BOT_TOKEN}/${version} (+${infoUrl}; accessibility scanner)`;
}
