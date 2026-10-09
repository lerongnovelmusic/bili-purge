"""Turn any image into a landscape backdrop for the console.

A tall source (a phone photo, a poster, a cover) fills a 1920x1080 viewport only
by scaling up and throwing away most of its height. Rather than guess which band
to keep, this measures per-row detail and reports the distribution, so the crop
can be chosen deliberately and regenerated with --position when taste disagrees.

The console itself does not need this script: its own upload button lets you
crop by hand. This is for producing a file to commit or drop into gui/assets/.

  python tools/make-background.py --src=cover.png                 # data-driven band
  python tools/make-background.py --src=cover.png --position=top  # title band, usually
  python tools/make-background.py --src=cover.png --position=center --out=bg.jpg
"""
import argparse
import os
import sys

from PIL import Image, ImageFilter, ImageStat

TARGET_W, TARGET_H = 1920, 1080


def row_detail(img, width, height):
    """Per-row edge energy: text and subject edges score high, flat areas low."""
    edges = img.convert("L").filter(ImageFilter.FIND_EDGES)
    data = list(edges.get_flattened_data() if hasattr(edges, "get_flattened_data")
                else edges.getdata())
    return [sum(data[y * width:(y + 1) * width]) / width for y in range(height)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", required=True, help="the image to fit")
    parser.add_argument("--out", default=os.path.join("gui", "assets", "background.jpg"),
                        help="where to write the 1920x1080 JPEG")
    parser.add_argument("--position", default="auto",
                        choices=["auto", "top", "center", "bottom"])
    parser.add_argument("--gain", type=float, default=1.35,
                        help="how much better a non-centre band must score to win")
    args = parser.parse_args()

    img = Image.open(args.src).convert("RGB")
    width, height = img.size
    scale = max(TARGET_W / width, TARGET_H / height)
    band_h = int(round(TARGET_H / scale))

    print(f"source            : {width} x {height}  (aspect {width / height:.3f})")
    print(f"cover scale       : {scale:.3f}x")
    print(f"visible band      : {band_h} of {height} rows "
          f"({band_h / height * 100:.1f}% of the height)")

    energy = row_detail(img, width, height)

    # Coarse profile, so the shape of the image is visible without seeing it.
    print("\ndetail profile (mean edge energy per tenth of the image):")
    for tenth in range(10):
        lo, hi = tenth * height // 10, (tenth + 1) * height // 10
        mean = sum(energy[lo:hi]) / (hi - lo)
        bar = "#" * int(round(mean * 2.2))
        print(f"  {tenth * 10:3d}-{(tenth + 1) * 10:3d}%  {mean:6.1f}  {bar}")

    def score_at(top):
        return sum(energy[top:top + band_h]) / band_h

    centre = (height - band_h) // 2
    best = max(range(0, height - band_h + 1), key=score_at)
    print(f"\nbest band         : top={best}  (score {score_at(best):.1f})")
    print(f"centre band       : top={centre}  (score {score_at(centre):.1f})")

    if args.position == "top":
        top = 0
    elif args.position == "bottom":
        top = height - band_h
    elif args.position == "center":
        top = centre
    else:
        # Move off centre only when the detail gain clearly justifies it, so a
        # busy corner cannot yank the crop off-subject.
        top = best if score_at(best) > score_at(centre) * args.gain else centre

    print(f"chosen            : top={top}  (rows {top}..{top + band_h})  [{args.position}]")

    crop = img.crop((0, top, width, top + band_h))
    big = crop.resize((TARGET_W, TARGET_H), Image.LANCZOS)
    # Give back some of the sharpness the 2.56x upscale costs.
    big = big.filter(ImageFilter.UnsharpMask(radius=2.2, percent=110, threshold=3))

    mean = ImageStat.Stat(big.convert("L")).mean[0]
    print(f"mean brightness   : {mean:.1f} / 255")

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    big.save(args.out, "JPEG", quality=90, optimize=True, progressive=True)
    print(f"wrote             : {args.out}  ({os.path.getsize(args.out) / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
