# Techordia Website

Static website for Techordia, an Alameda-based managed IT services provider serving the Bay Area and beyond.

Live share link: https://kylesmcclain.github.io/ttechweb/

GitHub repository: https://github.com/kylesmcclain/ttechweb

## Editing

- Homepage structure lives in `index.html`.
- Services and process steps live in `assets/site-data.js`.
- Colors, spacing, typography, and responsive styling live in `styles.css`.
- The visible Techordia logo asset lives in `assets/techordia-logo-official.png`; `assets/techordia-logo.svg` is retained for the browser favicon.

## Run Locally

Open `index.html` directly in a browser, or run a simple local server from this folder:

```powershell
python -m http.server 4173
```

Then open `http://127.0.0.1:4173`.
