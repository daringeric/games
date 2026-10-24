#!/usr/bin/env python3
"""Make the game's logo assets from the owner's logo (never edit them by hand).

    python3 scripts/logo-assets.py [source.webp]

The source defaults to ../docs/light-speed-tycoon/logo.webp (the README's copy
of the original). A source given on the command line is copied there first.
Needs Pillow and NumPy. Writes:

  src/assets/logo-640.webp, logo-1280.webp   the start-screen and menu banner:
      the logo trimmed to its glow with an even margin, its left and right
      edges eased into the backdrop gradient printed at the end (the theme's
      ui.logoBackdrop), so the banner strip around the image shows no seam
  public/favicon-32.png                       the tall towers, tightly cropped
  public/apple-touch-icon.png (180), icon-192.png, icon-512.png
      the tower cluster (no wordmark) on the logo's navy
  public/og-image.jpg                         1200x630 link preview: the whole
      logo letterboxed on its own navy (rows extended, never stretched)
"""

import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
DOCS_COPY = ROOT.parent / 'docs' / 'light-speed-tycoon' / 'logo.webp'
ASSETS = ROOT / 'src' / 'assets'
PUBLIC = ROOT / 'public'

# Banner trim: a pixel is logo when its luminance is this far above its row's
# background (the median of the image's outer columns); the crop keeps an even
# margin around the logo pixels so the glow fades out inside the image.
CONTENT_THRESHOLD = 30
TRIM_MARGIN = 20
# The outer share of the banner's width eased into the backdrop gradient: about
# the trim margin plus the faint glow, short of the bright fiber lines.
EDGE_FADE = 0.018
# Where the backdrop gradient takes its color stops (fractions of the height).
STOPS = (0.0, 0.5, 0.8, 0.9, 1.0)

# Icons (source pixels): the tower cluster for the large icons (the box's top
# rows lie above the image: the navy sky carries on); the tallest tower and
# its neighbours for the 32 px favicon, where a wider crop blurs the towers.
# Rows below ICON_BOTTOM hold the wordmark: they fade to navy instead.
ICON_BOX = (620, -15, 1020, 385)
FAVICON_BOX = (700, 34, 970, 304)
ICON_BOTTOM = 385
ICON_FADE = 40

OG_SIZE = (1200, 630)


