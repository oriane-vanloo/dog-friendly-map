const MELBOURNE_CENTER = [-37.8108, 144.9631];

const categoryMeta = {
  Cafe: {
    label: "Cafe",
    icon: "./assets/icons/cafe-marker.png",
  },
  "Pub/Bar": {
    label: "Pub/Bar",
    icon: "./assets/icons/pub-marker.png",
  },
  Park: {
    label: "Park",
    icon: "./assets/icons/park-marker.png",
  },
  Shop: {
    label: "Shop",
    icon: "./assets/icons/shop-marker.png",
  },
};

const activeCategories = new Set(Object.keys(categoryMeta));
const markersByPlace = new Map();
const markerLayer = L.layerGroup();
const suburbs = [
  "Brunswick East",
  "Carlton North",
  "Clifton Hill",
  "Collingwood",
  "East St Kilda",
  "Fitzroy North",
  "Fitzroy",
  "Melbourne",
  "Northcote",
  "Port Melbourne",
  "Prahran",
  "Richmond",
  "South Melbourne",
  "South Yarra",
  "St Kilda East",
  "St Kilda West",
  "St Kilda",
  "Windsor",
  "Abbotsford",
  "Brunswick",
  "Balaclava",
].sort((a, b) => b.length - a.length);

let map;
let places = [];
let selectedPlaceId = null;

const iconByCategory = Object.fromEntries(
  Object.entries(categoryMeta).map(([category, meta]) => [
    category,
    L.icon({
      iconUrl: meta.icon,
      iconSize: [46, 46],
      iconAnchor: [23, 23],
      popupAnchor: [0, -24],
      className: "category-marker",
    }),
  ])
);

const placeList = document.querySelector("#placeList");
const resultCount = document.querySelector("#resultCount");
const searchInput = document.querySelector("#search");
const selectedPlace = document.querySelector("#selectedPlace");
const filterButtons = [...document.querySelectorAll(".filter-button")];
const mapElement = document.querySelector("#map");
const mapPanel = document.querySelector(".map-panel");

