# LifeOS PWA — Deployment Guide

## Files in this folder

```
lifeos-pwa/
├── index.html        ← Main app shell
├── style.css         ← All styles
├── app.js            ← All JavaScript + PWA registration
├── manifest.json     ← PWA manifest (name, icons, theme)
├── sw.js             ← Service worker (offline cache + notifications)
├── icons/
│   ├── icon-192.svg  ← App icon (replace with PNG for best results)
│   └── icon-512.svg  ← App icon large
└── README.md         ← This file
```

## Deploy to GitHub Pages (5 minutes)

1. Go to github.com → New repository → name it `lifeos-pwa`
2. Make it **Public**
3. Upload all files from this folder (drag & drop in the GitHub web UI)
4. Go to **Settings → Pages → Branch: main → /root → Save**
5. Your app is live at: `https://YOUR-USERNAME.github.io/lifeos-pwa/`

## Install on Android (Chrome)

1. Open the URL above in Chrome on Android
2. Chrome shows **"Add to Home Screen"** banner automatically
3. Tap Install — LifeOS gets its own icon on your home screen
4. Opens fullscreen, works offline, no browser bar

## Install on iPhone (Safari)

1. Open the URL in Safari
2. Tap the **Share** button → **Add to Home Screen**
3. Tap Add — it's on your home screen

## Replace icons (optional but recommended)

Replace the SVG icons with real PNGs for best Android/iOS display:
- `icons/icon-192.png` — 192×192 pixels
- `icons/icon-512.png` — 512×512 pixels
- Use a transparent background or your preferred background color
- Update manifest.json to change `"type": "image/png"` for both

## What the PWA unlocks vs the HTML file

| Feature | HTML file | PWA (hosted) |
|---|---|---|
| Works offline | ✗ | ✓ |
| Home screen icon | ✗ | ✓ |
| Fullscreen (no browser bar) | ✗ | ✓ |
| Laundry day notifications | ✗ | ✓ |
| Loads instantly (cached) | ✗ | ✓ |
| Splash screen | ✗ | ✓ |
| Google Calendar sync | ✗ | ✓ |

## Local testing (optional)

If you have Python installed:
```bash
cd lifeos-pwa
python3 -m http.server 8080
# Open http://localhost:8080
```

> Note: Service worker requires HTTPS in production — GitHub Pages provides this automatically.
