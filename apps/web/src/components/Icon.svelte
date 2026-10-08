<script lang="ts">
  export let name = 'note';
  export let size = 20;
  const paths: Record<string, string[]> = {
    note: [
      'M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3',
      'M16 3h5v5',
      'M10 14 21 3',
      'M7 17h6',
    ],
    inbox: ['M4 4h16l2 10v6H2v-6L4 4Z', 'M2 14h6l2 3h4l2-3h6'],
    folder: [
      'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
    ],
    search: ['M21 21l-5-5', 'M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z'],
    plus: ['M12 5v14', 'M5 12h14'],
    close: ['M6 6l12 12', 'M18 6 6 18'],
    menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
    edit: ['m16 3 5 5-12 12H4v-5L16 3Z', 'm13 6 5 5'],
    trash: [
      'M3 6h18',
      'M9 6V3h6v3',
      'M5 6l1 15h12l1-15',
      'M10 10v7',
      'M14 10v7',
    ],
    arrow: ['M12 19V5', 'm5 12 7-7 7 7'],
    move: ['M4 4h9', 'M4 4v16h16v-9', 'M14 3h7v7', 'm10 14 11-11'],
    check: ['m5 12 4 4L19 6'],
    select: [
      'M9 3H3v6',
      'M15 3h6v6',
      'M21 15v6h-6',
      'M9 21H3v-6',
      'm8 12 3 3 5-6',
    ],
    attach: [
      'm21 11-9 9a6 6 0 0 1-8-8L14 2a4 4 0 0 1 6 6L10 18a2 2 0 0 1-3-3L17 5',
    ],
    send: ['m22 2-7 20-4-9-9-4 20-7Z', 'M22 2 11 13'],
    tag: ['M3 3h8l10 10-8 8L3 11V3Z', 'M7 7h.01'],
    settings: [
      'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
      'm9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 2h3l1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-2H9Z',
    ],
    sync: [
      'M20 7a9 9 0 0 0-15-2L2 8',
      'M2 3v5h5',
      'M4 17a9 9 0 0 0 15 2l3-3',
      'M22 21v-5h-5',
    ],
    download: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 16v5h16v-5'],
    logout: ['M9 3H3v18h6', 'M9 12h12', 'm16 7 5 5-5 5'],
    keyboard: [
      'M3 5h18v14H3V5Z',
      'M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 11h.01M10 11h.01M14 11h.01M18 11h.01',
      'M7 15h10',
    ],
    file: ['M14 2H4v20h16V8l-6-6Z', 'M14 2v6h6'],
    warning: ['m12 3 10 18H2L12 3Z', 'M12 9v5', 'M12 17h.01'],
    cloud: [
      'M7 18a5 5 0 1 1-1-10 6 6 0 0 1 11-1 5 5 0 0 1 1 11',
      'm9 13 3 3 4-4',
    ],
    moon: ['M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z'],
    chevron: ['m9 5 7 7-7 7'],
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each paths[name] ?? paths.note as d}<path {d} />{/each}
</svg>
