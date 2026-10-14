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
// 規則只開放下方「秘密路徑」底下的資料(見 DEPLOY.md)。

export const firebaseConfig = {
  apiKey: "AIzaSyByR0BzPrlN8ZGw-ZeS7-2HShw9ZLx7y6Y",
  authDomain: "fishpond-log-e4c57.firebaseapp.com",
  projectId: "fishpond-log-e4c57",
  storageBucket: "fishpond-log-e4c57.firebasestorage.app",
  messagingSenderId: "310814722472",
  appId: "1:310814722472:web:6d899a4d2d843a1b17b59d"
};

// ============================================================
//  資料庫秘密路徑 — 所有資料都放在 /p/{秘密}/ 底下
// ============================================================
// 為什麼(2026-10-14):repo 公開 → 專案 ID 公開,會被掃 Firebase 的機器人找到。
// Firestore 規則只開放 /p/{秘密}/** 的讀寫,其餘一律拒絕;不知道秘密就組不出路徑。
// 規則讀不到網址參數/標頭,所以暗號只能放在路徑裡。
// 判斷標準:「打得開網頁的人都算合法」—— 秘密會出現在部署後的 JS 裡,這是預期的。
//
// 秘密不寫進 repo:佔位符 __DB_SECRET__ 會在 deploy.yml 被換成 GitHub Secret DB_SECRET。
// 本機開發 / 本機腳本維持佔位符,改讀不進 repo 的 secret.local.js。
// 都拿不到時 dbSecret 為空字串,App 會拒絕連線(避免把資料寫到錯的路徑)。
let secret = "__DB_SECRET__";
if (secret.startsWith("__")) {
  try { ({ dbSecret: secret } = await import("./secret.local.js")); }
  catch { secret = ""; }
}
export const dbSecret = secret;
// Firestore 路徑前綴:SDK 用 doc(db, ...DB_ROOT, "records", id);REST 用 DB_ROOT.join("/")
export const DB_ROOT = ["p", dbSecret];
