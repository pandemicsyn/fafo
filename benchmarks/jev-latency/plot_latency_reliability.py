#!/usr/bin/env python3
"""Render the completed Jev benchmark as a standalone blog SVG."""

import argparse
import csv
import html
import math
from pathlib import Path
from xml.etree import ElementTree


COLORS = {
    "bg": "#03080c",
    "fg": "#f8fafc",
    "muted": "#9eb4c0",
    "grid": "#24343e",
    "cyan": "#22d3ee",
    "violet": "#a78bfa",
    "pink": "#f472b6",
    "lime": "#a3e635",
}
W, H = 1600, 1060
LEFT, RIGHT, TOP, BOTTOM = 222, 1462, 282, 827


def esc(value):
    return html.escape(str(value), quote=True)


def x_pos(ms):
    return LEFT + ms / 120 * (RIGHT - LEFT)


def y_pos(success_pct):
    return BOTTOM - success_pct / 100 * (BOTTOM - TOP)


def text(x, y, label, size=23, color="fg", weight=400, anchor="start", extra=""):
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" fill="{COLORS.get(color, color)}" '
        f'font-family="JetBrains Mono, Menlo, Consolas, monospace" font-size="{size}" '
        f'font-weight="{weight}" text-anchor="{anchor}" {extra}>{esc(label)}</text>'
    )


