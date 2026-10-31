"use strict";

const CACHE_NAME = "nexora-shell-v3";
const APP_SHELL = [
  "./",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./nexora-icon-192.png",
  "./nexora-icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key === "ragi-incubator-shell-v1" || key.startsWith("nexora-shell-"))
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => cache.put("./", copy))
            .catch(error => console.error("Could not cache the NEXORA page shell.", error));
          return response;
        })
        .catch(async () => {
          const cachedPage = await caches.match("./");
          if (cachedPage) return cachedPage;
          return new Response("NEXORA is offline. Reconnect to load the device monitor.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        })
    );
    return;
  }

  if (/\/downloads\/[^/]+\.apk$/i.test(url.pathname)) return;
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});
