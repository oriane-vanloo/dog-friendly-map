# Bring Your Dog

Static Leaflet map for the dog-friendly venue dataset.

Live site: https://oriane-vanloo.github.io/bringyourdog/

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
- `data/locations.json` is loaded by the map.
- `assets/icons/*.png` are the category marker icons.

## Photos

Selected place cards support two photo sources:

- Manual photos in `data/manual-photos.js`, stored under `assets/photos/`, are used first.
- Google Places photos load on demand when `config.js` has a browser-restricted Google Maps API key.

For Google photos, enable Maps JavaScript API and Places API (New), restrict the key to the live site URL, and keep the visible author/Google Maps attribution overlay.

## Analytics

Google Analytics 4 is wired up behind `config.js`.

Add the GA4 Measurement ID when it is ready:

```js
window.DOG_MAP_CONFIG = {
  googleAnalyticsMeasurementId: "G-XXXXXXXXXX",
};
```

Tracked events include searches, suggestion clicks, filters, place opens, Get there clicks, Instagram clicks, and mobile map expansion.