def line(x1, y1, x2, y2, color="grid", width=2, opacity=1, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (
        f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
        f'stroke="{COLORS.get(color, color)}" stroke-width="{width}" '
        f'opacity="{opacity}"{d}/>'
    )


def polygon(points, fill, stroke="bg", stroke_width=2, opacity=1):
    coords = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    return (
        f'<polygon points="{coords}" fill="{COLORS.get(fill, fill)}" '
        f'stroke="{COLORS.get(stroke, stroke)}" stroke-width="{stroke_width}" opacity="{opacity}"/>'
    )


def star_points(cx, cy, outer=15, inner=7):
    return [
        (
            cx + (outer if i % 2 == 0 else inner) * math.cos(-math.pi / 2 + i * math.pi / 5),
            cy + (outer if i % 2 == 0 else inner) * math.sin(-math.pi / 2 + i * math.pi / 5),
        )
        for i in range(10)
    ]


def marker(route, cx, cy, mixed=False, size=11):
    color = "violet" if route == "openrouter" else "pink"
    if mixed:
        return polygon(star_points(cx, cy, 19, 9), color, "fg", 2.5)
    if route == "openrouter":
        return (
            f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{size}" '
            f'fill="{COLORS[color]}" stroke="{COLORS["bg"]}" stroke-width="2" opacity="0.9"/>'
        )
    return (
        f'<rect x="{cx-size:.1f}" y="{cy-size:.1f}" width="{2*size}" height="{2*size}" '
        f'rx="2" fill="{COLORS[color]}" stroke="{COLORS["bg"]}" stroke-width="2" opacity="0.9"/>'
    )


def load_rows(results):
    with (results / "pairs.csv").open(newline="") as f:
        pairs = list(csv.DictReader(f))
    with (results / "summary.csv").open(newline="") as f:
        summary = list(csv.DictReader(f))
    successes = {
        (r["provider"], r["primitive"], r["batch"]): 100 * int(r["ok"]) / int(r["observed"])
        for r in summary
    }
    if len(pairs) != 20 or len(summary) != 30:
        raise ValueError("expected ten workloads across three providers")
    for r in summary:
        if int(r["observed"]) != 100:
            raise ValueError("chart requires a completed 100-repetition run")
    for r in pairs:
        r["delay"] = float(r["median_paired_delta_ms"])
        r["success"] = successes[(r["gateway"], r["primitive"], r["batch"])]
    return pairs, summary


def make_svg(results):
    pairs, summary = load_rows(results)
    direct_ok = sum(int(r["ok"]) for r in summary if r["provider"] == "typesafe")
    or_ok = sum(int(r["ok"]) for r in summary if r["provider"] == "openrouter")
    vercel_ok = sum(int(r["ok"]) for r in summary if r["provider"] == "vercel")
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="chart-title chart-desc">',
        '<title id="chart-title">Jev routes: latency versus completion in this run</title>',
        '<desc id="chart-desc">Direct TypeSafe succeeded in all 1,000 calls at zero relative delay. OpenRouter succeeded in all 1,000 calls with median matched delays of 31 to 48 milliseconds. Vercel succeeded in 389 of 1,000 calls, with successful matched delays of 59 to 104 milliseconds under a reported 30-request-per-minute limit. Each gateway dot represents one workload; stars mark the mixed 16-question workload. The success rates do not estimate general service uptime.</desc>',
        '<defs><linearGradient id="neon" x1="0" x2="1"><stop stop-color="#22d3ee"/><stop offset="1" stop-color="#a3e635"/></linearGradient></defs>',
        f'<rect width="{W}" height="{H}" fill="{COLORS["bg"]}"/>',
        '<rect width="1600" height="7" fill="url(#neon)"/>',
        text(92, 86, "JEV ROUTES", 24, "cyan", 700, extra='letter-spacing="4"'),
        text(92, 147, "Latency vs completion", 55, "fg", 700),
        text(94, 190, "10 workloads  ·  100 repetitions each  ·  22 Sep 2026  ·  sequential requests", 22, "muted"),
        line(92, 212, 1508, 212, "grid", 2),
        text(LEFT, 249, "SUCCESSFUL REQUESTS IN THIS RUN", 19, "muted", 700, extra='letter-spacing="2"'),
    ]

    # Grid and axes. Marks sit on the exact, unjittered success percentage.
    for pct in [0, 25, 50, 75, 100]:
        yy = y_pos(pct)
        parts.append(line(LEFT, yy, RIGHT, yy, "grid", 2 if pct in (0, 100) else 1, 0.9 if pct in (0, 100) else 0.65))
        parts.append(text(LEFT - 24, yy + 8, f"{pct}%", 20, "muted", anchor="end"))
    for ms in [0, 20, 40, 60, 80, 100, 120]:
        xx = x_pos(ms)
        parts.append(line(xx, TOP, xx, BOTTOM, "grid", 1, 0.5))
        parts.append(text(xx, BOTTOM + 42, str(ms), 20, "muted", anchor="middle"))
    parts.append(text((LEFT + RIGHT) / 2, 923, "MEDIAN EXTRA LATENCY VS DIRECT  ·  ms", 22, "fg", 700, "middle", 'letter-spacing="1"'))

    # Route markers: distinct shape and color, with the mixed case as a star.
    direct_x, direct_y = x_pos(0), y_pos(100)
    parts.append(polygon([(direct_x, direct_y - 17), (direct_x + 17, direct_y), (direct_x, direct_y + 17), (direct_x - 17, direct_y)], "cyan", "fg", 2))
    regular = [r for r in pairs if r["primitive"] != "mixed"]
    mixed = [r for r in pairs if r["primitive"] == "mixed"]
    for r in regular + mixed:
        cx, cy = x_pos(r["delay"]), y_pos(r["success"])
        name = "OpenRouter" if r["gateway"] == "openrouter" else "Vercel"
        label = f'{name}, {r["primitive"]} batch {r["batch"]}: +{r["delay"]:.1f} ms; {r["success"]:.0f}% successful'
        parts.append(f'<g><title>{esc(label)}</title>{marker(r["gateway"], cx, cy, r["primitive"] == "mixed")}</g>')

    # Direct labels keep the crowded 100% row readable without moving marks.
    parts.append(text(LEFT + 30, TOP + 39, f"DIRECT  ·  {direct_ok}/1000", 21, "cyan", 700))
    parts.append(text(743, TOP + 38, f"OPENROUTER  ·  {or_ok}/1000", 21, "violet", 700))
    parts.append(text(1000, 422, f"VERCEL  ·  {vercel_ok}/1000", 21, "pink", 700))

    # The starred mixed workload provides a concrete reading of each gateway cloud.
    or_mixed = next(r for r in mixed if r["gateway"] == "openrouter")
    ve_mixed = next(r for r in mixed if r["gateway"] == "vercel")
    ox, oy = x_pos(or_mixed["delay"]), y_pos(or_mixed["success"])
    vx, vy = x_pos(ve_mixed["delay"]), y_pos(ve_mixed["success"])
    parts.append(line(ox + 13, oy + 18, 705, 353, "violet", 2, 0.85))
    parts.append(text(716, 352, "MIXED · 16 QUESTIONS", 19, "fg", 700))
    parts.append(text(716, 383, f'OpenRouter  +{or_mixed["delay"]:.0f} ms  ·  {or_mixed["success"]:.0f}% success', 19, "violet"))
    parts.append(line(vx - 10, vy + 18, 1098, 724, "pink", 2, 0.85))
    parts.append(text(1087, 750, "MIXED · 16 QUESTIONS", 19, "fg", 700, "end"))
    parts.append(text(1087, 781, f'Vercel  +{ve_mixed["delay"]:.0f} ms  ·  {ve_mixed["success"]:.0f}% success', 19, "pink", anchor="end"))

    parts.append(line(92, 950, 1508, 950, "grid", 2))
    parts.append(text(94, 984, "Gateway dots = one workload; direct = shared baseline. X = matched delay; Y = success rate.", 18, "fg"))
    parts.append(text(94, 1015, "Vercel: 593 limit 429s + 18 other DNFs. This is not an uptime estimate or pure gateway overhead.", 18, "muted"))
    parts.append('</svg>')
    return "\n".join(parts) + "\n"


