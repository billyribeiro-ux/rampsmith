/* global document, HTMLFormElement, HTMLInputElement, HTMLTextAreaElement */
// Rampsmith barrier-report form: in-page sending, inline errors, a status line (ADR-162).
// The form works without it. Strings come from data-msg-*; no cookies, no storage.
(() => {
  const form = document.querySelector('form[data-rs-report]');
  if (!(form instanceof HTMLFormElement) || !('fetch' in globalThis)) return;

  /** @typedef {HTMLInputElement | HTMLTextAreaElement} Field */
  const status = form.querySelector('[data-rs-status]');
  const submit = form.querySelector('[type="submit"]');
  const started = Date.now();
  let busy = false;

  /** @param {string} key */
  const msg = (key) => form.getAttribute(`data-msg-${key}`) ?? '';

  /** @param {string} text */
  const say = (text) => {
    if (status) status.textContent = text;
  };

  /** @param {unknown} el @returns {el is Field} */
  const isField = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

  /** @returns {Field[]} */
  const fields = () => [...form.querySelectorAll('[data-rs-field]')].filter(isField);

  /** Shows the message `key` under `field`, or clears it when `key` is ''.
   * @param {Field} field @param {string} key */
  const mark = (field, key) => {
    const error = document.getElementById(`${field.id}-error`);
    if (key === '') field.removeAttribute('aria-invalid');
    else field.setAttribute('aria-invalid', 'true');
    if (error) error.textContent = key === '' ? '' : `${msg('error-prefix')} ${msg(key)}`;
  };

  /** The message key for the field's problem, or ''. @param {Field} field */
  const problem = (field) => {
    const value = field.value.trim();
    if (field.required && value === '') return `${field.name}-missing`;
    if (field.maxLength > 0 && field.value.length > field.maxLength)
      return `${field.name}-too-long`;
    if (value !== '' && field.validity.typeMismatch) return `${field.name}-invalid`;
    return '';
  };

  /** Marks each field from `keys` (name to message key); focuses the first problem.
   * @param {Map<string, string>} keys @returns {boolean} whether any field has a problem */
  const show = (keys) => {
    let first = null;
    for (const field of fields()) {
      const key = keys.get(field.name) ?? '';
      mark(field, key);
      if (key !== '' && first === null) first = field;
    }
    first?.focus();
    return first !== null;
  };

  /** @param {unknown} value @returns {Record<string, unknown>} */
  const record = (value) =>
    typeof value === 'object' && value !== null
      ? /** @type {Record<string, unknown>} */ (value)
      : {};

  /** A 400 answer's `errors: [{field, code}]` as message keys. @param {unknown} errors */
  const serverKeys = (errors) => {
    /** @type {Map<string, string>} */
    const keys = new Map();
    for (const item of Array.isArray(errors) ? errors : []) {
      const { field, code } = record(item);
      const key = `${String(field)}-${String(code)}`;
      if (typeof field === 'string' && msg(key) !== '') keys.set(field, key);
    }
    return keys;
  };

  const send = async () => {
    busy = true;
    submit?.setAttribute('aria-disabled', 'true');
    say(msg('sending'));
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(form)) {
      if (typeof value === 'string') body.append(name, value);
    }
    body.set('elapsed_ms', String(Date.now() - started));
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body,
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        signal: AbortSignal.timeout(15000),
      });
      const answer = record(await response.json().catch(() => null));
      if (response.ok && answer['status'] === 'received') {
        form.reset();
        show(new Map());
        say(msg('sent'));
      } else if (response.status === 429) {
        say(msg('rate-limited'));
      } else if (response.status === 400 && show(serverKeys(answer['errors']))) {
        say(msg('invalid'));
      } else {
        say(msg('failed'));
      }
    } catch {
      say(msg('failed'));
    } finally {
      busy = false;
      submit?.removeAttribute('aria-disabled');
    }
  };

  form.noValidate = true;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    /** @type {Map<string, string>} */
    const keys = new Map();
    for (const field of fields()) keys.set(field.name, problem(field));
    if (show(keys)) say('');
    else void send();
  });
  form.addEventListener('input', ({ target }) => {
    if (isField(target) && target.hasAttribute('aria-invalid') && problem(target) === '') {
      mark(target, '');
    }
  });
})();
