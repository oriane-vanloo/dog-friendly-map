const MELBOURNE_CENTER = [-37.8108, 144.9631];
const POPULAR_SEARCHES_URL = "./data/popular-searches.json";
const LOCAL_SEARCH_STORAGE_KEY = "bringYourDogSearches";
const SEARCH_EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SEARCH_SUGGESTIONS = 3;

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
let popularSearches = [];
let selectedPlaceId = null;
let activeSearchInput = null;
let searchRecordTimer = null;

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
const selectedPlaceDefaultParent = selectedPlace.parentElement;
const selectedPlaceDefaultNextSibling = selectedPlace.nextSibling;
const filterButtons = [...document.querySelectorAll(".filter-button")];
const searchClearButtons = [...document.querySelectorAll("[data-clear-search]")];
const searchSuggestionPanels = [...document.querySelectorAll("[data-search-suggestions]")];
const mapElement = document.querySelector("#map");
const mapPanel = document.querySelector(".map-panel");
const mapExpandToggle = document.querySelector("#mapExpandToggle");
const expandedMapHome = document.querySelector("#expandedMapHome");
const expandedSearchInput = document.querySelector("#expandedSearch");
const expandedFilterToggle = document.querySelector("#expandedFilterToggle");
const expandedFilterBadge = document.querySelector("#expandedFilterBadge");
const expandedFilterSheet = document.querySelector("#expandedFilterSheet");
const appConfig = {
  googleMapsApiKey: "",
  useGooglePlacePhotos: true,
  googlePhotoSearch: true,
  googlePhotoMaxWidth: 720,
  googlePhotoMaxHeight: 420,
  ...(window.DOG_MAP_CONFIG || {}),
};
const manualPhotoOverrides = window.DOG_FRIENDLY_MANUAL_PHOTOS || {};
const googlePhotoCache = new Map();

let mapRefreshFrame = null;
let shouldFitBoundsOnRefresh = false;
let googleMapsScriptPromise = null;
let placesLibraryPromise = null;
let isMapExpanded = false;
let isExpandedFilterSheetOpen = false;
const mobileMapQuery = window.matchMedia("(max-width: 860px)");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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

function cleanSearchQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getSuburbPlaceCount(query) {
  const targetSuburb = cleanSearchQuery(query).toLowerCase();

  if (!targetSuburb) {
    return 0;
  }

  return places.filter((place) => {
    return getLocationParts(place.address).suburb.toLowerCase() === targetSuburb;
  }).length;
}

function getSuggestionPlaceCount(query) {
  const cleanedQuery = cleanSearchQuery(query);
  const suburbCount = getSuburbPlaceCount(cleanedQuery);

  if (suburbCount > 0) {
    return suburbCount;
  }

  return places.filter((place) => placeMatches(place, cleanedQuery)).length;
}

function hydrateSuggestionItem(item) {
  const placeCount = getSuggestionPlaceCount(item.query);

  if (placeCount < 1) {
    return null;
  }

  return {
    ...item,
    placeCount,
  };
}

function formatSuggestionCount(item) {
  const count = Number(item.placeCount) || getSuggestionPlaceCount(item.query);

  return `${count} ${count === 1 ? "place" : "places"}`;
}

function normalisePopularSearch(item) {
  const query = cleanSearchQuery(item?.query || item?.term || item?.label || item?.name);
  const count = Number(item?.count ?? item?.searches ?? item?.results ?? item?.places ?? 0);

  if (!query || !Number.isFinite(count) || count < 1) {
    return null;
  }

  return {
    query,
    count,
    metric: item?.metric || (item?.places ? "places" : "searches"),
  };
}

function readLocalSearchEvents() {
  try {
    const now = Date.now();
    const events = JSON.parse(localStorage.getItem(LOCAL_SEARCH_STORAGE_KEY) || "[]");

    return Array.isArray(events)
      ? events.filter((event) => {
        return cleanSearchQuery(event.query).length > 0 && now - Number(event.timestamp) <= SEARCH_EVENT_TTL_MS;
      })
      : [];
  } catch {
    return [];
  }
}

