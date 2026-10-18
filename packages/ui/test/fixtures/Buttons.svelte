<script lang="ts">
  import Button from '../../src/lib/Button.svelte';

  let presses = $state(0);
</script>

<Button
  variant="primary"
  onclick={() => {
    presses += 1;
  }}>Save</Button
>
<Button>Cancel</Button>
<Button variant="critical">Delete</Button>
<Button disabled>Unavailable</Button>
<p>Pressed {presses} times</p>
