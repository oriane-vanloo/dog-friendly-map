# Dog-Friendly Melbourne Leaflet Map

Static Leaflet map for the dog-friendly venue dataset.

The app is a plain static site: `index.html`, `styles.css`, `app.js`, and local data/assets.

## Run

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:8765/
```

## Data

- `data/locations.csv` is the merged editable source file.
- `data/locations.json` is the canonical JSON data.
- `data/locations.js` mirrors the JSON for `file://` usage.
- `assets/icons/*-marker.png` are the category marker icons.