function writeLocalSearchEvents(events) {
  try {
    localStorage.setItem(LOCAL_SEARCH_STORAGE_KEY, JSON.stringify(events.slice(-100)));
  } catch {
    // Local storage can be unavailable in private browsing or locked-down browsers.
  }
}

function recordSearchQuery(value) {
  const query = cleanSearchQuery(value);

  if (query.length < 2) {
    return;
  }

  const events = readLocalSearchEvents();
  events.push({ query, timestamp: Date.now() });
  writeLocalSearchEvents(events);
}

function queueSearchRecord(value) {
  window.clearTimeout(searchRecordTimer);

  const query = cleanSearchQuery(value);
  if (query.length < 2) {
    return;
  }

  searchRecordTimer = window.setTimeout(() => {
    recordSearchQuery(query);
    renderSearchSuggestions();
  }, 900);
}

function getLocalPopularSearches() {
  const grouped = new Map();

  readLocalSearchEvents().forEach((event) => {
    const query = cleanSearchQuery(event.query);
    const key = query.toLowerCase();
    const current = grouped.get(key) || { query, count: 0, metric: "searches" };
    current.count += 1;
    grouped.set(key, current);
  });

  return [...grouped.values()].sort((a, b) => b.count - a.count || a.query.localeCompare(b.query));
}

function getPlaceCountSuggestions() {
  const grouped = new Map();

  places.forEach((place) => {
    const suburb = getLocationParts(place.address).suburb;
    if (!suburb) {
      return;
    }

    grouped.set(suburb, (grouped.get(suburb) || 0) + 1);
  });

  return [...grouped.entries()]
    .map(([query, count]) => ({ query, count, metric: "places" }))
    .sort((a, b) => b.count - a.count || a.query.localeCompare(b.query));
}

function getPopularSearchSuggestions(query) {
  const cleanedQuery = cleanSearchQuery(query).toLowerCase();
  const sources = [
    popularSearches,
    getLocalPopularSearches(),
    getPlaceCountSuggestions(),
  ];

  for (const source of sources) {
    if (source.length === 0) {
      continue;
    }

    const filtered = cleanedQuery
      ? source.filter((item) => item.query.toLowerCase().includes(cleanedQuery))
      : source;
    const hydratedSuggestions = filtered
      .map(hydrateSuggestionItem)
      .filter(Boolean);

    if (hydratedSuggestions.length > 0) {
      return hydratedSuggestions.slice(0, MAX_SEARCH_SUGGESTIONS);
    }
  }

  return [];
}

