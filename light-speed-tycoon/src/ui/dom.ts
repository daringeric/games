// Minimal DOM building helpers for the HTML overlay UI.

type Child = Node | string | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  html?: string;
  attrs?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: Event) => void>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.html !== undefined) node.innerHTML = props.html;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const [type, fn] of Object.entries(props.on ?? {})) if (fn) node.addEventListener(type, fn);
  for (const child of children) if (child) node.append(child);
  return node;
}

/** Set text only when it changed, so per-frame HUD updates don't thrash layout. */
export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** An inline SVG icon; `svg` is trusted markup from icons.ts. */
export function icon(svg: string, cls = 'icon'): HTMLSpanElement {
  return el('span', { class: cls, html: svg, attrs: { 'aria-hidden': 'true' } });
}