def render_png(svg_path, png_path):
    """Rasterize the chart's small SVG vocabulary without a browser dependency."""
    from PIL import Image, ImageDraw, ImageFont

    scale = 2
    image = Image.new("RGB", (W * scale, H * scale), COLORS["bg"])
    draw = ImageDraw.Draw(image)
    root = ElementTree.parse(svg_path).getroot()
    ns = "{http://www.w3.org/2000/svg}"
    font_dir = Path.home() / "Library/Fonts"
    regular_path = font_dir / "JetBrainsMonoNerdFont-Regular.ttf"
    bold_path = font_dir / "JetBrainsMonoNerdFont-Bold.ttf"
    if not regular_path.exists():
        regular_path = bold_path = Path("/System/Library/Fonts/Menlo.ttc")
    fonts = {}

    def number(element, name, default=0):
        return float(element.get(name, default))

    def coord(value):
        return round(float(value) * scale)

    def color(value, opacity=1):
        if value.startswith("url("):
            return value
        rgb = tuple(int(value[i : i + 2], 16) for i in (1, 3, 5))
        if opacity >= 1:
            return rgb
        bg = tuple(int(COLORS["bg"][i : i + 2], 16) for i in (1, 3, 5))
        return tuple(round(bg[i] * (1 - opacity) + rgb[i] * opacity) for i in range(3))

    def font(size, bold):
        key = (size, bold)
        if key not in fonts:
            fonts[key] = ImageFont.truetype(str(bold_path if bold else regular_path), round(size * scale))
        return fonts[key]

    def visit(element):
        tag = element.tag.removeprefix(ns)
        if tag in ("defs", "title", "desc"):
            return
        if tag in ("svg", "g"):
            for child in element:
                visit(child)
            return
        opacity = number(element, "opacity", 1)
        if tag == "rect":
            x, y = number(element, "x"), number(element, "y")
            w, h = number(element, "width"), number(element, "height")
            fill = element.get("fill", COLORS["fg"])
            box = [coord(x), coord(y), coord(x + w), coord(y + h)]
            if fill == "url(#neon)":
                for px in range(box[0], box[2]):
                    t = (px - box[0]) / max(1, box[2] - box[0] - 1)
                    a, b = color(COLORS["cyan"]), color(COLORS["lime"])
                    c = tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3))
                    draw.line([(px, box[1]), (px, box[3])], fill=c)
            else:
                draw.rectangle(box, fill=color(fill, opacity))
            if element.get("stroke"):
                draw.rectangle(box, outline=color(element.get("stroke"), opacity), width=max(1, coord(number(element, "stroke-width", 1))))
        elif tag == "line":
            draw.line(
                [(coord(number(element, "x1")), coord(number(element, "y1"))),
                 (coord(number(element, "x2")), coord(number(element, "y2")))],
                fill=color(element.get("stroke", COLORS["fg"]), opacity),
                width=max(1, coord(number(element, "stroke-width", 1))),
            )
        elif tag == "circle":
            cx, cy, r = number(element, "cx"), number(element, "cy"), number(element, "r")
            box = [coord(cx - r), coord(cy - r), coord(cx + r), coord(cy + r)]
            draw.ellipse(box, fill=color(element.get("fill", COLORS["fg"]), opacity),
                         outline=color(element.get("stroke", COLORS["bg"]), opacity),
                         width=max(1, coord(number(element, "stroke-width", 1))))
        elif tag == "polygon":
            points = [tuple(coord(v) for v in point.split(",")) for point in element.get("points", "").split()]
            draw.polygon(points, fill=color(element.get("fill", COLORS["fg"]), opacity))
            if element.get("stroke"):
                draw.line(points + [points[0]], fill=color(element.get("stroke"), opacity),
                          width=max(1, coord(number(element, "stroke-width", 1))), joint="curve")
        elif tag == "text":
            size = number(element, "font-size", 20)
            bold = number(element, "font-weight", 400) >= 700
            anchor = {"start": "ls", "middle": "ms", "end": "rs"}[element.get("text-anchor", "start")]
            xy = (coord(number(element, "x")), coord(number(element, "y")))
            fill = color(element.get("fill", COLORS["fg"]))
            content = element.text or ""
            spacing = number(element, "letter-spacing", 0)
            if spacing and anchor == "ls":
                x, y = xy
                for ch in content:
                    draw.text((x, y), ch, font=font(size, bold), fill=fill, anchor="ls")
                    x += round(draw.textlength(ch, font=font(size, bold)) + spacing * scale)
            else:
                draw.text(xy, content, font=font(size, bold), fill=fill, anchor=anchor)

    visit(root)
    png_path.parent.mkdir(parents=True, exist_ok=True)
    image.resize((W, H), Image.Resampling.LANCZOS).save(png_path, optimize=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--svg", type=Path, required=True)
    parser.add_argument("--png", type=Path)
    args = parser.parse_args()
    args.svg.parent.mkdir(parents=True, exist_ok=True)
    args.svg.write_text(make_svg(args.results), encoding="utf-8")
    print(args.svg)
    if args.png:
        render_png(args.svg, args.png)
        print(args.png)


if __name__ == "__main__":
    main()
