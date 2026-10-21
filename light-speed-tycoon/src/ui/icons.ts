// Inline SVG icons (24x24, drawn with currentColor so buttons can recolor them).

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  inspect: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>'),
  aerial: svg(
    '<path d="M6 21V5M18 21V5"/><path d="M3.5 7h5M15.5 7h5"/><path d="M6 9c4 4 8 4 12 0" stroke-width="2.6"/>',
  ),
  underground: svg('<path d="M3 8h18" stroke-dasharray="2 3"/><path d="M4.5 15.5h15" stroke-width="4.6"/>'),
  cabinet: svg('<rect x="5" y="5" width="14" height="14" rx="3.5"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/>'),
  remove: svg('<circle cx="6.5" cy="7" r="2.6"/><circle cx="6.5" cy="17" r="2.6"/><path d="M8.6 8.6L20 18M8.6 15.4L20 6"/>'),
  pause: svg('<path d="M9 6v12M15 6v12" stroke-width="3"/>'),
  menu: svg('<path d="M5 7h14M5 12h14M5 17h14"/>'),
  home: svg('<path d="M4 11l8-6 8 6"/><path d="M6.5 10v9h11v-9"/>'),
  crew: svg('<path d="M12 4l7 15H5z"/><path d="M8.6 13h6.8"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  spark: svg('<path d="M12 3v5M12 16v5M3 12h5M16 12h5"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>'),
  // Round 2: shared by the map tools (layers, chip) and the economy panels (users, coins, tag, trophy, warning).
  layers: svg('<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/>'),
  chip: svg('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>'),
  users: svg('<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5"/><path d="M16 6.5a3 3 0 010 5.6M17.5 14.3c1.6.7 2.6 2.3 3 4.7"/>'),
  coins: svg('<ellipse cx="12" cy="7" rx="6.5" ry="2.8"/><path d="M5.5 7v5c0 1.5 2.9 2.8 6.5 2.8s6.5-1.3 6.5-2.8V7"/><path d="M5.5 12v5c0 1.5 2.9 2.8 6.5 2.8s6.5-1.3 6.5-2.8v-5"/>'),
  tag: svg('<path d="M3.5 12.5V4h8.5l8.5 8.5-8.5 8.5z"/><circle cx="8" cy="8.5" r="1.5" fill="currentColor"/>'),
  trophy: svg('<path d="M8 4h8v5a4 4 0 01-8 0z"/><path d="M8 6H5a3 3 0 003 4M16 6h3a3 3 0 01-3 4"/><path d="M12 13v4M8.5 20h7"/>'),
  warning: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r="0.9" fill="currentColor"/>'),
  // Round 3: the Bank panel and the HUD debt chip.
  bank: svg('<path d="M3.5 9.5L12 4.5l8.5 5"/><path d="M6 10.5v7M10 10.5v7M14 10.5v7M18 10.5v7"/><path d="M3.5 20h17"/>'),
};
