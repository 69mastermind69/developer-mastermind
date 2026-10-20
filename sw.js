
/* =========================================
   DEVELOPER MASTERMIND
   File: sw.js
   Service Worker for GitHub Pages
========================================= */

"use strict";

const CACHE_VERSION = "developer-mastermind-v1";
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

/*
 * Relative URLs work when the app is hosted in a
 * GitHub Pages repository subdirectory.
 */
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js"
];

/* ---------- Install ---------- */

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then(async cache => {
        /*
         * Cache files individually so one missing resource
         * does not prevent the other files from being cached.
         */
        await Promise.all(
          APP_SHELL.map(async url => {
            try {
              const response = await fetch(url, {
                cache: "reload"
              });

              if (response.ok) {
                await cache.put(url, response);
              }
            } catch (error) {
              console.warn("Could not cache app file:", url, error);
            }
          })
        );
      })
      .then(() => self.skipWaiting())
  );
});

/* ---------- Activate ---------- */

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames =>
        Promise.all(
          cacheNames.map(cacheName => {
            const isOurCache =
              cacheName.startsWith("developer-mastermind-");

            const isCurrentCache =
              cacheName === APP_SHELL_CACHE ||
              cacheName === RUNTIME_CACHE;

            if (isOurCache && !isCurrentCache) {
              return caches.delete(cacheName);
            }

            return Promise.resolve(false);
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ---------- Fetch ---------- */

self.addEventListener("fetch", event => {
  const request = event.request;

  // Only handle GET requests.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Do not cache requests to other origins.
  if (url.origin !== self.location.origin) return;

  // Use the network for navigation, with an offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();

            caches.open(APP_SHELL_CACHE)
              .then(cache => cache.put("./index.html", copy))
              .catch(error => {
                console.warn("Could not update app cache:", error);
              });
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
                <style>
                  body {
                    max-width: 600px;
                    margin: 60px auto;
                    padding: 20px;
                    font: 16px/1.6 Arial, sans-serif;
                    color: #20243a;
                  }
                </style>
              </head>
              <body>
                <h1>You are offline</h1>
                <p>Reconnect to the internet and try opening Developer Mastermind again.</p>
              </body>
            </html>`,
            {
              headers: {
                "Content-Type": "text/html; charset=utf-8"
              },
              status: 503
            }
          );
        })
    );

    return;
  }

  /*
   * For same-origin app resources, try the cache first.
   * If a resource is not cached, fetch it and cache a
   * successful response for a future offline visit.
   */
  const isAppResource =
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".json") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".webp") ||
    url.pathname.endsWith(".jpg") ||
    url.pathname.endsWith(".jpeg") ||
    url.pathname.endsWith(".woff2");

  if (!isAppResource) return;

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
            .catch(error => {
              console.warn("Could not cache resource:", error);
            });

          return response;
        });
      })
  );
});

/* ---------- Optional cache refresh message ---------- */

self.addEventListener("message", event => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
