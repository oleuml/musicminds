# MusicMinds Web

Progressive web app version of MusicMinds for iOS/iPadOS (and any modern browser).

- Scans Hitster QR codes and looks up the song in the
  [musicminds-hitster-playlists](https://github.com/oleuml/musicminds-hitster-playlists) bundles
  (downloaded automatically on the first unknown code, or via *Bundles*).
- Plays the song through the YouTube IFrame player, hidden behind a cover.
- Starts playing right after the scan. If the browser refuses to autoplay (iOS before the
  first tap in the player), tap the circle once; later rounds then start on their own.
- *Reveal* shows year, title and artist.

Plain HTML/CSS/JS, no build step. [jsQR](https://github.com/cozmo/jsQR) (Apache-2.0) is vendored in `vendor/`.

## Run locally

```bash
python3 -m http.server 8765
```

Open <http://localhost:8765>. The camera needs a secure context, so phones must
use an HTTPS URL. YouTube refuses embeds from bare IP origins (error 150), so test on a real
domain, e.g. GitHub Pages.

## Deploy

Pushes to `main` are published by `.github/workflows/pages.yml`.
Set *Settings → Pages → Source* to **GitHub Actions** once.

The workflow replaces `__BUILD__` in `sw.js` with the commit hash. Each deploy thus gets its
own cache; installed apps show a *New version available* banner and switch on *Reload*.
Locally (`__BUILD__` unreplaced) the service worker is network-first, so edits show up on reload.

## Icons

`icons/icon.svg` is the master (also used as favicon and home-screen logo). The PNGs
(192/512, maskable 192/512 with safe zone, 180 px `apple-touch-icon`, 32 px favicon) are
rendered from it with Inkscape.

