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
};
