# ✝ VersetLive

> Diffusion de versets bibliques, chants et titres pour le culte — avec studio multi-caméras intégré au navigateur.

[![Démo](https://img.shields.io/badge/d%C3%A9mo-versetlive.vercel.app-blueviolet)](https://versetlive.vercel.app)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Vercel](https://img.shields.io/badge/deploy-Vercel-black)](https://vercel.com)

VersetLive est une application web **100 % statique** pensée pour les églises : afficher en direct un verset biblique, des paroles de chants, un titre animé, le tout pendant une diffusion vidéo multi-caméras — **sans installer OBS**, sans serveur dédié, et sans abonnement.

Tout tourne dans le navigateur. Le relais local optionnel ajoute le streaming RTMP simultané vers YouTube, Facebook, Twitch et bien plus.

---

## 🎯 Pourquoi VersetLive

La plupart des solutions de régie pour culte demandent OBS Studio + plugins + WebSocket + un mixeur matériel. C'est puissant, mais lourd à installer, à maintenir, et fragile en condition de service.

VersetLive part de l'autre bout : **tout est dans le navigateur**, déployé sur Vercel, et utilisable depuis un MacBook seul avec un ou deux téléphones comme caméras secondaires.

---

## ✨ Fonctionnalités

### 📖 Côté contenu
- **Bibliothèque biblique complète** — plusieurs traductions, recherche plein-texte
- **Chants** — base de chants intégrée (Chants de victoire, etc.) avec import SongSelect
- **Titres animés** — bibliothèque de titres prêts à l'emploi
- **Mode présentateur** — vue dédiée pour l'orateur (verset + notes)
- **Synchronisation multi-écrans** via BroadcastChannel + localStorage

### 🎬 Côté diffusion
- **Studio intégré navigateur** — mixeur multi-caméras WebRTC, transitions fade, scènes nommées
- **Caméras téléphones** — connecte un iPhone ou Android via QR code (WebRTC, peerJS Cloud)
- **Caméras USB** — toutes les sources MediaDevices supportées
- **Enregistrement local** — capture le mix en `.webm`
- **Sortie projecteur** — fenêtre dédiée à glisser sur le second écran
- **Projection TV sans-fil** — affiche le mix sur une TV via son navigateur web (sans Chromecast, sans câble)

### 📡 Streaming RTMP (optionnel, via relais local)
- **Multi-plateformes simultanées** — YouTube + Facebook + Twitch + N destinations en un seul clic
- **Aucun service cloud** — un petit relais Node.js sur ta machine (ffmpeg embarqué)
- **Setup zéro** — `start-versetlive.command` lance tout (relais + studio dans le navigateur)

### 🎬 Intro / Outro animés
- **Écran de bienvenue** avant le service : titre + sous-titre + logo + countdown
- **Écran de remerciement** à la fin du service
- **Modes texte animé OU vidéo MP4 importée**
- **Musique de fond MP3** mixée dans le flux RTMP
- Assets stockés en **IndexedDB local** (rien n'est uploadé)

---

## 🚀 Démo en ligne

➡ **[versetlive.vercel.app](https://versetlive.vercel.app)**

- Panneau principal : [/](https://versetlive.vercel.app)
- Studio : [/studio](https://versetlive.vercel.app/studio)
- TV : [/tv](https://versetlive.vercel.app/tv) (à ouvrir sur l'écran cible)

---

## 🏃 Démarrage rapide

### Utilisation directe (sans rien installer)

L'app est déjà déployée. Ouvre simplement [versetlive.vercel.app](https://versetlive.vercel.app) — il n'y a rien à faire.

### Développement local

```bash
git clone https://github.com/emmanuelfof94-stack/versetlive.git
cd versetlive
python3 -m http.server 8765
# → http://localhost:8765
```

C'est tout. L'app est 100 % statique, aucune build step.

### Streaming RTMP local

```bash
# Lance le studio + le relais d'un coup (macOS)
./start-versetlive.command

# Ou manuellement
cd relay
npm install        # première fois seulement
./start.command    # relais sur wss://localhost:8766
```

Le relais embarque `ffmpeg-static` (binaire ARM64 macOS) — pas besoin d'installer ffmpeg séparément.

---

## 🗺 Pages

| URL | Rôle |
|---|---|
| `/` | Panneau principal — sélection verset/chant/titre, contrôle du direct |
| `/studio` | Régie complète — mixeur multi-caméras, enregistrement, streaming |
| `/obs` | Vue plein écran à capturer dans OBS Studio (optionnel) |
| `/presenter` | Vue présentateur pour l'orateur (lecture + notes) |
| `/tv` | Page à ouvrir sur une TV — affiche le code de pairage |
| `/studio-camera` | Page caméra accessible via QR code depuis un téléphone |
| `/studio-output` | Fenêtre de sortie pour le projecteur |
| `/cv-paroles` | Lecteur de paroles (Chants de victoire) |

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Vercel (statique)                                          │
│  ├── index.html      ─ panneau principal                    │
│  ├── studio.html     ─ régie navigateur                     │
│  ├── tv.html         ─ écran TV                             │
│  └── studio-camera.html ─ téléphone caméra                  │
└─────────────────────────────────────────────────────────────┘
              ▲                  ▲                ▲
              │ BroadcastChannel │ PeerJS Cloud   │ WebRTC
              │ + localStorage   │ (signaling)    │ (vidéo P2P)
              ▼                  ▼                ▼
┌─────────────────┐   ┌──────────────────┐   ┌────────────────┐
│  Autres tabs    │   │  Téléphone       │   │  TV (autre     │
│  (orateur,      │   │  (caméra)        │   │   navigateur)  │
│   présentateur) │   └──────────────────┘   └────────────────┘
└─────────────────┘

                       ┌───────────────────────┐
                       │  Relais local (Node)  │
   Studio ─WebSocket─▶ │  wss://localhost:8766 │ ─RTMP─▶ YouTube
   (WebM/Opus)         │  ffmpeg tee muxer     │ ─RTMP─▶ Facebook
                       └───────────────────────┘ ─RTMP─▶ Twitch
```

### Stack
- **Frontend** : HTML/CSS/JavaScript vanilla, **aucun framework, aucun build**
- **Signaling WebRTC** : [PeerJS Cloud](https://peerjs.com) (broker public, gratuit)
- **Streaming RTMP** : Node.js ≥ 18 + `ws` + `ffmpeg-static` (binaire embarqué)
- **Stockage** : `localStorage` (config, destinations RTMP, dernier verset) + `IndexedDB` (assets intro/outro)
- **Déploiement** : [Vercel](https://vercel.com) — push sur `main` → auto-deploy

### Communication inter-onglets
- **Même origine** : `BroadcastChannel('versetlive')` + miroir `localStorage['versetlive:state']`
- **Origines différentes (TV)** : PeerJS DataConnection avec préfixe `versetlive-tv-{CODE}`
- **Téléphones caméras** : PeerJS MediaConnection avec préfixe `versetlive-studio-{ROOM}`

---

## 📺 Mode TV (sans câble)

1. Sur la télé : ouvrir un navigateur web → `versetlive.vercel.app/tv`
2. La TV affiche un code à 4 caractères (ex. `K3M9`)
3. Dans le studio : cliquer `📺 TV` → saisir le code
4. Choisir le mode : **verset seul** (data only, ultra-léger) ou **mix vidéo complet** (WebRTC)
5. Wake Lock activé : l'écran ne s'éteint pas pendant le service

Aucun Chromecast, aucun câble HDMI. N'importe quel appareil avec un navigateur récent fonctionne (Smart TV, console, Mac, Apple TV en mode navigateur, etc.).

---

## ⌨ Raccourcis clavier (studio)

| Touche | Action |
|---|---|
| `1` à `9` | Sélectionner la scène N |
| `0` | Scène noire |
| `V` | Verset plein écran |
| `Espace` | Démarrer/arrêter le stream RTMP |
| `R` | Démarrer/arrêter l'enregistrement |
| `?` | Ouvrir l'aide |

Désactivés automatiquement quand un champ texte ou une modale est ouverte.

---

## 🔐 Confidentialité

- **Aucun serveur de l'auteur ne stocke vos données.** Tout ce qui transite passe par PeerJS Cloud (signaling), Vercel (CDN statique) et votre relais local (RTMP).
- **Clés de stream RTMP** : stockées en `localStorage` sur votre machine, jamais envoyées ailleurs que vers le relais local.
- **Assets intro/outro** : stockés en `IndexedDB` sur votre machine.

---

## 🤝 Contribuer

Les PR sont les bienvenues. Quelques règles :

1. **Pas de framework JS** — VersetLive reste vanilla. La simplicité d'install est une feature.
2. **Pas de dépendance npm dans le frontend** — les libs (PeerJS, qrcode) sont bundlées en local.
3. **Le relais peut évoluer** — c'est du Node.js classique, mais reste minimaliste.
4. **Le français est la langue par défaut** des commentaires et de l'UI.

### Issues bienvenues
- Bugs de compatibilité navigateur (Safari/Firefox/Chrome)
- Améliorations d'accessibilité
- Nouvelles traductions bibliques
- Nouvelles destinations RTMP (Kick, X, etc.)

---

## 📜 License

MIT — voir [LICENSE](LICENSE).

Utilisation libre, modification libre, redistribution libre. Aucune garantie. Aucune responsabilité.

---

<p align="center">
  Fait avec ❤ pour les églises qui veulent diffuser sans se prendre la tête.
</p>
