# MusicMinds Web

Progressive web app version of MusicMinds for iOS/iPadOS (and any modern browser).

- Scans Hitster QR codes and looks up the song in the
  [musicminds-hitster-playlists](https://github.com/oleuml/musicminds-hitster-playlists) bundles
  (downloaded automatically on the first unknown code, or via *Bundles*).
- Plays the song through the YouTube IFrame player, hidden behind a cover.
- Tap the circle once to arm, then put the phone face down: it plays while lying still
  and pauses as soon as it is lifted or moved. Without motion sensors use
  *Play without flipping*.
- *Reveal* shows year, title and artist.

Plain HTML/CSS/JS, no build step. [jsQR](https://github.com/cozmo/jsQR) (Apache-2.0) is vendored in `vendor/`.

## Run locally

```bash
python3 -m http.server 8765
```

Open <http://localhost:8765>. Camera and motion sensors need a secure context, so phones must
use an HTTPS URL. YouTube refuses embeds from bare IP origins (error 150), so test on a real
domain, e.g. GitHub Pages.

## Deploy

Pushes to `main` are published by `.github/workflows/pages.yml`.
Set *Settings → Pages → Source* to **GitHub Actions** once.

## Tuning

Face-down and motion thresholds are at the top of `app.js`.
