import { changeFromForm, loadLink } from '#lib/server/email-link-route.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => loadLink(event);

export const actions: Actions = {
  default: (event) => changeFromForm(event),
};
