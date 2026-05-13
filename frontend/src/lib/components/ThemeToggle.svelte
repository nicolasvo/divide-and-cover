<script lang="ts">
  import { onMount } from 'svelte';

  let isDark = $state(false);

  onMount(() => {
    isDark = document.documentElement.classList.contains('dark');
  });

  function toggle() {
    isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  }
</script>

<button
  onclick={toggle}
  title="toggle theme"
  aria-label="toggle theme"
  class="shrink-0 w-10 h-10 rounded-full border border-stone-300 dark:border-stone-700 bg-white dark:bg-paper-800 hover:border-claude hover:text-claude transition flex items-center justify-center"
>
  <span class="material-symbols-outlined" style="font-size:22px">
    {isDark ? 'light_mode' : 'dark_mode'}
  </span>
</button>
