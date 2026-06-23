# 部署說明 — 魚塭紀錄

完成這份文件的步驟,App 就能在手機與電腦上使用,資料即時同步。
全程免費,不需綁信用卡。

---

## 步驟 A:建立 Firebase 專案(存資料用)

1. 到 https://console.firebase.google.com ,用 Google 帳號登入。
2. 點「建立專案」→ 取個名字(例如 `fishpond-log`)→ 一路下一步。
   - 「Google Analytics」可以**關掉**,用不到。
3. 進入專案後,左側選單 **建構 → Firestore Database** → 點「建立資料庫」。
   - 位置選 **asia-east1（台灣)** 或 asia-northeast1。
   - 安全規則選 **「以測試模式啟動」**(這就是我們要的完全公開)。
4. 建立一個 Web App 來拿金鑰:
   - 專案首頁齒輪 ⚙ → **專案設定** → 下方「你的應用程式」→ 點 **`</>`(Web)** 圖示。
   - 取個暱稱(隨意)→ 註冊應用程式。
   - 會出現一段 `firebaseConfig = { ... }`,**把整段複製起來**。

### 把金鑰填進專案
打開 `firebase-config.js`,把裡面的值換成你剛複製的那段。例如:

```js
export const firebaseConfig = {
  apiKey: "AIzaSyD...你的值",
  authDomain: "fishpond-log.firebaseapp.com",
  projectId: "fishpond-log",
  storageBucket: "fishpond-log.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abc123"
};
```

> 這些金鑰放在前端是正常的,不是漏洞。真正的存取控制在 Firestore 規則。

### Firestore 規則(完全公開)
Firestore Database → **規則** 分頁,貼上以下內容後「發布」:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

> 「測試模式」預設規則 30 天後會自動鎖死,所以**務必**改成上面這個 `if true`,才不會某天突然不能用。

---

## 步驟 B:部署到 GitHub Pages

1. 在 GitHub 建一個 repository(可設 Private,Pages 仍可用)。
2. 把這個資料夾的**所有檔案**上傳上去(包含 `icons/` 資料夾)。
   - 用網頁拖拉上傳,或用 git:
     ```
     git init
     git add .
     git commit -m "魚塭紀錄 App"
     git branch -M main
     git remote add origin https://github.com/你的帳號/你的repo.git
     git push -u origin main
     ```
3. repo 頁面 → **Settings → Pages**:
   - Source 選 **Deploy from a branch**。
   - Branch 選 **main**、資料夾 **/(root)** → Save。
4. 等 1～2 分鐘,頁面上方會出現網址,例如:
   `https://你的帳號.github.io/你的repo/`
5. 打開那個網址就能用了 🎉

---

## 步驟 C:手機「加到主畫面」(變成像 App)

- **iPhone(Safari)**:開網址 → 分享鈕 → 「加入主畫面」。
- **Android(Chrome)**:開網址 → 右上選單 → 「安裝應用程式 / 加到主畫面」。

加完後桌面會有一顆 🐟 圖示,點開是全螢幕,跟 App 一樣。

---

## 之後要更新 App?

改完檔案重新 push 到 GitHub,Pages 會自動更新。
手機端若沒看到更新,把加到主畫面的圖示移除再重加一次,或重新整理即可。

---

## 常見問題

- **打開顯示「未設定 Firebase」** → `firebase-config.js` 還沒填或填錯。
- **存不了資料 / 讀取失敗** → 多半是 Firestore 規則沒設成 `if true`,回步驟 A 檢查。
- **手機看不到電腦記的資料** → 確認兩邊用的是同一個網址(同一個 Firebase 專案)。
- **要不要錢?** → 個人用量遠低於免費額度,不會扣到錢,也不需綁卡。
