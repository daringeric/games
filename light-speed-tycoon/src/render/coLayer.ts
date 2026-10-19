// The central office: a chunky teal toy block at city.coNode with a lighter
// band, a satellite dish and a "CO" label.

import { Container, Graphics, Text } from 'pixi.js';
import type { City } from '../sim/types';
import type { Theme } from './theme';

export function buildCentralOffice(city: City, theme: Theme): Container {
  const { co } = theme;
  const node = city.nodes[city.coNode];
  const cx = (node?.x ?? 0) * theme.cell;
  const cy = (node?.y ?? 0) * theme.cell;
  const x = cx - co.width / 2;
  const y = cy - co.height / 2 - co.depth / 2;

  const g = new Graphics();
  // Soft ground shadow, then the block's side, then its top face.
  g.roundRect(x + 2, y + co.depth + 3, co.width, co.height, co.radius).fill({ color: theme.house.shadow, alpha: 0.9 });
  g.roundRect(x, y + co.depth, co.width, co.height, co.radius).fill(co.side);
  g.roundRect(x, y, co.width, co.height, co.radius).fill(co.body);
  const bandH = co.height * 0.3;
  g.roundRect(x + 4, y + 4, co.width - 8, bandH, co.radius * 0.55).fill(co.band);

  // Dish on the roof band: bowl, rim and feed arm.
  const dx = x + co.width - 11;
  const dy = y + 4 + bandH / 2;
  g.circle(dx, dy, 6.2).fill(co.dish);
  g.circle(dx, dy, 3.8).stroke({ width: 1.2, color: co.band });
  g.moveTo(dx, dy).lineTo(dx - 4.2, dy - 4.2).stroke({ width: 1.4, color: co.dish, cap: 'round' });
  g.circle(dx - 4.2, dy - 4.2, 1.5).fill(co.dish);

  const label = new Text({
    text: 'CO',
    style: {
      fontFamily: `${theme.fonts.display}, ${theme.fonts.ui}, sans-serif`,
      fontWeight: '700',
      fontSize: co.labelSize,
      fill: co.label,
      letterSpacing: 1,
    },
    // Rendered large so it stays crisp when zoomed in.
    resolution: 4,
  });
  label.anchor.set(0.5);
  label.position.set(cx, y + bandH + (co.height - bandH) / 2 + 1.5);

  const container = new Container();
  container.addChild(g, label);
  return container;
}
