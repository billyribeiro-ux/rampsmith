<script lang="ts">
  // APG editable Combobox with list autocomplete: typing filters the options; Down opens the
  // list and moves through it, Up moves back (both wrap), Enter chooses the active option,
  // Escape closes the list or, when closed, clears the input. The active option is conveyed
  // with aria-activedescendant, so focus stays in the input.
  import { untrack } from 'svelte';

  interface Option {
    value: string;
    label: string;
  }
  interface Props {
    label: string;
    options: readonly Option[];
    value?: string | undefined;
    /** Announced when nothing matches, e.g. "No matches". */
    noResults: string;
    /** Announces how many options match, e.g. (n) => `${n} results`. */
    results: (count: number) => string;
    name?: string;
  }

  let { label, options, value = $bindable(), noResults, results, name }: Props = $props();

  const id = $props.id();
  // The input starts from the chosen option; afterwards the user's typing owns it.
  let text = $state(untrack(() => options.find((o) => o.value === value)?.label ?? ''));
  let open = $state(false);
  let active = $state(-1);

  const matches = $derived(
    options.filter((o) => o.label.toLowerCase().includes(text.trim().toLowerCase())),
  );
  const expanded = $derived(open && matches.length > 0);
  const status = $derived(open ? (matches.length === 0 ? noResults : results(matches.length)) : '');

  function choose(option: Option) {
    value = option.value;
    text = option.label;
    open = false;
    active = -1;
  }

  function step(delta: number) {
    if (matches.length === 0) return;
    if (!open) {
      open = true;
      active = delta > 0 ? 0 : matches.length - 1;
      return;
    }
    active = (active + delta + matches.length) % matches.length;
  }

  function keydown(event: KeyboardEvent) {
    switch (event.key) {
      case 'ArrowDown':
        if (event.altKey) open = true;
        else step(1);
        break;
      case 'ArrowUp':
        step(-1);
        break;
      case 'Enter': {
        const option = expanded ? matches[active] : undefined;
        if (option === undefined) return;
        choose(option);
        break;
      }
      case 'Escape':
        if (open) {
          open = false;
          active = -1;
        } else {
          text = '';
          value = undefined;
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  }
</script>

<div class="rs-combobox">
  <label id={`${id}-label`} for={`${id}-input`}>{label}</label>
  <input
    id={`${id}-input`}
    type="text"
    role="combobox"
    autocomplete="off"
    aria-autocomplete="list"
    aria-expanded={expanded}
    aria-controls={`${id}-listbox`}
    aria-activedescendant={expanded && active >= 0
      ? `${id}-option-${active.toString()}`
      : undefined}
    {name}
    bind:value={text}
    oninput={() => {
      open = true;
      active = -1;
      value = undefined;
    }}
    onkeydown={keydown}
    onblur={() => {
      open = false;
      active = -1;
    }}
  />
  <ul
    id={`${id}-listbox`}
    role="listbox"
    aria-labelledby={`${id}-label`}
    class="rs-listbox"
    hidden={!expanded}
  >
    {#each matches as option, i (option.value)}
      <!-- Pointer only: the keyboard path is the input's arrow keys. -->
      <li
        id={`${id}-option-${i.toString()}`}
        role="option"
        class="rs-option"
        aria-selected={i === active}
        onpointerdown={(event) => {
          event.preventDefault();
          choose(option);
        }}
      >
        {option.label}
      </li>
    {/each}
  </ul>
  <div class="rs-visually-hidden" role="status">{status}</div>
</div>

<style>
  .rs-combobox {
    position: relative;
    display: grid;
    gap: var(--rs-space-1);
    max-width: 24rem;
  }
  label {
    font-weight: 600;
  }
  input {
    min-height: var(--rs-target);
    padding: 0 var(--rs-space-3);
    border: 1px solid var(--rs-color-border);
    border-radius: var(--rs-radius);
    font: inherit;
    color: var(--rs-color-text);
    background: var(--rs-color-surface);
  }
  .rs-listbox {
    position: absolute;
    top: 100%;
    z-index: 10;
    width: 100%;
    max-height: 16rem;
    margin: var(--rs-space-1) 0 0;
    padding: var(--rs-space-1) 0;
    overflow-y: auto;
    list-style: none;
    border: 1px solid var(--rs-color-border);
    border-radius: var(--rs-radius);
    background: var(--rs-color-surface);
    box-shadow: var(--rs-shadow);
  }
  .rs-option {
    display: flex;
    align-items: center;
    min-height: var(--rs-target);
    padding: 0 var(--rs-space-3);
    cursor: pointer;
  }
  .rs-option:hover,
  .rs-option[aria-selected='true'] {
    background: var(--rs-color-surface-raised);
    outline: 2px solid var(--rs-color-focus);
    outline-offset: -2px;
  }
</style>
