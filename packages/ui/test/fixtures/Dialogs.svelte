<script lang="ts">
  import Button from '../../src/lib/Button.svelte';
  import Dialog from '../../src/lib/Dialog.svelte';

  let open = $state(false);
  let closes = $state(0);
</script>

<Button
  onclick={() => {
    open = true;
  }}>Rename site</Button
>
<p>Closed {closes} times</p>
<Dialog
  bind:open
  title="Rename site"
  closeLabel="Close"
  onclose={() => {
    closes += 1;
  }}
>
  <label for="site-name">Site name</label>
  <input id="site-name" type="text" />
  {#snippet actions()}
    <Button
      onclick={() => {
        open = false;
      }}>Cancel</Button
    >
    <Button variant="primary">Save</Button>
  {/snippet}
</Dialog>