def luminance(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def row_background(a: np.ndarray, cols: int = 12) -> np.ndarray:
    """Each row's background color: the median of its outer columns."""
    return np.median(np.concatenate([a[:, :cols], a[:, -cols:]], axis=1), axis=1)


def smoothstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def to_image(a: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(np.rint(a), 0, 255).astype(np.uint8), 'RGB')


def hex_color(c) -> str:
    return '#' + ''.join(f'{int(round(v)):02x}' for v in c)


def trim_box(a: np.ndarray) -> tuple[int, int, int, int]:
    h, w, _ = a.shape
    d = luminance(a) - luminance(row_background(a))[:, None]
    mask = d > CONTENT_THRESHOLD
    rows = np.where(mask.sum(axis=1) >= 3)[0]
    cols = np.where(mask.sum(axis=0) >= 3)[0]
    left, right = max(0, cols[0] - TRIM_MARGIN), min(w, cols[-1] + 1 + TRIM_MARGIN)
    top, bottom = max(0, rows[0] - TRIM_MARGIN), min(h, rows[-1] + 1 + TRIM_MARGIN)
    return int(left), int(top), int(right), int(bottom)


def backdrop(crop: np.ndarray) -> tuple[list[tuple[float, np.ndarray]], np.ndarray]:
    """
    The banner's backdrop gradient: stops sampled from the crop's edge colors
    (per row, the darker of its two sides: a fiber line's glow reaches the
    left edge, and the backdrop should not carry it across the strip), and
    that gradient per row.
    """
    h = crop.shape[0]
    edge = np.minimum(np.median(crop[:, :6], axis=1), np.median(crop[:, -6:], axis=1))
    # Smooth over a tenth of the height: the gradient follows the light, not the noise.
    k = max(3, h // 10) | 1
    kernel = np.ones(k) / k
    padded = np.pad(edge, ((k // 2, k // 2), (0, 0)), mode='edge')
    smooth = np.stack([np.convolve(padded[:, c], kernel, mode='valid') for c in range(3)], axis=1)
    stops = [(f, np.rint(smooth[min(h - 1, int(round(f * (h - 1))))])) for f in STOPS]
    ys = np.arange(h) / (h - 1)
    fs = np.array([f for f, _ in stops])
    cs = np.array([c for _, c in stops])
    rows = np.stack([np.interp(ys, fs, cs[:, c]) for c in range(3)], axis=1)
    return stops, rows


def banner(src: np.ndarray) -> tuple[Image.Image, tuple[int, int, int, int], list[tuple[float, np.ndarray]]]:
    box = trim_box(src)
    left, top, right, bottom = box
    crop = src[top:bottom, left:right].copy()
    stops, rows = backdrop(crop)
    w = crop.shape[1]
    fade = max(2, int(round(w * EDGE_FADE)))
    x = np.arange(w, dtype=float)
    alpha = np.minimum(smoothstep(x / fade), smoothstep((w - 1 - x) / fade))
    # The outermost column is the backdrop exactly; the logo eases in over `fade` columns.
    out = crop * alpha[None, :, None] + rows[:, None, :] * (1.0 - alpha[None, :, None])
    return to_image(out), box, stops


def save_webp(img: Image.Image, width: int, path: Path) -> None:
    height = round(img.height * width / img.width)
    img.resize((width, height), Image.LANCZOS).save(path, 'WEBP', quality=82, method=6)


def extend_rows(src: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    """`box` of the source; rows above the image repeat its first row (the navy sky), columns clamp."""
    left, top, right, bottom = box
    ys = np.clip(np.arange(top, bottom), 0, src.shape[0] - 1)
    xs = np.clip(np.arange(left, right), 0, src.shape[1] - 1)
    return src[np.ix_(ys, xs)]


def fade_bottom(region: np.ndarray, top: int, navy: np.ndarray) -> np.ndarray:
    """Fade the rows near ICON_BOTTOM (and below it) to navy, so no wordmark shows."""
    ys = np.arange(region.shape[0]) + top
    alpha = smoothstep((ICON_BOTTOM - ys) / ICON_FADE)
    return region * alpha[:, None, None] + navy[None, None, :] * (1.0 - alpha[:, None, None])


def icon(src: np.ndarray, box: tuple[int, int, int, int], size: int, navy: np.ndarray, sharpen: float) -> Image.Image:
    region = fade_bottom(extend_rows(src, box), box[1], navy)
    img = to_image(region).resize((size, size), Image.LANCZOS)
    if sharpen:
        img = img.filter(ImageFilter.UnsharpMask(radius=0.8, percent=int(sharpen), threshold=0))
    return img


def og_image(src: np.ndarray) -> Image.Image:
    """The whole logo at the preview's height, centred; each row carries on in its own edge color."""
    ow, oh = OG_SIZE
    h, w, _ = src.shape
    scale = oh / h
    sw = round(w * scale)
    logo = np.asarray(to_image(src).resize((sw, oh), Image.LANCZOS)).astype(float)
    sides = row_background(logo, cols=8)
    canvas = np.repeat(sides[:, None, :], ow, axis=1)
    x0 = (ow - sw) // 2
    fade = 24
    x = np.arange(sw, dtype=float)
    alpha = np.minimum(smoothstep(x / fade), smoothstep((sw - 1 - x) / fade))
    canvas[:, x0:x0 + sw] = logo * alpha[None, :, None] + canvas[:, x0:x0 + sw] * (1.0 - alpha[None, :, None])
    return to_image(canvas)


def kb(path: Path) -> str:
    return f'{path.stat().st_size / 1024:.1f} KB'


def main() -> None:
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else DOCS_COPY
    DOCS_COPY.parent.mkdir(parents=True, exist_ok=True)
    if source.resolve() != DOCS_COPY.resolve():
        shutil.copyfile(source, DOCS_COPY)
    ASSETS.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)

    im = Image.open(DOCS_COPY).convert('RGB')
    src = np.asarray(im).astype(float)
    print(f'source {im.width}x{im.height}, docs copy {kb(DOCS_COPY)}')

    img, box, stops = banner(src)
    print(f'banner trim {box} -> {img.width}x{img.height} (aspect {img.width / img.height:.4f})')
    for width in (640, 1280):
        path = ASSETS / f'logo-{width}.webp'
        save_webp(img, width, path)
        with Image.open(path) as saved:
            print(f'  {path.relative_to(ROOT)} {saved.width}x{saved.height} {kb(path)}')
    gradient = ', '.join(f'{hex_color(c)} {round(f * 100)}%' for f, c in stops)
    print(f"  theme.ts ui.logoBackdrop: 'linear-gradient({gradient})'")

    # The navy behind the icons: the source's top corners.
    navy = np.median(np.concatenate([src[:40, :40], src[:40, -40:]], axis=1).reshape(-1, 3), axis=0)
    print(f'icon navy {hex_color(navy)}')
    outputs = [
        (FAVICON_BOX, 32, 'favicon-32.png', 60),
        (ICON_BOX, 180, 'apple-touch-icon.png', 0),
        (ICON_BOX, 192, 'icon-192.png', 0),
        (ICON_BOX, 512, 'icon-512.png', 35),
    ]
    for box_, size, name, sharpen in outputs:
        path = PUBLIC / name
        icon(src, box_, size, navy, sharpen).save(path, 'PNG', optimize=True)
        print(f'  {path.relative_to(ROOT)} {size}x{size} {kb(path)}')

    path = PUBLIC / 'og-image.jpg'
    og_image(src).save(path, 'JPEG', quality=86, optimize=True, progressive=True)
    print(f'  {path.relative_to(ROOT)} {OG_SIZE[0]}x{OG_SIZE[1]} {kb(path)}')


if __name__ == '__main__':
    main()
