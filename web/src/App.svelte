<script lang="ts">
  import { onMount } from 'svelte';
  import { loadCore, add, core_version } from './lib/core';

  let ready = $state(false);
  let version = $state('');
  let a = $state(2);
  let b = $state(3);
  let result = $derived(ready ? add(a, b) : NaN);
  let crossOriginIsolated = $state(false);

  onMount(async () => {
    crossOriginIsolated = self.crossOriginIsolated;
    await loadCore();
    version = core_version();
    ready = true;
  });
</script>

<main>
  <h1>web-midi-player</h1>
  <p class="phase">Phase 1 — wasm pipeline smoke test</p>

  <section>
    <h2>Environment</h2>
    <ul>
      <li>crossOriginIsolated: <code>{crossOriginIsolated}</code></li>
      <li>core version: <code>{ready ? version : '...'}</code></li>
    </ul>
  </section>

  <section>
    <h2>add() from wasm</h2>
    <label>a <input type="number" bind:value={a} /></label>
    <label>b <input type="number" bind:value={b} /></label>
    <p>result: <strong>{ready ? result : '...'}</strong></p>
  </section>
</main>

<style>
  main {
    max-width: 640px;
    margin: 0 auto;
    padding: 2rem 1rem;
    font-family: system-ui, sans-serif;
  }
  h1 { margin-bottom: 0; }
  .phase { color: #888; margin-top: 0.25rem; }
  section { margin-top: 2rem; }
  ul { padding-left: 1.25rem; }
  label { display: inline-flex; gap: 0.5rem; align-items: center; margin-right: 1rem; }
  input { width: 5rem; }
  code { background: #f3f3f3; padding: 0.1rem 0.3rem; border-radius: 3px; }
</style>
