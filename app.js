const MELBOURNE_CENTER = [-37.8108, 144.9631];
const LOCAL_SEARCH_STORAGE_KEY = "bringYourDogSearches";
const SEARCH_EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SEARCH_SUGGESTIONS = 3;
const SEARCH_ANALYTICS_DEBOUNCE_MS = 900;

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
let activeSearchInput = null;

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
const sidebar = document.querySelector(".sidebar");
const mapElement = document.querySelector("#map");
const mapPanel = document.querySelector(".map-panel");
const mapExpandToggle = document.querySelector("#mapExpandToggle");
const mapLocateToggle = document.querySelector("#mapLocateToggle");
const desktopZoomIn = document.querySelector("#desktopZoomIn");
const desktopZoomOut = document.querySelector("#desktopZoomOut");
const expandedMapHome = document.querySelector("#expandedMapHome");
const expandedSearchInput = document.querySelector("#expandedSearch");
const expandedFilterToggle = document.querySelector("#expandedFilterToggle");
const expandedFilterBadge = document.querySelector("#expandedFilterBadge");
const expandedFilterSheet = document.querySelector("#expandedFilterSheet");
const appConfig = {
  googleAnalyticsMeasurementId: "",
  googleMapsApiKey: "",
  useGooglePlacePhotos: true,
  googlePhotoSearch: true,
  googlePhotoMaxWidth: 720,
  googlePhotoMaxHeight: 420,
  ...(window.DOG_MAP_CONFIG || {}),
};
const analyticsMeasurementId = String(appConfig.googleAnalyticsMeasurementId || appConfig.gaMeasurementId || "").trim();
const manualPhotoOverrides = window.DOG_FRIENDLY_MANUAL_PHOTOS || {};
const googlePhotoCache = new Map();

let mapRefreshFrame = null;
let shouldFitBoundsOnRefresh = false;
let googleMapsScriptPromise = null;
let placesLibraryPromise = null;
let userLocationMarker = null;
let userLocationAccuracy = null;
let isMapExpanded = false;
let isExpandedFilterSheetOpen = false;
let searchAnalyticsTimeout = null;
let lockedScrollY = 0;
let lastAutoFittedSuburb = "";
const mobileMapQuery = window.matchMedia("(max-width: 860px)");

