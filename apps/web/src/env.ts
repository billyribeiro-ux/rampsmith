// Environment variables for the web app (SvelteKit 3: `$app/env/*`, PLAN §22).
import { building } from '$app/env';
import { defineEnvVars } from '@sveltejs/kit/env';

const required = (name: string) => (value: string | undefined) => {
  if (building) return value ?? '';
  if (value === undefined || value.trim() === '') throw new Error(`${name} must be set`);
  return value.trim();
};

export const variables = defineEnvVars({
  API_URL: {
    description:
      "The api's base URL on the private network, such as http://api.railway.internal:8080",
    schema: required('API_URL'),
  },
  SHOPIFY_API_KEY: {
    description: "The Shopify app's public client id, rendered for App Bridge",
    public: true,
    schema: required('SHOPIFY_API_KEY'),
  },
  SERVICE_VERSION: {
    description: 'Reported as service.version, normally the image commit',
    schema: (value: string | undefined) => value ?? '0.0.0',
  },
});
