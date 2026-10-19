<script lang="ts">
  import Link from '../../src/lib/Link.svelte';
  import VisuallyHidden from '../../src/lib/VisuallyHidden.svelte';
</script>

<p>
  <Link href="#report">Read the report</Link>
  and the <Link href="https://www.w3.org/TR/WCAG22/" newTabLabel="(opens in a new tab)"
    >WCAG 2.2 text</Link
  >.
</p>
<button type="button"
  ><VisuallyHidden>Search</VisuallyHidden><span aria-hidden="true">🔍</span></button
>
