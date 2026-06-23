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
  apiKey: "請填入你的_API_KEY",
  authDomain: "你的專案.firebaseapp.com",
  projectId: "你的專案ID",
  storageBucket: "你的專案.appspot.com",
  messagingSenderId: "請填入",
  appId: "請填入"
};
