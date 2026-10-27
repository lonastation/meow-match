/* Optional offline support. The game itself also runs directly from local files. */
"use strict";

const CACHE_PREFIX = "meow-match-offline:" + self.registration.scope + ":";
const CACHE_NAME = CACHE_PREFIX + "v10";
const LOCAL_FILES = [
  "index.html",
  "style.css",
  "engine.js",
  "game.js",
  "manifest.json",
  "assets/icon.svg",
  "assets/icon-192.png",
  "assets/icon-512.png"
];
const LOCAL_URLS = LOCAL_FILES.map((path) => new URL(path, self.registration.scope).href);
const ALLOWED_URLS = new Set(LOCAL_URLS);
const INDEX_URL = new URL("index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  // Only this game's local files are read once during installation. There are
  // no remote resources, runtime network fallback, or gameplay network calls.
  event.waitUntil(
    caches.open(CACHE_NAME)
      // Bypass the HTTP cache when preparing a new version, so an old asset
      // cannot silently become part of the new offline installation.
      .then((cache) => cache.addAll(LOCAL_URLS.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // Leave unrelated apps and other Meow Match installations untouched.
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;

  url.search = "";
  url.hash = "";
  const navigation = event.request.mode === "navigate";
  if (!navigation && !ALLOWED_URLS.has(url.href)) return;

  // Navigation inside this app always opens the cached single page. A missing
  // entry fails locally instead of making a background network request.
  const resource = navigation ? INDEX_URL : url.href;
  event.respondWith(
    caches.open(CACHE_NAME)
      .then((cache) => cache.match(resource))
      .then((response) => response || Response.error())
  );
});
