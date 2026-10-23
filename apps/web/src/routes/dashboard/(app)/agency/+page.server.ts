import { fail } from '@sveltejs/kit';
import { API_URL } from '$app/env/private';
import { apiClient } from '#lib/server/api.ts';
import { SESSION_COOKIE } from '#lib/server/dashboard.ts';
import type { Actions, PageServerLoad } from './$types';

/** The api's problem codes the page tells apart; everything else is the generic message. */
type Failure = 'limit' | 'error';

function authorization(token: string | undefined): { authorization: string } {
  return { authorization: `Session ${token ?? ''}` };
}

function failureOf(status: number): Failure {
  return status === 429 ? 'limit' : 'error';
}

/** Organizations the user belongs to and the stores that approved a link to them. */
export const load: PageServerLoad = async ({ cookies }) => {
  const client = apiClient(API_URL);
  const headers = authorization(cookies.get(SESSION_COOKIE));
  const [organizations, stores] = await Promise.all([
    client.GET('/v1/agency/organizations', { headers }).catch(() => undefined),
    client.GET('/v1/agency/stores', { headers }).catch(() => undefined),
  ]);
  return {
    unavailable: organizations?.data === undefined || stores?.data === undefined,
    organizations: organizations?.data?.organizations ?? [],
    stores: stores?.data?.stores ?? [],
  };
};

function textOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export const actions: Actions = {
  createOrganization: async ({ request, cookies }) => {
    const name = textOf(await request.formData(), 'name').trim();
    const result = await apiClient(API_URL)
      .POST('/v1/agency/organizations', {
        headers: authorization(cookies.get(SESSION_COOKIE)),
        body: { name },
      })
      .catch(() => undefined);
    if (result?.data === undefined) {
      return fail(result?.response.status === 422 ? 422 : 400, {
        failure: 'error',
        name,
      });
    }
    return { created: result.data.name };
  },
  createCode: async ({ request, cookies }) => {
    const organization = textOf(await request.formData(), 'organization');
    const result = await apiClient(API_URL)
      .POST('/v1/agency/organizations/{organization_id}/link-codes', {
        headers: authorization(cookies.get(SESSION_COOKIE)),
        params: { path: { organization_id: organization } },
      })
      .catch(() => undefined);
    if (result?.data === undefined) {
      return fail(400, { failure: failureOf(result?.response.status ?? 0) });
    }
    return {
      code: result.data.code,
      expires_at: result.data.expires_at,
      organization,
    };
  },
  unlink: async ({ request, cookies }) => {
    const link = textOf(await request.formData(), 'link');
    const result = await apiClient(API_URL)
      .DELETE('/v1/agency/links/{link_id}', {
        headers: authorization(cookies.get(SESSION_COOKIE)),
        params: { path: { link_id: link } },
      })
      .catch(() => undefined);
    if (!result?.response.ok) {
      return fail(400, { failure: 'error' });
    }
    return { unlinked: true };
  },
};
