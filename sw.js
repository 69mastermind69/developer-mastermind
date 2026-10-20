
/* =========================================
   DEVELOPER MASTERMIND
   File: sw.js
   Service Worker for GitHub Pages
========================================= */

"use strict";

const CACHE_VERSION = "developer-mastermind-v2";
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then(async cache => {
        await Promise.all(
          APP_SHELL.map(async path => {
            try {
              const response = await fetch(path, { cache: "reload" });

              if (response.ok) {
                await cache.put(path, response);
              }
            } catch (error) {
              console.warn("Could not cache:", path, error);
            }
          })
        );
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => Promise.all(
        cacheNames.map(cacheName => {
          const belongsToApp =
            cacheName.startsWith("developer-mastermind-");

          const isCurrent =
            cacheName === APP_SHELL_CACHE ||
            cacheName === RUNTIME_CACHE;

          if (belongsToApp && !isCurrent) {
            return caches.delete(cacheName);
          }

          return Promise.resolve(false);
        })
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Only handle requests from this app's origin.
  if (url.origin !== self.location.origin) return;

  // HTML navigation: network first, cached page when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();

            caches.open(APP_SHELL_CACHE)
              .then(cache => cache.put("./index.html", copy))
              .catch(error => console.warn("Page cache failed:", error));
          }

          return response;
        })
        .catch(async () => {
          const cachedPage = await caches.match(request);

          if (cachedPage) return cachedPage;

          const cachedIndex = await caches.match("./index.html");

          if (cachedIndex) return cachedIndex;

          return new Response(
            `<!doctype html>
            <html lang="en">
              <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>Developer Mastermind</title>
              </head>
              <body>
                <h1>You are offline</h1>
                <p>Reconnect to the internet and try again.</p>
              </body>
            </html>`,
            {
              status: 503,
              headers: {
                "Content-Type": "text/html; charset=utf-8"
              }
            }
          );
        })
    );

    return;
  }

  const isAppResource =
    /\.(?:js|css|json|png|svg|webp|jpe?g|woff2|ico)$/i.test(url.pathname);

  if (!isAppResource) return;

  // App resources: cache first, then network.
  event.respondWith(
    caches.match(request)
      .then(cachedResponse => {
        if (cachedResponse) return cachedResponse;

        return fetch(request).then(response => {
          if (!response || !response.ok || response.type === "opaque") {
            return response;
          }

          const copy = response.clone();

          caches.open(RUNTIME_CACHE)
            .then(cache => cache.put(request, copy))
            .catch(error => console.warn("Resource cache failed:", error));

          return response;
        });
      })
  );
});

self.addEventListener("message", event => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
