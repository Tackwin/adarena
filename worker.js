const CACHE_NAME = "main_game";
const CACHE_TIME = "2025-08-21T20:51:52.944Z";
const CACHE_FULL = CACHE_NAME + "_" + CACHE_TIME;
const CACHED_METADATA = ["", "index.html", "icon.png", "main.wasm", "manifest.json", "runtime.js"];

const maybe_refresh_cache = async () => {
    let found_valid_metadata_cache = false;
    for (const cache_name of await caches.keys()) {
        if (!cache_name.startsWith(CACHE_NAME)) continue;
        if (cache_name.endsWith(CACHE_TIME)) {
            // console.log(cache_name, "is a valid cache");
            found_valid_metadata_cache = true;
        } else {
            // console.log(cache_name, "is an outdated cache, deleting");
            await caches.delete(cache_name);
        }
    }
    
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
    if (clients.length < 1) {
        console.error(`Service Worker "${CACHE_NAME}" could not connect to the client page.`);
        return;
    }
    
    const client = clients[0];
    
    if (!found_valid_metadata_cache) {
        const cache = await caches.open(CACHE_FULL);
        await cache.addAll(CACHED_METADATA.map((name) => client.url + name));
    }
};

self.addEventListener("fetch",    (event) => { event.respondWith((async () => (await caches.match(event.request.url)) || (await fetch(event.request)))()); });
self.addEventListener("install",  (event) => { event.waitUntil(self.skipWaiting().then(() => maybe_refresh_cache())); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim() .then(() => maybe_refresh_cache())); });
