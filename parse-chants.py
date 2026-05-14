#!/usr/bin/env python3
"""Parse cantiquest.org HTML → JSON pour VersetLive.

Source : https://www.cantiquest.org/CV/CV-Paroles_Seules.htm
Édition de référence : Chants de Victoire 1926 (domaine public).
"""
import re
import json
import html
from pathlib import Path

SRC = Path(__file__).parent / 'cv-paroles.html'
OUT = Path(__file__).parent / 'chants-de-victoire.json'

raw = SRC.read_text(encoding='utf-8')

# Trouve toutes les ancres de cantiques + leur position
anchor_re = re.compile(r"<a name=Cantique_([0-9a-z]+)></a>\s*<h1>([^<]+)</h1>")
strophe_re = re.compile(
    r"<p class=Clustermoyen>Cantique\s+([0-9a-z]+)\s+strophe\s+(\d+)\s*</p>",
    re.IGNORECASE,
)
posie_re = re.compile(r"<p class=posie>([^<]*)</p>")

# Découpe le document en blocs par cantique
anchors = list(anchor_re.finditer(raw))
print(f"Trouvé {len(anchors)} cantiques")

songs = []
for i, m in enumerate(anchors):
    num_raw = m.group(1)
    title_h1 = html.unescape(m.group(2)).strip()
    start = m.end()
    end = anchors[i + 1].start() if i + 1 < len(anchors) else len(raw)
    block = raw[start:end]

    # Découpe le bloc en strophes
    strophes = []
    sm_iter = list(strophe_re.finditer(block))
    for j, sm in enumerate(sm_iter):
        s_start = sm.end()
        s_end = sm_iter[j + 1].start() if j + 1 < len(sm_iter) else len(block)
        s_block = block[s_start:s_end]
        lines = [html.unescape(p.group(1)).strip() for p in posie_re.finditer(s_block)]
        # Nettoie les lignes vides ou typographiques
        lines = [l for l in lines if l and not l.startswith('&nbsp;')]
        if not lines:
            continue
        strophes.append({
            'num': int(sm.group(2)),
            'text': '\n'.join(lines),
        })

    if not strophes:
        # Fallback : si pas de strophes marquées, prendre tout le texte de poésie
        lines = [html.unescape(p.group(1)).strip() for p in posie_re.finditer(block)]
        lines = [l for l in lines if l]
        if not lines:
            continue
        strophes = [{'num': 1, 'text': '\n'.join(lines)}]

    # Trie par numéro de strophe
    strophes.sort(key=lambda s: s['num'])

    # Construit les sections au format de l'app
    sections = []
    for s in strophes:
        sections.append({
            'type': 'verse',
            'label': f"Couplet {s['num']}",
            'text': s['text'],
        })

    # Le "titre" est la première ligne de la strophe 1
    first_line = strophes[0]['text'].split('\n')[0]
    # Retire la ponctuation finale pour faire un titre propre
    title = re.sub(r'[,;:.]\s*$', '', first_line).strip()
    if len(title) > 60:
        title = title[:60].rsplit(' ', 1)[0] + '…'

    # Numéro : "045a" → "45a", "005" → "5"
    num_clean = num_raw.lstrip('0') or '0'

    songs.append({
        'id': f'cv-1926-{num_raw}',
        'number': num_clean,
        'title': title,
        'author': '',
        'book': 'Chants de Victoire',
        'sections': sections,
    })

# Trie par numéro (numérique d'abord, puis alphabétique pour les "45a")
def sort_key(s):
    n = s['number']
    m = re.match(r'(\d+)([a-z]?)', n)
    if m:
        return (int(m.group(1)), m.group(2) or '')
    return (9999, n)

songs.sort(key=sort_key)

output = {
    'version': 1,
    'exportedAt': None,
    'source': 'cantiquest.org/CV — Chants de Victoire (1926, domaine public)',
    'songs': songs,
}

OUT.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
print(f"✅ {len(songs)} chants → {OUT}")
print(f"   Total sections : {sum(len(s['sections']) for s in songs)}")

# Aperçu
for s in songs[:3]:
    print(f"\n  N°{s['number']} — {s['title']}")
    print(f"    {len(s['sections'])} couplet(s)")
    print(f"    Premier vers : {s['sections'][0]['text'].split(chr(10))[0]}")
