<script lang="ts">
  import MenuButton from '../../src/lib/MenuButton.svelte';

  let chosen = $state('nothing');
</script>

<MenuButton
  label="Actions"
  items={[
    { id: 'rescan', label: 'Rescan' },
    { id: 'export', label: 'Export' },
    { id: 'archive', label: 'Archive', disabled: true },
    { id: 'rename', label: 'Rename' },
  ]}
  onselect={(id: string) => {
    chosen = id;
  }}
/>
<button type="button">After</button>
<p>Chose {chosen}</p>
