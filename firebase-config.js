// ============================================================
//  Firebase 設定 — 把這裡換成你自己的專案金鑰
// ============================================================
// 取得方式(部署說明 DEPLOY.md 有完整圖解步驟):
//   1. https://console.firebase.google.com 建立專案
//   2. 建立 Web App,複製 firebaseConfig 的內容貼到下面
//   3. 啟用 Firestore Database (測試模式)
//
// 注意:這些金鑰放在前端是「正常且安全」的設計 —— Firebase 的
// Web API key 本來就是公開的,真正的存取控制靠 Firestore 規則。
// 我們依你的需求把規則設為完全公開(見 DEPLOY.md)。

export const firebaseConfig = {
  apiKey: "AIzaSyByR0BzPrlN8ZGw-ZeS7-2HShw9ZLx7y6Y",
  authDomain: "fishpond-log-e4c57.firebaseapp.com",
  projectId: "fishpond-log-e4c57",
  storageBucket: "fishpond-log-e4c57.firebasestorage.app",
  messagingSenderId: "310814722472",
  appId: "1:310814722472:web:6d899a4d2d843a1b17b59d"
};

// ============================================================
//  GitHub Actions 觸發設定 — 建立紀錄當下「戳」relay 立刻補抓氣溫
// ============================================================
// 為什麼要這個(2026-07-05):GitHub 定時排程(schedule)是 best-effort,
// 高頻 cron 尖峰易被稀釋甚至整段跳過(實測出現 1~8 小時空窗),導致某些
// 紀錄在補抓時窗內都等不到一輪 relay。改為「建立紀錄成功後,由 App 主動打
// workflow_dispatch 叫 relay 立刻跑一輪」→ 不必等下一次定時排程。
//
// 裝置相容性:壞手機打不通的是 opendata.cwa.gov.tw,但 api.github.com
// 已由使用者實測可通(2026-07-05),故由手機觸發、GitHub 代抓這條可行。
//
// token 放前端的取捨:符合本專案全公開設計。token 使用「細粒度 PAT」,
// 權限僅限本 repo 的 Actions:write —— 拿到的人頂多讓 relay 多跑幾次
// (不洩漏資料、不能改程式碼)。若被濫用可隨時到 GitHub 撤銷重發。
export const githubDispatch = {
  owner: "senaosam",
  repo: "fishpond-log",
  workflow: "weather-relay.yml",
  ref: "main",
  // token 不寫死在 repo(GitHub Push Protection 會擋公開 PAT):改由部署時注入。
  // 佔位符 __GH_DISPATCH_TOKEN__ 會在 deploy.yml 被換成 GitHub Actions Secret
  // GH_DISPATCH_TOKEN(就像 BUILD_TIME 一樣部署時 sed 覆寫)。
  // 本機開發時維持佔位符 = 停用觸發(triggerWeatherRelay 偵測到非 github_pat_ 開頭就略過),不影響存檔。
  token: "__GH_DISPATCH_TOKEN__"
};
