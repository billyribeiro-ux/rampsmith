/**
 * The draft documents the site shows, taken from `docs/` when the app is built. They are
 * imported as text by Vite, so the running server needs no access to the repository, and parsed
 * once at start-up.
 */
import accessibility from '../../../../../docs/accessibility-statement.md?raw';
import dpa from '../../../../../docs/legal/data-processing-addendum.md?raw';
import privacy from '../../../../../docs/legal/privacy-policy.md?raw';
import terms from '../../../../../docs/legal/terms-of-service.md?raw';
import { parseMarkdown, plain, type Block } from './markdown.ts';

export interface DraftDocument {
  /** The document's own first heading. */
  readonly title: string;
  /** Everything from that heading on; a note above it (such as "Draft, not published") is dropped. */
  readonly blocks: readonly Block[];
  /** The second-level headings, for the table of contents. */
  readonly sections: readonly { readonly id: string; readonly title: string }[];
}

function toDocument(source: string): DraftDocument {
  const all = parseMarkdown(source);
  const start = all.findIndex((b) => b.kind === 'heading' && b.level === 1);
  const blocks = start < 0 ? all : all.slice(start);
  const first = blocks[0];
  return {
    title: first?.kind === 'heading' ? plain(first.children) : '',
    blocks,
    sections: blocks.flatMap((b) =>
      b.kind === 'heading' && b.level === 2 ? [{ id: b.id, title: plain(b.children) }] : [],
    ),
  };
}

export const privacyPolicy = toDocument(privacy);
export const termsOfService = toDocument(terms);
export const dataProcessingAddendum = toDocument(dpa);
export const accessibilityStatement = toDocument(accessibility);