async function loadPopularSearches() {
  const configuredSearches = Array.isArray(window.DOG_FRIENDLY_POPULAR_SEARCHES)
    ? window.DOG_FRIENDLY_POPULAR_SEARCHES
    : null;

  if (configuredSearches) {
    return configuredSearches.map(normalisePopularSearch).filter(Boolean);
  }

  try {
    const response = await fetch(POPULAR_SEARCHES_URL, { cache: "no-store" });
    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return Array.isArray(data)
      ? data.map(normalisePopularSearch).filter(Boolean)
      : [];
  } catch {
    return [];
  }
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

function manualPhotoKey(place) {
  const location = getLocationParts(place.address);
  return slugify(`${place.name}-${location.suburb || place.address}`);
}

function googlePhotosEnabled() {
  return Boolean(appConfig.useGooglePlacePhotos && appConfig.googleMapsApiKey);
}

function normalisePhoto(photo, place) {
  if (!photo || !photo.src) {
    return null;
  }

  const attributions = Array.isArray(photo.attributions)
    ? photo.attributions
    : [{
      displayName: photo.credit || photo.source || "Photo",
      uri: photo.creditUrl || photo.url || "",
    }];

  return {
    src: photo.src,
    alt: photo.alt || `Photo of ${place.name}`,
    source: photo.source || "",
    providerUrl: photo.providerUrl || "",
    attributions: attributions
      .filter((attribution) => attribution && attribution.displayName)
      .map((attribution) => ({
        displayName: attribution.displayName,
        uri: attribution.uri || "",
      })),
  };
}

function getManualPhotos(place) {
  const overrideKeys = [place.id, manualPhotoKey(place), place.name].filter(Boolean);
  const overrides = overrideKeys.flatMap((key) => {
    const override = manualPhotoOverrides[key];
    if (Array.isArray(override)) {
      return override;
    }
    return override ? [override] : [];
  });
  const inlinePhotos = Array.isArray(place.photos) ? place.photos : [];

  return [...overrides, ...inlinePhotos]
    .map((photo) => normalisePhoto(photo, place))
    .filter(Boolean);
}

function attributionHtml(photo) {
  const authorLinks = photo.attributions.length
    ? photo.attributions.map((attribution) => {
      const name = escapeHtml(attribution.displayName);
      if (!attribution.uri) {
        return name;
      }

      return `<a href="${escapeHtml(attribution.uri)}" target="_blank" rel="noopener noreferrer">${name}</a>`;
    }).join(", ")
    : "Google Maps contributor";
  const source = photo.source
    ? `<span aria-hidden="true">·</span> ${photo.providerUrl ? `<a href="${escapeHtml(photo.providerUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(photo.source)}</a>` : escapeHtml(photo.source)}`
    : "";

  return `Photo: ${authorLinks} ${source}`;
}

function renderPlacePhoto(photo, place) {
  return `
    <figure class="place-photo is-loading">
      <img src="${escapeHtml(photo.src)}" alt="${escapeHtml(photo.alt || `Photo of ${place.name}`)}" loading="lazy" data-place-photo>
      <figcaption>${attributionHtml(photo)}</figcaption>
    </figure>
  `;
}

function renderPhotoPlaceholder(place) {
  return `
    <div class="place-photo place-photo-placeholder is-loading" data-photo-place-id="${escapeHtml(place.id)}">
      <span>Loading photo</span>
    </div>
  `;
}

function setupPhotoLoadState(container) {
  const image = container.querySelector("[data-place-photo]");
  if (!image) {
    return;
  }

  const showImage = () => {
    container.classList.remove("is-loading");
    container.classList.add("is-loaded");
  };
  const hideImage = () => {
    container.remove();
  };

  image.addEventListener("load", showImage, { once: true });
  image.addEventListener("error", hideImage, { once: true });

  if (image.complete) {
    if (image.naturalWidth > 0) {
      showImage();
    } else {
      hideImage();
    }
  }
}

function loadGoogleMapsScript() {
  if (window.google?.maps?.importLibrary) {
    return Promise.resolve();
  }

  if (!googleMapsScriptPromise) {
    googleMapsScriptPromise = new Promise((resolve, reject) => {
      window.__dogMapGoogleMapsReady = () => resolve();
      const script = document.createElement("script");
      const params = new URLSearchParams({
        key: appConfig.googleMapsApiKey,
        v: "weekly",
        loading: "async",
        callback: "__dogMapGoogleMapsReady",
      });

      script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
      script.async = true;
      script.onerror = () => reject(new Error("Could not load Google Maps JavaScript API."));
      document.head.append(script);
    });
  }

  return googleMapsScriptPromise;
}

async function getPlacesLibrary() {
  if (!placesLibraryPromise) {
    placesLibraryPromise = loadGoogleMapsScript().then(() => google.maps.importLibrary("places"));
  }

  return placesLibraryPromise;
}

async function fetchGooglePlacePhoto(place) {
  if (!googlePhotosEnabled()) {
    return null;
  }

  if (!googlePhotoCache.has(place.id)) {
    googlePhotoCache.set(place.id, (async () => {
      const { Place } = await getPlacesLibrary();
      const placeId = place.googlePlaceId || place.googleMapsPlaceId || place.placeId;
      let googlePlace = null;

      if (placeId) {
        googlePlace = new Place({ id: placeId });
        await googlePlace.fetchFields({ fields: ["displayName", "photos", "googleMapsURI"] });
      } else if (appConfig.googlePhotoSearch) {
        const response = await Place.searchByText({
          textQuery: `${place.name}, ${place.address}`,
          fields: ["id", "displayName", "photos", "googleMapsURI"],
          locationBias: {
            center: { lat: place.lat, lng: place.lng },
            radius: 450,
          },
          maxResultCount: 1,
          region: "au",
        });

        googlePlace = response.places?.[0] || null;
      }

      const photo = googlePlace?.photos?.[0];
      if (!photo) {
        return null;
      }

      const attributions = Array.isArray(photo.authorAttributions)
        ? photo.authorAttributions.map((attribution) => ({
          displayName: attribution.displayName || "Google Maps contributor",
          uri: attribution.uri || "",
        }))
        : [];

      return {
        src: photo.getURI({
          maxWidth: Number(appConfig.googlePhotoMaxWidth) || 720,
          maxHeight: Number(appConfig.googlePhotoMaxHeight) || 420,
        }),
        alt: `Photo of ${place.name}`,
        source: "Google Maps",
        providerUrl: googlePlace.googleMapsURI || googleMapsUrl(place),
        attributions,
      };
    })());
  }

  return googlePhotoCache.get(place.id);
}

async function hydrateSelectedPhoto(place) {
  const photoSlot = selectedPlace.querySelector(".place-photo-placeholder");
  if (!photoSlot || photoSlot.dataset.photoPlaceId !== place.id) {
    return;
  }

  try {
    const photo = await fetchGooglePlacePhoto(place);
    if (!selectedPlace.contains(photoSlot) || selectedPlace.classList.contains("is-empty") || selectedPlaceId !== place.id) {
      return;
    }

    if (!photo) {
      photoSlot.remove();
      return;
    }

    photoSlot.outerHTML = renderPlacePhoto(photo, place);
    const loadedPhoto = selectedPlace.querySelector(".place-photo");
    if (loadedPhoto) {
      setupPhotoLoadState(loadedPhoto);
    }
  } catch (error) {
    console.warn(`Could not load Google photo for ${place.name}`, error);
    if (selectedPlace.contains(photoSlot)) {
      photoSlot.remove();
    }
  }
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
      <a class="get-there" href="${googleMapsUrl(place)}" data-place-id="${escapeHtml(place.id)}" target="_blank" rel="noopener noreferrer">Get there</a>
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
  const manualPhoto = getManualPhotos(place)[0];
  const shouldLoadGooglePhoto = !manualPhoto && googlePhotosEnabled();
  const photoMarkup = manualPhoto
    ? renderPlacePhoto(manualPhoto, place)
    : shouldLoadGooglePhoto
      ? renderPhotoPlaceholder(place)
      : "";
  selectedPlace.innerHTML = `
    <button class="detail-close" type="button" aria-label="Close place details">
      <img src="./assets/icons/x-closeicon.svg" alt="">
    </button>
    <div class="selected-tags">
      <span class="tag ${categoryClass(place.category)}">${escapeHtml(place.category)}</span>
      ${location.suburb ? `<span class="tag suburb">${escapeHtml(location.suburb)}</span>` : ""}
    </div>
    ${photoMarkup}
    <h2>${escapeHtml(place.name)}</h2>
    <p class="selected-description">${escapeHtml(place.description)}</p>
    <p class="selected-address">
      <strong>Address</strong>
      ${escapeHtml(location.displayAddress)}
    </p>
    <a class="get-there" href="${googleMapsUrl(place)}" data-place-id="${escapeHtml(place.id)}" target="_blank" rel="noopener noreferrer">Get there</a>
  `;

  selectedPlace.querySelector(".detail-close").addEventListener("click", () => {
    clearSelectedPlace();
  });

  selectedPlace.querySelectorAll(".place-photo").forEach((photo) => setupPhotoLoadState(photo));

  if (shouldLoadGooglePhoto) {
    hydrateSelectedPhoto(place);
  }
}

function restoreSelectedPlacePosition() {
  selectedPlaceDefaultParent.insertBefore(selectedPlace, selectedPlaceDefaultNextSibling);
  placeList.querySelectorAll(".selected-place-inline").forEach((slot) => slot.remove());
}

function positionSelectedPlace(selectedPlaceInView) {
  if (!mobileMapQuery.matches || isMapExpanded || !selectedPlaceInView) {
    restoreSelectedPlacePosition();
    return;
  }

  const selectedCard = placeList.querySelector(".place-card.selected");
  if (!selectedCard) {
    restoreSelectedPlacePosition();
    return;
  }

  let inlineSlot = placeList.querySelector(".selected-place-inline");
  if (!inlineSlot) {
    inlineSlot = document.createElement("li");
    inlineSlot.className = "selected-place-inline";
  }

  selectedCard.after(inlineSlot);
  inlineSlot.append(selectedPlace);
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
    item.dataset.placeId = place.id;
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
  const categoryCount = Object.keys(categoryMeta).length;

  filterButtons.forEach((button) => {
    const category = button.dataset.category;
    const isActive = category === "all"
      ? activeCategories.size === categoryCount
      : activeCategories.has(category);

    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });

  if (expandedFilterBadge && expandedFilterToggle) {
    const hasAppliedFilters = activeCategories.size !== categoryCount;
    expandedFilterBadge.hidden = !hasAppliedFilters;
    expandedFilterBadge.textContent = hasAppliedFilters ? String(activeCategories.size) : "";
    expandedFilterToggle.setAttribute(
      "aria-label",
      hasAppliedFilters
        ? `Filter categories, ${activeCategories.size} ${activeCategories.size === 1 ? "category" : "categories"} active`
        : "Filter categories"
    );
  }
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
  positionSelectedPlace(selectedPlaceInView);

  refreshMapLayout({ fitBounds });
}

function shouldUseBottomSheet() {
  return mobileMapQuery.matches;
}

function selectPlace(place, { openPopup = false, pan = false } = {}) {
  selectedPlaceId = place.id;
  render();

  const marker = markersByPlace.get(place.id);
  if (pan) {
    map.flyTo([place.lat, place.lng], 17, { duration: 0.55 });
  }
  if (shouldUseBottomSheet()) {
    map.closePopup();
  } else if (openPopup && marker) {
    marker.openPopup();
  }
}

function clearSelectedPlace() {
  selectedPlaceId = null;
  map.closePopup();
  render();
}

function setMapInteractivity(enabled) {
  if (!map) {
    return;
  }

  const method = enabled ? "enable" : "disable";
  [
    map.dragging,
    map.touchZoom,
    map.doubleClickZoom,
    map.scrollWheelZoom,
    map.boxZoom,
    map.keyboard,
  ].forEach((handler) => {
    if (handler && typeof handler[method] === "function") {
      handler[method]();
    }
  });

  if (map.tap && typeof map.tap[method] === "function") {
    map.tap[method]();
  }
}

function syncSearchInputs(sourceInput) {
  const nextValue = sourceInput.value;

  if (searchInput !== sourceInput) {
    searchInput.value = nextValue;
  }
  if (expandedSearchInput && expandedSearchInput !== sourceInput) {
    expandedSearchInput.value = nextValue;
  }

  updateSearchClearButtons();
}

function getSuggestionsPanelForInput(input) {
  if (input === expandedSearchInput) {
    return document.querySelector("#expandedSearchSuggestions");
  }

  return document.querySelector("#searchSuggestions");
}

function hideSearchSuggestions() {
  activeSearchInput = null;
  searchSuggestionPanels.forEach((panel) => {
    panel.hidden = true;
  });
}

function renderSearchSuggestions() {
  searchSuggestionPanels.forEach((panel) => {
    panel.hidden = true;
  });

  if (!activeSearchInput) {
    return;
  }

  const panel = getSuggestionsPanelForInput(activeSearchInput);
  const list = panel?.querySelector(".search-suggestions-list");
  if (!panel || !list) {
    return;
  }

  const suggestions = getPopularSearchSuggestions(activeSearchInput.value);
  if (suggestions.length === 0) {
    panel.hidden = true;
    list.innerHTML = "";
    return;
  }

  list.innerHTML = suggestions.map((item) => {
    return `
      <button class="search-suggestion-item" type="button" data-query="${escapeHtml(item.query)}" role="option">
        <span class="search-suggestion-query">${escapeHtml(item.query)}</span>
        <span class="search-suggestion-count">${escapeHtml(formatSuggestionCount(item))}</span>
      </button>
    `;
  }).join("");
  panel.hidden = false;
}

function showSearchSuggestions(input) {
  activeSearchInput = input;
  renderSearchSuggestions();
}

function applySearchSuggestion(query) {
  const inputToFocus = activeSearchInput || searchInput;

  searchInput.value = query;
  if (expandedSearchInput) {
    expandedSearchInput.value = query;
  }

  recordSearchQuery(query);
  updateSearchClearButtons();
  hideSearchSuggestions();
  render({ fitBounds: true });

  inputToFocus?.focus();
}

function updateSearchClearButtons() {
  const hasSearchValue = searchInput.value.length > 0;

  searchClearButtons.forEach((button) => {
    button.hidden = !hasSearchValue;
  });
}

function setExpandedFilterSheet(open) {
  const shouldOpen = Boolean(open) && mobileMapQuery.matches && isMapExpanded;

  isExpandedFilterSheetOpen = shouldOpen;
  mapPanel.classList.toggle("filter-sheet-open", shouldOpen);

  if (expandedFilterToggle) {
    expandedFilterToggle.setAttribute("aria-expanded", String(shouldOpen));
  }
  if (expandedFilterSheet) {
    expandedFilterSheet.hidden = !shouldOpen;
  }
}

function updateMobileMapState({ fitBounds = false } = {}) {
  const isMobile = mobileMapQuery.matches;
  const shouldExpandMap = isMobile && isMapExpanded;

  mapPanel.classList.toggle("is-expanded", shouldExpandMap);
  document.body.classList.toggle("map-expanded", shouldExpandMap);

  if (expandedSearchInput) {
    expandedSearchInput.value = searchInput.value;
  }
  updateSearchClearButtons();

  if (!shouldExpandMap) {
    setExpandedFilterSheet(false);
  } else {
    setExpandedFilterSheet(isExpandedFilterSheetOpen);
  }

  mapExpandToggle.hidden = !isMobile;
  mapExpandToggle.setAttribute("aria-expanded", String(shouldExpandMap));
  mapExpandToggle.setAttribute("aria-label", shouldExpandMap ? "Collapse map" : "Expand map");
  mapExpandToggle.querySelector(".map-expand-symbol").innerHTML = shouldExpandMap
    ? '<img src="./assets/icons/x-closeicon.svg" alt="">'
    : '<img src="./assets/icons/expandicon.svg" alt="">';

  if (!shouldExpandMap) {
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
  }

  positionSelectedPlace(getFilteredPlaces().find((place) => place.id === selectedPlaceId));
  setMapInteractivity(true);
  refreshMapLayout({ fitBounds });
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

  const handleSearchInput = (event) => {
    syncSearchInputs(event.currentTarget);
    queueSearchRecord(event.currentTarget.value);
    render({ fitBounds: true });
    showSearchSuggestions(event.currentTarget);
  };

  searchInput.addEventListener("input", handleSearchInput);
  if (expandedSearchInput) {
    expandedSearchInput.addEventListener("input", handleSearchInput);
  }

  searchClearButtons.forEach((button) => {
    button.addEventListener("click", () => {
      window.clearTimeout(searchRecordTimer);
      searchInput.value = "";
      if (expandedSearchInput) {
        expandedSearchInput.value = "";
      }

      updateSearchClearButtons();
      render({ fitBounds: true });

      const inputToFocus = button.closest(".expanded-search-wrap")
        ? expandedSearchInput
        : searchInput;
      showSearchSuggestions(inputToFocus);
      inputToFocus?.focus();
    });
  });

  updateSearchClearButtons();
}

function setupSearchSuggestions() {
  [searchInput, expandedSearchInput].filter(Boolean).forEach((input) => {
    input.addEventListener("focus", () => showSearchSuggestions(input));
    input.addEventListener("click", () => showSearchSuggestions(input));
  });

  searchSuggestionPanels.forEach((panel) => {
    panel.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });

    panel.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      const item = event.target.closest(".search-suggestion-item");
      if (!item) {
        return;
      }

      applySearchSuggestion(item.dataset.query || "");
    });
  });

  document.addEventListener("pointerdown", (event) => {
    if (!activeSearchInput || !(event.target instanceof Element)) {
      return;
    }

    if (event.target.closest(".search-wrap, .expanded-search-wrap")) {
      return;
    }

    hideSearchSuggestions();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activeSearchInput) {
      hideSearchSuggestions();
    }
  });
}

