<script lang="ts" generics="Row extends Record<string, string | number>">
  // A data table with a caption and column headers. Sortable columns put a button in their
  // header and carry aria-sort while sorted (APG Sortable Table): the first activation sorts
  // ascending, the next descending.
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import CaretUpDownIcon from 'phosphor-svelte/lib/CaretUpDownIcon';
  import CaretUpIcon from 'phosphor-svelte/lib/CaretUpIcon';
  import type { Snippet } from 'svelte';

  interface Column {
    key: keyof Row;
    label: string;
    sortable?: boolean;
    numeric?: boolean;
  }
  interface Sort {
    key: keyof Row;
    direction: 'ascending' | 'descending';
  }
  interface Props {
    caption: string;
    columns: readonly Column[];
    rows: readonly Row[];
    rowKey: (row: Row) => string;
    sort?: Sort | undefined;
    cell?: Snippet<[Row, Column]>;
  }

  let { caption, columns, rows, rowKey, sort = $bindable(), cell }: Props = $props();

  const sorted = $derived.by(() => {
    if (sort === undefined) return rows;
    const { key, direction } = sort;
    const sign = direction === 'ascending' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = a[key];
      const y = b[key];
      const order =
        typeof x === 'number' && typeof y === 'number'
          ? x - y
          : String(x).localeCompare(String(y), undefined, { numeric: true });
      return order * sign;
    });
  });

  function toggle(key: Column['key']) {
    sort =
      sort?.key === key && sort.direction === 'ascending'
        ? { key, direction: 'descending' }
        : { key, direction: 'ascending' };
  }
</script>

<div class="rs-table-wrap">
  <table class="rs-table">
    <caption>{caption}</caption>
    <thead>
      <tr>
        {#each columns as column (column.key)}
          <th
            scope="col"
            class:numeric={column.numeric === true}
            aria-sort={sort?.key === column.key ? sort.direction : undefined}
          >
            {#if column.sortable === true}
              <button
                type="button"
                class="rs-sort"
                onclick={() => {
                  toggle(column.key);
                }}
              >
                {column.label}
                {#if sort?.key !== column.key}
                  <CaretUpDownIcon size={12} weight="bold" aria-hidden="true" />
                {:else if sort.direction === 'ascending'}
                  <CaretUpIcon size={12} weight="bold" aria-hidden="true" />
                {:else}
                  <CaretDownIcon size={12} weight="bold" aria-hidden="true" />
                {/if}
              </button>
            {:else}
              {column.label}
            {/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each sorted as row (rowKey(row))}
        <tr>
          {#each columns as column (column.key)}
            <td class:numeric={column.numeric === true}>
              {#if cell}{@render cell(row, column)}{:else}{row[column.key]}{/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .rs-table-wrap {
    overflow-x: auto;
  }
  .rs-table {
    width: 100%;
    border-collapse: collapse;
  }
  caption {
    padding-bottom: var(--rs-space-2);
    font-weight: 600;
    text-align: left;
  }
  th,
  td {
    padding: var(--rs-space-2) var(--rs-space-3);
    border-bottom: 1px solid var(--rs-color-border);
    text-align: left;
  }
  th {
    background: var(--rs-color-surface-raised);
  }
  .numeric {
    text-align: right;
  }
  .rs-sort {
    display: inline-flex;
    align-items: center;
    gap: var(--rs-space-2);
    min-height: 1.5rem;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--rs-color-accent);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
</style>
