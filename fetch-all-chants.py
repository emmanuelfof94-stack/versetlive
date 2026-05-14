#!/usr/bin/env python3
"""Télécharge et parse les 311 cantiques de Chants de Victoire 1926
depuis cantiques.yapper.fr (édition domaine public).
"""
import re
import json
import html
import time
import urllib.request
import urllib.error
from pathlib import Path

BASE = 'https://cantiques.yapper.fr/CV/'
OUT_DIR = Path(__file__).parent
CACHE_DIR = OUT_DIR / '.cv-cache'
CACHE_DIR.mkdir(exist_ok=True)

# Tous les numéros à télécharger (avec variantes a/b connues)
NUMBERS = []
for i in range(1, 312):
    NUMBERS.append(f"{i:03d}")
# Variantes connues (à découvrir dynamiquement si 404)
VARIANTS = ['25a', '25b', '45a', '45b', '147a', '147b', '149a', '149b', '172a', '172b', '204a', '204b', '215a', '215b']
NUMBERS.extend(VARIANTS)

def fetch(num):
    cache = CACHE_DIR / f"{num}.html"
    if cache.exists():
        return cache.read_text(encoding='utf-8')
    url = f"{BASE}CV_{num}.html"
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 versetlive-import'})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = r.read().decode('utf-8')
        cache.write_text(data, encoding='utf-8')
        time.sleep(0.15)  # courtoisie : ~7 req/s max
        return data
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise

# ====== PARSER ======
TITLE_RE = re.compile(r'<title>CV\s*N[°o]\s*([^\s:]+)\s*:\s*([^<]+?)\s*</title>', re.IGNORECASE)
SECTION_RE = re.compile(
    r'<section\s+class="(verse|chorus|prechorus|bridge)"[^>]*id="([VCPB]\d+)"[^>]*>(.*?)</section>',
    re.DOTALL | re.IGNORECASE,
)
LINE_RE = re.compile(r'<div class="indent\d*"[^>]*>([^<]*)</div>', re.IGNORECASE)
VERSENUM_RE = re.compile(r'<div class="versenumber"[^>]*>([^<]*)</div>', re.IGNORECASE)
CHORUS_LABEL_RE = re.compile(r'<div class="chorusnumber"[^>]*>([^<]*)</div>', re.IGNORECASE)

def clean_text(s):
    s = html.unescape(s).strip()
    s = re.sub(r'\s+', ' ', s)
    return s

def parse(html_str, num):
    title_m = TITLE_RE.search(html_str)
    if not title_m:
        return None
    title = clean_text(title_m.group(2))
    sections = []
    verse_count = 0
    chorus_count = 0
    bridge_count = 0
    for m in SECTION_RE.finditer(html_str):
        kind = m.group(1).lower()
        block = m.group(3)
        lines = [clean_text(l.group(1)) for l in LINE_RE.finditer(block)]
        lines = [l for l in lines if l]
        if not lines:
            continue
        text = '\n'.join(lines)

        if kind == 'verse':
            verse_count += 1
            sections.append({
                'type': 'verse',
                'label': f'Couplet {verse_count}',
                'text': text,
            })
        elif kind == 'chorus':
            chorus_count += 1
            sections.append({
                'type': 'chorus',
                'label': 'Refrain' if chorus_count == 1 else f'Refrain {chorus_count}',
                'text': text,
            })
        elif kind == 'bridge':
            bridge_count += 1
            sections.append({
                'type': 'bridge',
                'label': 'Pont' if bridge_count == 1 else f'Pont {bridge_count}',
                'text': text,
            })
        elif kind == 'prechorus':
            sections.append({
                'type': 'prechorus',
                'label': 'Pré-refrain',
                'text': text,
            })

    if not sections:
        return None

    # Numéro propre : "001" → "1", "045a" → "45a"
    num_clean = re.sub(r'^0+', '', num) or '0'

    return {
        'id': f'cv-1926-{num}',
        'number': num_clean,
        'title': title,
        'author': '',
        'book': 'Chants de Victoire',
        'sections': sections,
    }

# ====== EXÉCUTION ======
print(f"Téléchargement de {len(NUMBERS)} cantiques…")
songs = []
fails = []
for i, num in enumerate(NUMBERS):
    data = fetch(num)
    if not data:
        fails.append(num)
        if i % 20 == 0:
            print(f"  [{i+1}/{len(NUMBERS)}] N°{num} → 404 (ignoré)")
        continue
    parsed = parse(data, num)
    if parsed:
        songs.append(parsed)
        if (i + 1) % 25 == 0:
            print(f"  [{i+1}/{len(NUMBERS)}] N°{num} → {parsed['title'][:45]} ({len(parsed['sections'])} sections)")
    else:
        fails.append(num)

# Tri par numéro (numérique d'abord, puis 'a', 'b')
def sort_key(s):
    n = s['number']
    m = re.match(r'(\d+)([a-z]?)', n)
    if m:
        return (int(m.group(1)), m.group(2) or '')
    return (9999, n)

songs.sort(key=sort_key)

# Stats
total_sections = sum(len(s['sections']) for s in songs)
verse_count = sum(1 for s in songs for sec in s['sections'] if sec['type'] == 'verse')
chorus_count = sum(1 for s in songs for sec in s['sections'] if sec['type'] == 'chorus')

print(f"\n✅ {len(songs)} cantiques parsés")
print(f"   {total_sections} sections au total")
print(f"   ({verse_count} couplets, {chorus_count} refrains)")
if fails:
    print(f"   {len(fails)} numéros 404 (normal pour les manquants)")

# Écriture JSON
output = {
    'version': 1,
    'source': 'cantiques.yapper.fr/CV — Chants de Victoire 1926 (domaine public)',
    'songs': songs,
}
json_path = OUT_DIR / 'chants-de-victoire-full.json'
json_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
print(f"\n💾 {json_path.name} ({json_path.stat().st_size / 1024:.1f} Ko)")

# Module JS
js_path = OUT_DIR / 'chants-cv-data.js'
js = "// Chants de Victoire 1926 — édition Delachaux & Niestlé (domaine public)\n"
js += "// Source : cantiques.yapper.fr/CV — extraction automatisée\n"
js += f"// {len(songs)} chants, {total_sections} sections ({verse_count} couplets, {chorus_count} refrains)\n\n"
js += "const CHANTS_VICTOIRE_1926 = " + json.dumps(songs, ensure_ascii=False, indent=2) + ";\n"
js_path.write_text(js, encoding='utf-8')
print(f"💾 {js_path.name} ({js_path.stat().st_size / 1024:.1f} Ko)")
