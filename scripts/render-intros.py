#!/usr/bin/env python3
"""Render cached Susan intro MP4s for every product in data/products.json.

Per product: compose a friendly high-level script (name, what it is, top
measured molecules, pack claims), synthesize it with Susan's cloned voice
(word timestamps come back), lip-sync the audio onto her avatar look, and
cache intros/<handle>.mp4 + intros/<handle>.json next to the site.

Usage:
  python3 scripts/render-intros.py                # all products (skips cached)
  python3 scripts/render-intros.py --handle X     # one product
  python3 scripts/render-intros.py --force        # re-render even if cached
"""
import argparse
import json
import pathlib
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
API = "https://api.heygen.com"
AVATAR_ID = "d0eb1a3c00d890b109842d033b2270dd"  # Susan, green Terpedia shirt
VOICE_ID = "18933fed22d04ba4896a05dca170d101"   # Susan voice clone


def api_key():
    k = pathlib.Path(ROOT.parent / ".env")
    for line in k.read_text().splitlines():
        if line.startswith("HEYGEN_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("HEYGEN_API_KEY not found in ../.env")


KEY = api_key()
HEADERS = {"X-Api-Key": KEY, "Content-Type": "application/json"}


def api(method, path, payload=None):
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(payload).encode() if payload else None,
        headers=HEADERS, method=method,
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def script_for(p):
    prof = p.get("terpene_profile") or {}
    tops = (prof.get("top") or [])[:3]
    s = f"Hi, I'm Susan. This is {p['name']} — {p.get('description', '')} "
    if tops:
        if prof.get("mg_terpenes_per_chew"):
            s += f"Every chew carries {prof['mg_terpenes_per_chew']} milligrams of measured terpenes. "
        stars = ", ".join(f"{t['name']} at {round(t['mg'], 2)} milligrams" for t in tops)
        s += f"The stars are {stars}. "
    claims = [str(c).lower() for c in (p.get("claims") or [])]
    if claims:
        s += f"On the pack: {', '.join(claims[:-1])} and {claims[-1]}. " if len(claims) > 1 else f"On the pack: {claims[0]}. "
    s += "Ask me anything below, and I'll show you the research behind every compound."
    return s


def sentences_with_times(text, words):
    """Split text into sentences; attach time spans from word timestamps."""
    sents, cur, cur_start = [], [], None
    for w in words:
        token = w["word"].strip()
        cur.append(w)
        if cur_start is None:
            cur_start = w["start"]
        if token.endswith((".", "!", "?")):
            sents.append({"text": " ".join(x["word"] for x in cur),
                          "start": cur_start, "end": w["end"]})
            cur, cur_start = [], None
    if cur:
        sents.append({"text": " ".join(x["word"] for x in cur),
                      "start": cur_start, "end": cur[-1]["end"]})
    return sents


def render(product, outdir, force):
    handle = product["handle"]
    mp4, meta = outdir / f"{handle}.mp4", outdir / f"{handle}.json"
    if mp4.exists() and meta.exists() and not force:
        print(f"  cached, skip ({mp4.name})")
        return
    text = script_for(product)

    sp = api("POST", "/v3/voices/speech", {"voice_id": VOICE_ID, "text": text})
    d = sp["data"]
    words = d.get("word_timestamps") or []
    print(f"  tts ok: {d['duration']:.1f}s, {len(words)} words")

    vid = api("POST", "/v3/videos", {
        "type": "avatar", "avatar_id": AVATAR_ID, "audio_url": d["audio_url"],
        "aspect_ratio": "auto", "resolution": "720p",
        "title": f"susan-intro {handle}",
    })["data"]
    video_id = vid["video_id"]
    print(f"  rendering video {video_id} …")

    for _ in range(120):
        v = api("GET", f"/v3/videos/{video_id}")["data"]
        if v["status"] == "completed":
            break
        if v["status"] == "failed":
            raise SystemExit(f"render failed: {v}")
        time.sleep(10)

    outdir.mkdir(exist_ok=True)
    urllib.request.urlretrieve(v["video_url"], mp4)
    meta.write_text(json.dumps({
        "handle": handle, "text": text, "duration": d["duration"],
        "audio_url": d["audio_url"], "video_id": video_id,
        "words": words, "sentences": sentences_with_times(text, words),
    }, indent=1))
    print(f"  done: {mp4.name} ({mp4.stat().st_size // 1024} KB)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--handle")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    data = json.loads((ROOT / "data" / "products.json").read_text())
    products = data["products"]
    outdir = ROOT / "intros"
    for p in products:
        if a.handle and p["handle"] != a.handle:
            continue
        print(f"{p['name']} ({p['handle']}):")
        try:
            render(p, outdir, a.force)
        except Exception as e:
            print(f"  ERROR: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
