<script lang="ts">
  import { tick } from 'svelte';
  import { get } from 'svelte/store';
  import { createVirtualizer } from '@tanstack/svelte-virtual';

  interface Props {
    lines: string[];
    /** Two-way binding: stays true while the view auto-follows the tail. */
    autoFollow?: boolean;
    /** Approximate row height in px; the virtualizer remeasures actual rows. */
    rowHeight?: number;
  }
  let { lines, autoFollow = $bindable(true), rowHeight = 18 }: Props = $props();

  let parentRef: HTMLDivElement | undefined = $state();

  // Start at 0; the $effect below immediately pushes the live count.
  // Reading `lines.length` here would capture only the initial value.
  const rowVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => parentRef ?? null,
    estimateSize: () => rowHeight,
    overscan: 16,
  });

  // Set true around our own scroll writes so the bottom-detection in
  // onScroll doesn't flip autoFollow off while we are pinning the tail.
  let programmaticScroll = false;

  // We deliberately use `get(rowVirtualizer)` instead of `$rowVirtualizer`
  // here: `setOptions` writes back to the store, and auto-subscribing inside
  // an $effect would form a self-feeding loop.
  //
  // For the auto-follow scroll we wait one tick() so the inner container's
  // height (driven by getTotalSize()) has actually grown before we move
  // scrollTop — otherwise the browser caps the write to the old scrollHeight
  // and the view stays one batch behind, looking like it doesn't follow.
  $effect(() => {
    const count = lines.length;
    const follow = autoFollow;
    const virt = get(rowVirtualizer);
    virt.setOptions({
      count,
      getScrollElement: () => parentRef ?? null,
      estimateSize: () => rowHeight,
      overscan: 16,
    });
    if (follow && count > 0) {
      tick().then(() => {
        if (!parentRef || !autoFollow) return;
        programmaticScroll = true;
        parentRef.scrollTop = parentRef.scrollHeight;
        // Released on the next scroll event the browser dispatches.
      });
    }
  });

  function onScroll() {
    if (!parentRef) return;
    if (programmaticScroll) {
      programmaticScroll = false;
      return;
    }
    if (!autoFollow) return;
    // 4px slack so a partial-pixel offset doesn't flip the flag off after
    // a programmatic scroll. A real user scrolling up will drop scrollTop
    // well beyond that.
    const atBottom =
      parentRef.scrollTop + parentRef.clientHeight >= parentRef.scrollHeight - 4;
    if (!atBottom) {
      autoFollow = false;
    }
  }
</script>

<div class="log" bind:this={parentRef} onscroll={onScroll}>
  <div class="log-inner" style:height="{$rowVirtualizer.getTotalSize()}px">
    {#each $rowVirtualizer.getVirtualItems() as item (item.key)}
      <div class="log-row" style:transform="translateY({item.start}px)" style:height="{rowHeight}px">
        {lines[item.index]}
      </div>
    {/each}
  </div>
</div>

<style>
  .log {
    position: relative;
    height: 320px;
    overflow: auto;
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 12px;
    line-height: 1.4;
    color: var(--fg);
  }
  .log-inner {
    position: relative;
    width: 100%;
  }
  .log-row {
    position: absolute;
    left: 0;
    right: 0;
    padding: 0 0.5rem;
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
