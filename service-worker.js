// 魚塭紀錄 PWA Service Worker
// 快取 App 殼層(HTML/CSS/JS),讓加到主畫面後可離線開啟。
// 資料本身走 Firestore(它有自己的離線快取),這裡不快取 API 回應。

// 快取版本:部署時由 GitHub Actions 自動把 __BUILD_TIME__ 換成當下時間戳,
// 使每次部署都是新的快取名 → activate 時自動清掉舊殼層、強制重抓(見 .github/workflows/deploy.yml)。
// 本地開發時維持字面值即可。
const BUILD = "__BUILD_TIME__";
const CACHE = "yutun-shell-" + BUILD;
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];
// 殼層核心檔(index.html/style.css/app.js/根)走 network-first;圖示等其餘走 cache-first。

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  // 只處理 GET;Firestore / gstatic / CDN 等一律走網路。
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 第三方(Firebase、CDN)直接走網路

  // 是否為殼層核心檔(app.js / style.css / index.html / 根路徑)。
  // 用結尾比對,忽略查詢字串(?v= / ?nocache=)與 Pages 子路徑。
  const p = url.pathname;
  const isShellCore =
    p.endsWith("/app.js") || p.endsWith("/style.css") ||
    p.endsWith("/index.html") || p.endsWith("/");

  if (isShellCore) {
    // network-first:有網路一定拿最新版,離線才回退快取
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 其餘(圖示 / manifest):cache-first
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => cached);
    })
  );
});