function initAnalytics() {
  if (!/^G-[A-Z0-9]+$/i.test(analyticsMeasurementId)) {
    return;
  }

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() {
    window.dataLayer.push(arguments);
  };

  window.gtag("js", new Date());
  window.gtag("config", analyticsMeasurementId, {
    page_title: document.title,
    page_path: window.location.pathname || "/",
  });

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(analyticsMeasurementId)}`;
  document.head.append(script);
}

function trackEvent(name, params = {}) {
  if (!window.gtag || !analyticsMeasurementId) {
    return;
  }

  window.gtag("event", name, {
    app_name: "bring_your_dog",
    ...params,
  });
}

function searchSurfaceForInput(input) {
  return input === expandedSearchInput ? "expanded_map" : "main";
}

function currentMapSurface() {
  if (isMapExpanded) {
    return "expanded_map";
  }

  return shouldUseBottomSheet() ? "mobile_home" : "desktop";
}

function placeAnalyticsParams(place) {
  const location = getLocationParts(place.address);

  return {
    place_name: place.name,
    place_category: place.category,
    suburb: location.suburb || "",
    has_instagram: Boolean(place.instagramUrl),
  };
}

function trackSearch(query, source, extraParams = {}) {
  const searchTerm = cleanSearchQuery(query);

  if (!searchTerm) {
    return;
  }

  trackEvent("search", {
    search_term: searchTerm,
    search_surface: source,
    result_count: getFilteredPlaces().length,
    ...extraParams,
  });
}

function queueSearchTracking(input) {
  window.clearTimeout(searchAnalyticsTimeout);
  searchAnalyticsTimeout = window.setTimeout(() => {
    trackSearch(input.value, searchSurfaceForInput(input), {
      search_method: "typed",
    });
  }, SEARCH_ANALYTICS_DEBOUNCE_MS);
}

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

function getExactSearchSuburb(query) {
  const targetSuburb = cleanSearchQuery(query).toLowerCase();

  if (!targetSuburb) {
    return "";
  }

  return suburbs.find((suburb) => suburb.toLowerCase() === targetSuburb) || "";
}

function shouldFitSearchQuery(query) {
  const searchSuburb = getExactSearchSuburb(query);

  if (!searchSuburb) {
    lastAutoFittedSuburb = "";
    return false;
  }

  if (searchSuburb === lastAutoFittedSuburb) {
    return false;
  }

  lastAutoFittedSuburb = searchSuburb;
  return true;
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

function highlightSuggestionMatch(value, query) {
  const label = String(value || "");
  const cleanedQuery = cleanSearchQuery(query);

  if (!cleanedQuery) {
    return escapeHtml(label);
  }

  const startIndex = label.toLowerCase().indexOf(cleanedQuery.toLowerCase());
  if (startIndex < 0) {
    return escapeHtml(label);
  }

  const before = label.slice(0, startIndex);
  const match = label.slice(startIndex, startIndex + cleanedQuery.length);
  const after = label.slice(startIndex + cleanedQuery.length);

  return `${escapeHtml(before)}<span class="search-suggestion-match">${escapeHtml(match)}</span>${escapeHtml(after)}`;
}

function formatSuggestionCount(item) {
  const count = Number(item.placeCount) || getSuggestionPlaceCount(item.query);

  return `${count} ${count === 1 ? "place" : "places"}`;
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
  const canonicalSuggestion = getCanonicalPlaceSuggestion(value);

  if (!canonicalSuggestion) {
    return;
  }

  const events = readLocalSearchEvents();
  events.push({ query: canonicalSuggestion.query, timestamp: Date.now() });
  writeLocalSearchEvents(events);
}

function getLocalPopularSearches() {
  const grouped = new Map();

  readLocalSearchEvents().forEach((event) => {
    const canonicalSuggestion = getCanonicalPlaceSuggestion(event.query);
    if (!canonicalSuggestion) {
      return;
    }

    const key = canonicalSuggestion.query.toLowerCase();
    const current = grouped.get(key) || {
      query: canonicalSuggestion.query,
      count: 0,
      metric: "places",
      placeCount: canonicalSuggestion.placeCount,
    };
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

function getCanonicalPlaceSuggestion(value) {
  const cleanedQuery = cleanSearchQuery(value);
  const queryKey = cleanedQuery.toLowerCase();

  if (!queryKey) {
    return null;
  }

  const suburbSuggestion = getPlaceCountSuggestions().find((item) => {
    return item.query.toLowerCase() === queryKey;
  });
  if (suburbSuggestion) {
    return hydrateSuggestionItem(suburbSuggestion);
  }

  const place = places.find((item) => item.name.toLowerCase() === queryKey);
  if (!place) {
    return null;
  }

  return {
    query: place.name,
    count: 1,
    metric: "places",
    placeCount: 1,
  };
}

function toCanonicalPopularSuggestion(item) {
  const canonicalSuggestion = getCanonicalPlaceSuggestion(item.query);

  if (!canonicalSuggestion) {
    return null;
  }

  return {
    ...item,
    query: canonicalSuggestion.query,
    metric: "places",
    placeCount: canonicalSuggestion.placeCount,
  };
}

function uniqueSuggestionsByQuery(items) {
  const seen = new Set();

  return items.filter((item) => {
    const key = item.query.toLowerCase();
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function getPopularSearchSuggestions(query) {
  const cleanedQuery = cleanSearchQuery(query).toLowerCase();
  const filtered = cleanedQuery
    ? getLocalPopularSearches().filter((item) => item.query.toLowerCase().includes(cleanedQuery))
    : getLocalPopularSearches();

  return uniqueSuggestionsByQuery(
    filtered
      .map(toCanonicalPopularSuggestion)
      .filter(Boolean)
  ).slice(0, MAX_SEARCH_SUGGESTIONS);
}

function getTypedSearchSuggestions(query) {
  const cleanedQuery = cleanSearchQuery(query).toLowerCase();

  if (!cleanedQuery) {
    return [];
  }

  return getPlaceCountSuggestions()
    .filter((item) => item.query.toLowerCase().includes(cleanedQuery))
    .map(hydrateSuggestionItem)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_SUGGESTIONS);
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

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
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
  const instagramMarkup = instagramActionHtml(place);

  return `
    <article class="popup">
      <div class="popup-tags">
        <span class="category ${categoryClass(place.category)}">${escapeHtml(place.category)}</span>
        ${location.suburb ? `<span class="category suburb">${escapeHtml(location.suburb)}</span>` : ""}
      </div>
      <h2>${escapeHtml(place.name)}</h2>
      <p>${escapeHtml(place.description)}</p>
      <p><span class="address-label">Address</span>${escapeHtml(location.displayAddress)}</p>
      <div class="place-actions">
        <a class="get-there" href="${googleMapsUrl(place)}" data-place-id="${escapeHtml(place.id)}" target="_blank" rel="noopener noreferrer">Get there</a>
        ${instagramMarkup}
      </div>
    </article>
  `;
}

function instagramActionHtml(place) {
  const instagramUrl = safeExternalUrl(place.instagramUrl);

  if (!instagramUrl) {
    return "";
  }

  return `
    <a class="place-instagram-link" href="${escapeHtml(instagramUrl)}" data-place-id="${escapeHtml(place.id)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(`${place.name} on Instagram`)}">
      ${instagramIconHtml()}
      <span>Instagram</span>
    </a>
  `;
}

function instagramIconHtml() {
  return `
    <svg class="instagram-link-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill-rule="evenodd" clip-rule="evenodd" d="M11.9999 6.59961C9.01846 6.59961 6.59961 9.01846 6.59961 11.9999C6.59961 14.9814 9.01846 17.4003 11.9999 17.4003C14.9814 17.4003 17.4003 14.9814 17.4003 11.9999C17.4003 9.01846 14.9814 6.59961 11.9999 6.59961ZM11.9999 15.503C10.0657 15.503 8.49691 13.9342 8.49691 11.9999C8.49691 10.0657 10.0657 8.49691 11.9999 8.49691C13.9342 8.49691 15.503 10.0657 15.503 11.9999C15.503 13.9342 13.9342 15.503 11.9999 15.503Z" />
      <path d="M17.6123 7.64653C18.3064 7.64653 18.8731 7.08391 18.8731 6.38576C18.8731 5.69173 18.3064 5.125 17.6123 5.125C16.9183 5.125 16.3516 5.68762 16.3516 6.38576C16.3516 7.0798 16.9142 7.64653 17.6123 7.64653Z" />
      <path fill-rule="evenodd" clip-rule="evenodd" d="M11.9995 1.48633C9.14535 1.48633 8.78807 1.49865 7.66693 1.54793C6.54991 1.59721 5.78195 1.7779 5.11666 2.03663C4.42263 2.30767 3.83537 2.66496 3.25222 3.25222C2.66496 3.83537 2.30767 4.42263 2.03663 5.11256C1.7779 5.78195 1.59721 6.5458 1.54793 7.66283C1.49865 8.78807 1.48633 9.14535 1.48633 11.9995C1.48633 14.8537 1.49865 15.211 1.54793 16.3321C1.59721 17.4491 1.7779 18.2171 2.03663 18.8824C2.30767 19.5764 2.66496 20.1637 3.25222 20.7468C3.83537 21.33 4.42263 21.6914 5.11256 21.9583C5.78195 22.217 6.5458 22.3977 7.66283 22.447C8.78396 22.4963 9.14124 22.5086 11.9954 22.5086C14.8496 22.5086 15.2069 22.4963 16.328 22.447C17.445 22.3977 18.213 22.217 18.8783 21.9583C19.5682 21.6914 20.1555 21.33 20.7386 20.7468C21.3218 20.1637 21.6832 19.5764 21.9501 18.8865C22.2088 18.2171 22.3895 17.4532 22.4388 16.3362C22.4881 15.2151 22.5004 14.8578 22.5004 12.0036C22.5004 9.14946 22.4881 8.79217 22.4388 7.67104C22.3895 6.55401 22.2088 5.78606 21.9501 5.12077C21.6914 4.42263 21.3341 3.83537 20.7468 3.25222C20.1637 2.66906 19.5764 2.30767 18.8865 2.04073C18.2171 1.78201 17.4532 1.60132 16.3362 1.55204C15.211 1.49865 14.8537 1.48633 11.9995 1.48633ZM11.9995 3.37952C14.8085 3.37952 15.1412 3.39184 16.2459 3.44112C17.2725 3.4863 17.8269 3.65878 18.1966 3.80252C18.6853 3.99142 19.0384 4.2214 19.4039 4.5869C19.7735 4.9565 19.9994 5.30557 20.1883 5.79427C20.332 6.16388 20.5045 6.72239 20.5497 7.74496C20.599 8.85377 20.6113 9.18642 20.6113 11.9913C20.6113 14.8003 20.599 15.1329 20.5497 16.2376C20.5045 17.2643 20.332 17.8187 20.1883 18.1883C19.9994 18.677 19.7694 19.0302 19.4039 19.3957C19.0343 19.7653 18.6853 19.9912 18.1966 20.1801C17.8269 20.3238 17.2684 20.4963 16.2459 20.5415C15.137 20.5908 14.8044 20.6031 11.9995 20.6031C9.19053 20.6031 8.85788 20.5908 7.75318 20.5415C6.7265 20.4963 6.17209 20.3238 5.80249 20.1801C5.31379 19.9912 4.96061 19.7612 4.59511 19.3957C4.22551 19.0261 3.99964 18.677 3.81073 18.1883C3.66699 17.8187 3.49451 17.2602 3.44934 16.2376C3.40006 15.1288 3.38774 14.7962 3.38774 11.9913C3.38774 9.18231 3.40006 8.84967 3.44934 7.74496C3.49451 6.71828 3.66699 6.16388 3.81073 5.79427C3.99964 5.30557 4.22961 4.9524 4.59511 4.5869C4.96472 4.21729 5.31379 3.99142 5.80249 3.80252C6.17209 3.65878 6.7306 3.4863 7.75318 3.44112C8.85788 3.39184 9.19053 3.37952 11.9995 3.37952Z" />
    </svg>
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
  const instagramMarkup = instagramActionHtml(place);
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
    <div class="place-actions">
      <a class="get-there" href="${googleMapsUrl(place)}" data-place-id="${escapeHtml(place.id)}" target="_blank" rel="noopener noreferrer">Get there</a>
      ${instagramMarkup}
    </div>
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
  if (mobileMapQuery.matches && isMapExpanded) {
    placeList.querySelectorAll(".selected-place-inline").forEach((slot) => slot.remove());
    mapPanel.append(selectedPlace);
    return;
  }

  if (!mobileMapQuery.matches || !selectedPlaceInView) {
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
      selectPlace(place, { openPopup: true, pan: true, source: "list_card" });
    });

    item.append(button);
    fragment.append(item);
  });

  const contactItem = document.createElement("li");
  contactItem.className = "list-contact-card";
  contactItem.innerHTML = `
    <p class="contact-copy">
      <span>Know a dog-friendly business not listed here?</span>
      <span class="contact-action">
        Reach out to
        <a href="https://www.instagram.com/kirathesmol" target="_blank" rel="noopener noreferrer" data-analytics-link="kira-instagram">
          ${instagramIconHtml()}
          <span>kirathesmol</span>
        </a>
      </span>
    </p>
    <p class="contact-copyright">
      © Designed with 💖 by
      <a href="http://orianevanloo.site/" target="_blank" rel="noopener noreferrer" data-analytics-link="portfolio-website">Oriane Van Loo</a>
    </p>
  `;
  fragment.append(contactItem);

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
  renderMarkers(filteredPlaces);
  renderList(filteredPlaces);
  updateResultCount(filteredPlaces);
  updateFilterButtons();
  syncSelectedPlacePanel();

  refreshMapLayout({ fitBounds });
}

