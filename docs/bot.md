# RampsmithBot

RampsmithBot is the automated accessibility checker behind Rampsmith. It loads storefront pages
in a headless Chromium browser and runs automated WCAG 2.2 checks on them. Automated checks find
only part of what affects people with disabilities; a page that passes them can still have
problems that need a person to judge.

## When it visits

- **Stores whose owners connected them to Rampsmith.** The owner installed the Shopify app or
  verified the site, and chose to scan it.
- **The free scanner.** Someone entered a store's address on the public scanner. It loads the
  home page and at most two linked pages, at most once per domain per day, and it honours
  `robots.txt`.
- **Research runs.** Before building on an assumption, the team occasionally loads the home page
  of a small set of public stores once, honouring `robots.txt`.

## How it behaves

- It identifies itself with a user agent that starts with `RampsmithBot/` and links here.
- At most one page per store is loading at a time, at no more than two requests per second; an
  HTTP 429 answer makes it back off.
- It never submits forms, adds to carts or checks out.
- It never solves or works around a CAPTCHA or bot challenge. A challenged page is reported to
  the person who asked for the scan as blocked.
- Its network traffic goes through a guard that only reaches public internet addresses.

## How to block it

Add a group for its product token to your `robots.txt`:

```
User-agent: RampsmithBot
Disallow: /
```

The free scanner and research runs then stop visiting. A store's owner who connected it to
Rampsmith controls scans from the app instead.

## Questions

Open an issue in this repository.
