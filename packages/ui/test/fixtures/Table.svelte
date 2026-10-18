<script lang="ts">
  import DataTable from '../../src/lib/DataTable.svelte';

  const rows = [
    { id: 'a', rule: 'image-alt', impact: 'critical', count: 12 },
    { id: 'b', rule: 'color-contrast', impact: 'serious', count: 40 },
    { id: 'c', rule: 'link-name', impact: 'serious', count: 3 },
  ];
</script>

<DataTable
  caption="Findings by rule"
  {rows}
  rowKey={(row: (typeof rows)[number]) => row.id}
  columns={[
    { key: 'rule', label: 'Rule', sortable: true },
    { key: 'impact', label: 'Impact' },
    { key: 'count', label: 'Elements', sortable: true, numeric: true },
  ]}
/>