function shouldUseBottomSheet() {
  return mobileMapQuery.matches;
}

function updatePlaceListSelection() {
  placeList.querySelectorAll(".place-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.placeId === selectedPlaceId);
  });
}

function syncSelectedPlacePanel() {
  const selectedPlaceInView = getFilteredPlaces().find((place) => place.id === selectedPlaceId);

  if (shouldUseBottomSheet()) {
    renderSelectedPlace(selectedPlaceInView || places.find((place) => place.id === selectedPlaceId));
    positionSelectedPlace(selectedPlaceInView);
  } else {
    restoreSelectedPlacePosition();
    renderSelectedPlace(null);
  }
}

function keepSelectedCardVisible({ behavior = "smooth" } = {}) {
  if (!selectedPlaceId || isMapExpanded) {
    return;
  }

  const selectedCard = placeList.querySelector(".place-card.selected");
  if (!selectedCard) {
    return;
  }

  const cardRect = selectedCard.getBoundingClientRect();
  const padding = 16;

  if (mobileMapQuery.matches) {
    const topLimit = padding;
    const bottomLimit = window.innerHeight - padding;

    if (cardRect.top < topLimit || cardRect.bottom > bottomLimit) {
      selectedCard.scrollIntoView({ behavior, block: "nearest" });
    }
    return;
  }

  const listRect = placeList.getBoundingClientRect();
  const topLimit = listRect.top + padding;
  const bottomLimit = listRect.bottom - padding;

  if (cardRect.top < topLimit) {
    placeList.scrollBy({
      top: cardRect.top - topLimit,
      behavior,
    });
  } else if (cardRect.bottom > bottomLimit) {
    placeList.scrollBy({
      top: cardRect.bottom - bottomLimit,
      behavior,
    });
  }
}

