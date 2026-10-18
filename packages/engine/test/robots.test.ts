import { describe, expect, it } from 'vitest';
import { parseRobots, robotsAllows } from '../src/robots.ts';

const BOT = 'RampsmithBot';

function allows(text: string, path: string, token = BOT): boolean {
  return parseRobots(text).allows(token, path);
}

describe('robots.txt (RFC 9309)', () => {
  it('allows everything when the file is empty or has no matching group', () => {
    expect(allows('', '/')).toBe(true);
    expect(allows('User-agent: OtherBot\nDisallow: /', '/')).toBe(true);
  });

  it('applies the * group when no group names the bot', () => {
    expect(allows('User-agent: *\nDisallow: /', '/')).toBe(false);
    expect(allows('User-agent: *\nDisallow:', '/')).toBe(true);
  });

  it('prefers the group that names the bot, matched case-insensitively', () => {
    const text = 'User-agent: *\nDisallow: /\n\nUser-agent: rampsmithbot\nAllow: /';
    expect(allows(text, '/')).toBe(true);
    expect(allows(text, '/', 'SomeoneElse')).toBe(false);
  });

  it('merges groups for the same agent and groups listing several agents', () => {
    const text = [
      'User-agent: RampsmithBot',
      'Disallow: /a',
      '',
      'User-agent: Googlebot',
      'User-agent: RampsmithBot',
      'Disallow: /b',
    ].join('\n');
    expect(allows(text, '/a')).toBe(false);
    expect(allows(text, '/b')).toBe(false);
    expect(allows(text, '/c')).toBe(true);
  });

  it('lets the longest matching rule win, and allow win a tie', () => {
    const text =
      'User-agent: *\nDisallow: /products\nAllow: /products/public\nAllow: /x\nDisallow: /x';
    expect(allows(text, '/products/a')).toBe(false);
    expect(allows(text, '/products/public/a')).toBe(true);
    expect(allows(text, '/x')).toBe(true);
  });

  it('supports * wildcards and the $ end anchor', () => {
    const text = 'User-agent: *\nDisallow: /*.json$\nDisallow: /search*q=';
    expect(allows(text, '/a.json')).toBe(false);
    expect(allows(text, '/a.json?x=1')).toBe(true);
    expect(allows(text, '/search?q=scarf')).toBe(false);
    expect(allows(text, '/searching')).toBe(true);
  });

  it('ignores comments, unknown fields and rules before any user-agent line', () => {
    const text = [
      'Disallow: /',
      '# we use Shopify as our ecommerce platform',
      'User-agent: * # everyone',
      'Crawl-delay: 10',
      'Sitemap: https://shop.example/sitemap.xml',
      'Disallow: /cart # carts',
    ].join('\n');
    expect(allows(text, '/')).toBe(true);
    expect(allows(text, '/cart')).toBe(false);
  });

  it("allows the home page under Shopify's default rules", () => {
    const text = [
      'User-agent: *',
      'Disallow: /a/downloads/-/*',
      'Disallow: /admin',
      'Disallow: /cart',
      'Disallow: /orders',
      'Disallow: /checkouts/',
      'Disallow: /checkout',
      'Disallow: /*?*oseid=*',
      'Disallow: /*preview_theme_id*',
      'Disallow: /policies/',
      'Disallow: /search',
      'Disallow: /collections/*sort_by*',
    ].join('\n');
    expect(allows(text, '/')).toBe(true);
    expect(allows(text, '/products/scarf')).toBe(true);
    expect(allows(text, '/checkout')).toBe(false);
    expect(allows(text, '/?preview_theme_id=1')).toBe(false);
  });

  it('decides from the HTTP status first: 4xx allows; 429, 5xx or no answer disallows', () => {
    expect(robotsAllows({ status: 404, text: '' }, BOT, '/')).toBe(true);
    expect(robotsAllows({ status: 403, text: 'User-agent: *\nDisallow: /' }, BOT, '/')).toBe(true);
    expect(robotsAllows({ status: 503, text: '' }, BOT, '/')).toBe(false);
    // Rate limiting is a server asking us to stay away, not a missing file (S-2 saw one).
    expect(robotsAllows({ status: 429, text: '' }, BOT, '/')).toBe(false);
    expect(robotsAllows(undefined, BOT, '/')).toBe(false);
    expect(robotsAllows({ status: 200, text: 'User-agent: *\nDisallow: /' }, BOT, '/')).toBe(false);
  });
});
