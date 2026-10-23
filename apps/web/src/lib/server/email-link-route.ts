/**
 * The load function and form action both email-link pages share (ADR-274). The page works
 * without JavaScript: the form posts to the page's own address, and the answer comes back as
 * the page.
 */
import { fail, type RequestEvent } from '@sveltejs/kit';
import { API_URL } from '$app/env/private';
import { apiClient } from '#lib/server/api.ts';
import { categoryOf, changeLink, inspectLink, type LinkView } from '#lib/server/email-link.ts';

export interface LinkPageData {
  readonly view: LinkView;
  /** Echoed into the forms; it is the page's own address, not a new secret. */
  readonly token: string;
}

type Event = Pick<RequestEvent, 'url' | 'request'>;

export async function loadLink({ url }: Event): Promise<LinkPageData> {
  const token = url.searchParams.get('t') ?? '';
  return { view: await inspectLink(apiClient(API_URL), token), token };
}

export interface LinkFormData {
  readonly view: LinkView;
  /** What was just done, so the page can say so. */
  readonly changed?: { readonly category: 'notification' | 'marketing'; readonly enabled: boolean };
}

export async function changeFromForm({ request }: Event) {
  const form = await request.formData();
  const category = categoryOf(form.get('category'));
  const enabled = form.get('enabled');
  if (category === undefined || (enabled !== 'true' && enabled !== 'false')) {
    return fail(400, { view: { status: 'invalid' } } satisfies LinkFormData);
  }
  const view = await changeLink(
    apiClient(API_URL),
    form.get('token'),
    category,
    enabled === 'true',
  );
  if (view.status === 'unavailable') {
    return fail(503, { view } satisfies LinkFormData);
  }
  return { view, changed: { category, enabled: enabled === 'true' } } satisfies LinkFormData;
}