function selectPlace(place, { openPopup = false, pan = false, source = "unknown" } = {}) {
  selectedPlaceId = place.id;
  updatePlaceListSelection();
  syncSelectedPlacePanel();
  trackEvent("place_select", {
    ...placeAnalyticsParams(place),
    selection_source: source,
    map_surface: currentMapSurface(),
  });

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
  updatePlaceListSelection();
  syncSelectedPlacePanel();
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
  const title = panel?.querySelector(".search-suggestions-title");
  if (!panel || !list) {
    return;
  }

  const searchValue = activeSearchInput.value;
  const isTypedSearch = cleanSearchQuery(searchValue).length > 0;
  const suggestions = isTypedSearch
    ? getTypedSearchSuggestions(searchValue)
    : getPopularSearchSuggestions(searchValue);
  if (suggestions.length === 0) {
    panel.hidden = true;
    list.innerHTML = "";
    return;
  }

  panel.classList.toggle("is-typed", isTypedSearch);
  if (title) {
    title.hidden = isTypedSearch;
  }

  list.innerHTML = suggestions.map((item) => {
    return `
      <button class="search-suggestion-item" type="button" data-query="${escapeHtml(item.query)}" role="option">
        <span class="search-suggestion-query">${highlightSuggestionMatch(item.query, isTypedSearch ? searchValue : "")}</span>
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
  const isTypedSearch = cleanSearchQuery(inputToFocus?.value).length > 0;

  window.clearTimeout(searchAnalyticsTimeout);
  searchInput.value = query;
  if (expandedSearchInput) {
    expandedSearchInput.value = query;
  }

  recordSearchQuery(query);
  updateSearchClearButtons();
  hideSearchSuggestions();
  render({ fitBounds: shouldFitSearchQuery(query) });
  trackEvent("search_suggestion_click", {
    search_term: query,
    suggestion_type: isTypedSearch ? "typed" : "recent",
    search_surface: searchSurfaceForInput(inputToFocus),
    place_count: getSuggestionPlaceCount(query),
  });
  trackSearch(query, searchSurfaceForInput(inputToFocus), {
    search_method: "suggestion",
  });

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

function setPageScrollLock(locked) {
  if (locked) {
    if (document.body.style.position === "fixed") {
      return;
    }

    lockedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${lockedScrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
    return;
  }

  const scrollY = lockedScrollY;
  document.documentElement.style.overflow = "";
  document.body.style.overflow = "";
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  document.body.style.width = "";
  lockedScrollY = 0;
  window.scrollTo(0, scrollY);
}

function updateMobileMapState({ fitBounds = false } = {}) {
  const isMobile = mobileMapQuery.matches;
  const shouldExpandMap = isMobile && isMapExpanded;

  mapPanel.classList.toggle("is-expanded", shouldExpandMap);
  document.body.classList.toggle("map-expanded", shouldExpandMap);
  document.documentElement.classList.toggle("map-expanded", shouldExpandMap);

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

  setPageScrollLock(shouldExpandMap);

  syncSelectedPlacePanel();
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

      trackEvent("filter_toggle", {
        category,
        enabled: activeCategories.has(category),
        active_category_count: activeCategories.size,
        filter_surface: currentMapSurface(),
      });
      render();
      keepSelectedCardVisible();
    });
  });

  const handleSearchInput = (event) => {
    syncSearchInputs(event.currentTarget);
    if (!shouldUseBottomSheet() && selectedPlaceId && cleanSearchQuery(searchInput.value)) {
      selectedPlaceId = null;
      map.closePopup();
    }
    render({ fitBounds: shouldFitSearchQuery(searchInput.value) });
    showSearchSuggestions(event.currentTarget);
    queueSearchTracking(event.currentTarget);
  };

  searchInput.addEventListener("input", handleSearchInput);
  if (expandedSearchInput) {
    expandedSearchInput.addEventListener("input", handleSearchInput);
  }

  searchClearButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const inputToFocus = button.closest(".expanded-search-wrap")
        ? expandedSearchInput
        : searchInput;
      trackEvent("search_clear", {
        search_surface: searchSurfaceForInput(inputToFocus || searchInput),
      });

      window.clearTimeout(searchAnalyticsTimeout);
      searchInput.value = "";
      if (expandedSearchInput) {
        expandedSearchInput.value = "";
      }

      updateSearchClearButtons();
      lastAutoFittedSuburb = "";
      render();

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

function setupDesktopSidebarGutterScroll() {
  if (!sidebar || !placeList) {
    return;
  }

  sidebar.addEventListener("wheel", (event) => {
    if (mobileMapQuery.matches || !(event.target instanceof Element) || event.target.closest(".place-list")) {
      return;
    }

    const listRect = placeList.getBoundingClientRect();
    const isBesideList = event.clientY >= listRect.top && event.clientY <= listRect.bottom;
    const canScrollDown = event.deltaY > 0 && placeList.scrollTop + placeList.clientHeight < placeList.scrollHeight;
    const canScrollUp = event.deltaY < 0 && placeList.scrollTop > 0;

    if (!isBesideList || (!canScrollDown && !canScrollUp)) {
      return;
    }

    event.preventDefault();
    placeList.scrollBy({
      top: event.deltaY,
      left: event.deltaX,
    });
  }, { passive: false });
}

function setupActionTracking() {
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    const getThereLink = event.target.closest(".get-there[data-place-id]");
    if (getThereLink) {
      const place = places.find((item) => item.id === getThereLink.dataset.placeId);
      if (place) {
        trackEvent("google_maps_open", {
          ...placeAnalyticsParams(place),
          link_surface: currentMapSurface(),
          link_url: getThereLink.href,
        });
      }
      return;
    }

    const placeInstagramLink = event.target.closest(".place-instagram-link[data-place-id]");
    if (placeInstagramLink) {
      const place = places.find((item) => item.id === placeInstagramLink.dataset.placeId);
      if (place) {
        trackEvent("business_instagram_open", {
          ...placeAnalyticsParams(place),
          link_surface: currentMapSurface(),
          link_url: placeInstagramLink.href,
        });
      }
      return;
    }

    const kiraInstagramLink = event.target.closest('[data-analytics-link="kira-instagram"]');
    if (kiraInstagramLink) {
      trackEvent("kira_instagram_open", {
        link_surface: "place_list",
        link_url: kiraInstagramLink.href,
      });
      return;
    }

    const portfolioWebsiteLink = event.target.closest('[data-analytics-link="portfolio-website"]');
    if (portfolioWebsiteLink) {
      trackEvent("portfolio_website_open", {
        link_surface: "place_list_footer",
        link_url: portfolioWebsiteLink.href,
      });
    }
  });
}

function setupMobileMapToggle() {
  mapExpandToggle.addEventListener("click", () => {
    const wasExpanded = isMapExpanded;
    isMapExpanded = !isMapExpanded;
    updateMobileMapState({ fitBounds: true });
    trackEvent(isMapExpanded ? "map_expand" : "map_collapse", {
      map_surface: "mobile_home",
    });
    if (wasExpanded && !isMapExpanded) {
      mapPanel.scrollIntoView({ block: "start" });
    }
  });

  if (expandedMapHome) {
    expandedMapHome.addEventListener("click", () => {
      isMapExpanded = false;
      setExpandedFilterSheet(false);
      updateMobileMapState({ fitBounds: true });
      trackEvent("map_collapse", {
        map_surface: "expanded_map",
        collapse_source: "logo",
      });
      mapPanel.scrollIntoView({ block: "start" });
    });
  }

  if (expandedFilterToggle) {
    expandedFilterToggle.addEventListener("click", () => {
      setExpandedFilterSheet(!isExpandedFilterSheetOpen);
      trackEvent(isExpandedFilterSheetOpen ? "filter_sheet_open" : "filter_sheet_close", {
        filter_surface: "expanded_map",
      });
    });
  }

  document.addEventListener("pointerdown", (event) => {
    if (!isExpandedFilterSheetOpen || !isMapExpanded || !mobileMapQuery.matches) {
      return;
    }
    if (!(event.target instanceof Element)) {
      return;
    }
    if (event.target.closest("#expandedFilterSheet, #expandedFilterToggle")) {
      return;
    }

    setExpandedFilterSheet(false);
  });

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

function updateDesktopZoomControls() {
  if (!map || !desktopZoomIn || !desktopZoomOut) {
    return;
  }

  desktopZoomIn.disabled = map.getZoom() >= map.getMaxZoom();
  desktopZoomOut.disabled = map.getZoom() <= map.getMinZoom();
}

function setupDesktopZoomControls() {
  if (!desktopZoomIn || !desktopZoomOut) {
    return;
  }

  desktopZoomIn.addEventListener("click", () => {
    map.zoomIn();
    trackEvent("map_zoom", {
      zoom_direction: "in",
      map_surface: currentMapSurface(),
    });
  });

  desktopZoomOut.addEventListener("click", () => {
    map.zoomOut();
    trackEvent("map_zoom", {
      zoom_direction: "out",
      map_surface: currentMapSurface(),
    });
  });

  map.on("zoomend", updateDesktopZoomControls);
  updateDesktopZoomControls();
}

function flagLocateButtonError() {
  if (!mapLocateToggle) {
    return;
  }

  mapLocateToggle.classList.add("is-error");
  window.setTimeout(() => mapLocateToggle.classList.remove("is-error"), 1200);
}

function showUserLocation(position) {
  const { latitude, longitude, accuracy } = position.coords;
  const latLng = [latitude, longitude];
  const zoom = Math.max(map.getZoom(), 15);

  if (!userLocationAccuracy) {
    userLocationAccuracy = L.circle(latLng, {
      radius: Math.min(Number(accuracy) || 0, 1200),
      stroke: false,
      fillColor: "#FF9BAB",
      fillOpacity: 0.14,
      interactive: false,
    }).addTo(map);
  } else {
    userLocationAccuracy.setLatLng(latLng);
    userLocationAccuracy.setRadius(Math.min(Number(accuracy) || 0, 1200));
  }

  if (!userLocationMarker) {
    userLocationMarker = L.circleMarker(latLng, {
      radius: 7,
      color: "#FFFFFF",
      weight: 3,
      fillColor: "#FF9BAB",
      fillOpacity: 1,
      interactive: false,
    }).addTo(map);
  } else {
    userLocationMarker.setLatLng(latLng);
  }

  map.invalidateSize({ pan: false });
  window.requestAnimationFrame(() => {
    map.flyTo(latLng, zoom, { duration: 0.65 });
    window.setTimeout(() => map.invalidateSize({ pan: false }), 240);
  });
}

function setLocateButtonLoading(isLoading) {
  if (!mapLocateToggle) {
    return;
  }

  mapLocateToggle.disabled = isLoading;
  mapLocateToggle.classList.toggle("is-loading", isLoading);
  mapLocateToggle.setAttribute("aria-busy", String(isLoading));
}

function setupLocationControl() {
  if (!mapLocateToggle) {
    return;
  }

  if (!navigator.geolocation) {
    mapLocateToggle.disabled = true;
    mapLocateToggle.setAttribute("aria-label", "Location is not available in this browser");
    return;
  }

  mapLocateToggle.addEventListener("click", () => {
    setLocateButtonLoading(true);
    mapLocateToggle.classList.remove("is-error");
    trackEvent("map_locate_click", {
      map_surface: currentMapSurface(),
    });

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocateButtonLoading(false);
        showUserLocation(position);
        trackEvent("map_locate_success", {
          map_surface: currentMapSurface(),
        });
      },
      (error) => {
        setLocateButtonLoading(false);
        flagLocateButtonError();
        trackEvent("map_locate_error", {
          map_surface: currentMapSurface(),
          error_code: error.code,
          error_reason: error.message || "geolocation_error",
        });
      },
      {
        enableHighAccuracy: true,
        maximumAge: 60000,
        timeout: 10000,
      }
    );
  });
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
      selectPlace(place, { openPopup: !shouldUseBottomSheet(), source: "map_marker" });
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
  setupDesktopZoomControls();
  setupLocationControl();

  places = await loadPlaces();
  setupMarkers();
  setupFilters();
  setupSearchSuggestions();
  setupDesktopSidebarGutterScroll();
  setupActionTracking();
  render({ fitBounds: true });
  [60, 180, 420, 900].forEach((delay) => {
    window.setTimeout(() => refreshMapLayout({ fitBounds: true }), delay);
  });
}

initAnalytics();
init().catch((error) => {
  console.error(error);
  resultCount.textContent = "Could not load map data.";
});