function setupMobileMapToggle() {
  mapExpandToggle.addEventListener("click", () => {
    const wasExpanded = isMapExpanded;
    isMapExpanded = !isMapExpanded;
    updateMobileMapState({ fitBounds: true });
    if (wasExpanded && !isMapExpanded) {
      mapPanel.scrollIntoView({ block: "start" });
    }
  });

  if (expandedMapHome) {
    expandedMapHome.addEventListener("click", () => {
      isMapExpanded = false;
      setExpandedFilterSheet(false);
      updateMobileMapState({ fitBounds: true });
      mapPanel.scrollIntoView({ block: "start" });
    });
  }

  if (expandedFilterToggle) {
    expandedFilterToggle.addEventListener("click", () => {
      setExpandedFilterSheet(!isExpandedFilterSheetOpen);
    });
  }

  const onMobileStateChange = () => {
    if (!mobileMapQuery.matches) {
      isMapExpanded = false;
      setExpandedFilterSheet(false);
    }
    updateMobileMapState({ fitBounds: true });
  };

  if (typeof mobileMapQuery.addEventListener === "function") {
    mobileMapQuery.addEventListener("change", onMobileStateChange);
  } else if (typeof mobileMapQuery.addListener === "function") {
    mobileMapQuery.addListener(onMobileStateChange);
  }

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    if (activeSearchInput) {
      return;
    }

    if (isExpandedFilterSheetOpen) {
      setExpandedFilterSheet(false);
      return;
    }

    if (isMapExpanded) {
      isMapExpanded = false;
      updateMobileMapState({ fitBounds: true });
    }
  });

  updateMobileMapState({ fitBounds: true });
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
      selectPlace(place, { openPopup: !shouldUseBottomSheet() });
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
  map.attributionControl.setPrefix(false);

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
  setupMobileMapToggle();

  [places, popularSearches] = await Promise.all([
    loadPlaces(),
    loadPopularSearches(),
  ]);
  setupMarkers();
  setupFilters();
  setupSearchSuggestions();
  render({ fitBounds: true });
  [60, 180, 420, 900].forEach((delay) => {
    window.setTimeout(() => refreshMapLayout({ fitBounds: true }), delay);
  });
}

init().catch((error) => {
  console.error(error);
  resultCount.textContent = "Could not load map data.";
});