let mapRefreshFrame = null;
let shouldFitBoundsOnRefresh = false;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function categoryClass(category) {
  return `category-${category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function placeMatches(place, query) {
  if (!query) {
    return true;
  }

  const haystack = [
    place.name,
    place.address,
    place.category,
    place.description,
  ].join(" ").toLowerCase();

  return haystack.includes(query.toLowerCase());
}

function getFilteredPlaces() {
  const query = searchInput.value.trim();

  return places.filter((place) => {
    return activeCategories.has(place.category) && placeMatches(place, query);
  });
}

function getLocationParts(address) {
  const cleanedAddress = address.replace(/,\s*Australia$/i, "").trim();
  const suburb = suburbs.find((value) => {
    return cleanedAddress.includes(` ${value} VIC`) || cleanedAddress.endsWith(` ${value}`);
  });

  if (!suburb) {
    return {
      suburb: "",
      displayAddress: cleanedAddress.replace(/\s+VIC\s+\d{4}$/i, ""),
    };
  }

  const streetAddress = cleanedAddress
    .slice(0, cleanedAddress.indexOf(` ${suburb}`))
    .replace(/\s+/g, " ")
    .trim();

  return {
    suburb,
    displayAddress: streetAddress ? `${streetAddress}, ${suburb}` : suburb,
  };
}

function googleMapsUrl(place) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${place.name}, ${place.address}`)}`;
}

function popupHtml(place) {
  const location = getLocationParts(place.address);

  return `
    <article class="popup">
      <span class="category ${categoryClass(place.category)}">${escapeHtml(place.category)}</span>
      ${location.suburb ? `<span class="category suburb">${escapeHtml(location.suburb)}</span>` : ""}
      <h2>${escapeHtml(place.name)}</h2>
      <p>${escapeHtml(place.description)}</p>
      <p><span class="address-label">Address</span>${escapeHtml(location.displayAddress)}</p>
      <a class="get-there" href="${googleMapsUrl(place)}" target="_blank" rel="noopener noreferrer">Get there</a>
    </article>
  `;
}

function renderSelectedPlace(place) {
  if (!place) {
    selectedPlace.classList.add("is-empty");
    selectedPlace.innerHTML = "";
    return;
  }

  selectedPlace.classList.remove("is-empty");
  const location = getLocationParts(place.address);
  selectedPlace.innerHTML = `
    <button class="detail-close" type="button" aria-label="Close place details">×</button>
    <div class="selected-tags">
      <span class="tag ${categoryClass(place.category)}">${escapeHtml(place.category)}</span>
      ${location.suburb ? `<span class="tag suburb">${escapeHtml(location.suburb)}</span>` : ""}
    </div>
    <h2>${escapeHtml(place.name)}</h2>
    <p class="selected-description">${escapeHtml(place.description)}</p>
    <p class="selected-address">
      <strong>Address</strong>
      ${escapeHtml(location.displayAddress)}
    </p>
    <a class="get-there" href="${googleMapsUrl(place)}" target="_blank" rel="noopener noreferrer">Get there</a>
  `;

  selectedPlace.querySelector(".detail-close").addEventListener("click", () => {
    clearSelectedPlace();
  });
}

function renderMarkers(filteredPlaces) {
  markerLayer.clearLayers();

  filteredPlaces.forEach((place) => {
    const marker = markersByPlace.get(place.id);
    if (marker) {
      markerLayer.addLayer(marker);
    }
  });
}

function renderList(filteredPlaces) {
  placeList.innerHTML = "";
  const fragment = document.createDocumentFragment();

  filteredPlaces.forEach((place) => {
    const meta = categoryMeta[place.category];
    const location = getLocationParts(place.address);
    const item = document.createElement("li");
    item.className = "place-card";
    item.classList.toggle("selected", place.id === selectedPlaceId);

    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `
      <img class="place-icon" src="${meta.icon}" alt="">
      <span class="place-content">
        <span class="place-category ${categoryClass(place.category)}">${escapeHtml(place.category)}</span>
        <span class="place-name">${escapeHtml(place.name)}</span>
        <span class="place-description">${escapeHtml(place.description)}</span>
        <span class="place-address">${escapeHtml(location.displayAddress)}</span>
      </span>
    `;

    button.addEventListener("click", () => {
      selectPlace(place, { openPopup: true, pan: true });
    });

    item.append(button);
    fragment.append(item);
  });

  placeList.append(fragment);
}

function updateResultCount(filteredPlaces) {
  const count = filteredPlaces.length;
  resultCount.textContent = `${count} ${count === 1 ? "place" : "places"} shown`;
}

function updateFilterButtons() {
  filterButtons.forEach((button) => {
    const category = button.dataset.category;
    const isActive = category === "all"
      ? activeCategories.size === Object.keys(categoryMeta).length
      : activeCategories.has(category);

    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function fitFilteredBounds(filteredPlaces) {
  if (filteredPlaces.length === 0) {
    map.setView(MELBOURNE_CENTER, 12);
    return;
  }

  const bounds = L.latLngBounds(filteredPlaces.map((place) => [place.lat, place.lng]));
  map.fitBounds(bounds, {
    maxZoom: 15,
    paddingTopLeft: [24, 24],
    paddingBottomRight: [24, 24],
  });
}

function refreshMapLayout({ fitBounds = false } = {}) {
  if (!map) {
    return;
  }

  shouldFitBoundsOnRefresh = shouldFitBoundsOnRefresh || fitBounds;

  if (mapRefreshFrame) {
    return;
  }

  mapRefreshFrame = window.requestAnimationFrame(() => {
    mapRefreshFrame = null;
    map.invalidateSize({ pan: false });

    if (shouldFitBoundsOnRefresh) {
      shouldFitBoundsOnRefresh = false;
      fitFilteredBounds(getFilteredPlaces());
      window.requestAnimationFrame(() => map.invalidateSize({ pan: false }));
    }
  });
}

function render({ fitBounds = false } = {}) {
  const filteredPlaces = getFilteredPlaces();
  const selectedPlaceInView = filteredPlaces.find((place) => place.id === selectedPlaceId);
  renderMarkers(filteredPlaces);
  renderList(filteredPlaces);
  updateResultCount(filteredPlaces);
  updateFilterButtons();
  renderSelectedPlace(selectedPlaceInView || places.find((place) => place.id === selectedPlaceId));

  refreshMapLayout({ fitBounds });
}

function selectPlace(place, { openPopup = false, pan = false } = {}) {
  selectedPlaceId = place.id;
  render();

  const marker = markersByPlace.get(place.id);
  if (pan) {
    map.flyTo([place.lat, place.lng], 17, { duration: 0.55 });
  }
  if (openPopup && marker) {
    marker.openPopup();
  }
}

function clearSelectedPlace() {
  selectedPlaceId = null;
  map.closePopup();
  render();
}

function setupFilters() {
  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const category = button.dataset.category;

      if (category === "all") {
        const allActive = activeCategories.size === Object.keys(categoryMeta).length;
        activeCategories.clear();
        if (!allActive) {
          Object.keys(categoryMeta).forEach((key) => activeCategories.add(key));
        }
      } else if (activeCategories.has(category)) {
        activeCategories.delete(category);
      } else {
        activeCategories.add(category);
      }

      render({ fitBounds: true });
    });
  });

  searchInput.addEventListener("input", () => render({ fitBounds: true }));
}

function setupMapResizeHandling() {
  const refresh = () => refreshMapLayout();

  window.addEventListener("load", refresh);
  window.addEventListener("resize", refresh);
  window.addEventListener("orientationchange", refresh);

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(refresh).catch(() => {});
  }

  if ("ResizeObserver" in window) {
    const resizeObserver = new ResizeObserver(refresh);
    resizeObserver.observe(mapElement);
    resizeObserver.observe(mapPanel);
  }

  refresh();
}

function setupMarkers() {
  places.forEach((place, index) => {
    place.id = `${place.name}-${place.address}-${index}`;

    const marker = L.marker([place.lat, place.lng], {
      icon: iconByCategory[place.category],
      title: place.name,
      riseOnHover: true,
    }).bindPopup(popupHtml(place));

    marker.on("click", () => {
      selectPlace(place, { openPopup: true });
    });

    markersByPlace.set(place.id, marker);
  });
}

async function loadPlaces() {
  if (Array.isArray(window.DOG_FRIENDLY_LOCATIONS)) {
    return window.DOG_FRIENDLY_LOCATIONS
      .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const response = await fetch("./data/locations.json");
  if (!response.ok) {
    throw new Error(`Could not load locations: ${response.status}`);
  }

  const data = await response.json();
  return data
    .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function init() {
  map = L.map("map", {
    fadeAnimation: false,
    zoomControl: false,
    preferCanvas: true,
  }).setView(MELBOURNE_CENTER, 12);

  L.control.zoom({
    position: "bottomright",
  }).addTo(map);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    fadeAnimation: false,
    maxZoom: 19,
    keepBuffer: 4,
    updateWhenIdle: false,
    updateWhenZooming: false,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  markerLayer.addTo(map);
  setupMapResizeHandling();

  places = await loadPlaces();
  setupMarkers();
  setupFilters();
  render({ fitBounds: true });
  [60, 180, 420, 900].forEach((delay) => {
    window.setTimeout(() => refreshMapLayout({ fitBounds: true }), delay);
  });
}

init().catch((error) => {
  console.error(error);
  resultCount.textContent = "Could not load map data.";
});
