# 部署說明 — 魚塭紀錄

這個 App 是純前端(HTML / CSS / JS)+ Firestore,**已完成串接並上線**。
- 線上網址:**https://senaosam.github.io/fishpond-log/**
- 部署方式:push 到 `main` → GitHub Actions 自動發布到 GitHub Pages
- 全程免費,不需綁信用卡。

---

## 平常怎麼更新?(最常用)

改完任何檔案後,推上 GitHub 就會自動部署:

```bash
git add .
git commit -m "說明這次改了什麼"
git push
```

push 後到 GitHub repo 的 **Actions** 分頁可看部署進度:

- 🟡 進行中 → 等約 1 分鐘
- ✅ 綠勾 → 已上線,重新整理網頁即可看到更新
- ❌ 紅叉 → 點進去看錯誤訊息

> 手機端若沒看到更新:重新整理,或把加到主畫面的圖示移除再重加一次。

---

## 本機開發 / 測試

本專案用 **pnpm** 管理。因為用了 ES Module(`import`),**不能直接雙擊 HTML 開啟**,要透過本機伺服器:

```bash
pnpm install   # 第一次才需要
pnpm dev       # 啟動本機伺服器
```

然後瀏覽器開 **http://localhost:8000**。改檔案後重新整理即可(若被舊快取卡住,按 Ctrl + Shift + R 強制重整)。

> `pnpm` / `serve` 只是開發時用的工具,不會被部署上去,也與 App 本身無關。

---

## 首次設定紀錄(已完成,僅供參考 / 換專案時用)

以下是這個專案「從零」設定時做過的事。若你要換成自己的 Firebase 專案,照著做即可。

### A. 建立 Firebase 專案(存資料用)

1. 到 https://console.firebase.google.com ,用 Google 帳號登入 →「建立專案」。
   - Google Analytics 可關掉,用不到。
2. 左側 **資料庫和儲存空間 → Firestore Database** →「建立資料庫」。
   - 版本選 **Standard**。
   - 位置選 **asia-east1(台灣)** 或 asia-northeast1(東京)。**建立後不能改**。
   - 規則先選 **「以測試模式啟動」**(下一步會改成只開放秘密路徑)。
3. 拿金鑰:專案設定 ⚙ → 下方「你的應用程式」→ 點 **`</>`(Web)** → 取暱稱、**不要勾 Firebase Hosting** → 註冊 → 選 **「使用 `<script>` 標記」**,複製出現的 `firebaseConfig = { ... }`。
4. 把複製的內容貼進 `firebase-config.js`(取代裡面的值)。

> 這些金鑰放在前端是正常的,不是漏洞 —— Firebase Web API key 本來就是公開設計,真正的存取控制在 Firestore 規則。本專案 repo 為 public,金鑰可被看到,這是預期的。

### B. 秘密路徑 + Firestore 規則(2026-10-14 起)

repo 公開 → 專案 ID 公開,會被掃 Firebase 的機器人找到。所以所有資料都放在 `/p/{秘密}/` 底下,
規則只開放這條路徑,其餘一律拒絕。秘密**絕不進 repo**,只存在三個地方,且三者必須完全一致:

| 位置 | 用途 |
|---|---|
| GitHub → Settings → Secrets and variables → Actions → `DB_SECRET` | 部署時注入 `firebase-config.js`;weather-relay / db-backup 也讀它 |
| 本機 `secret.local.js`(已 gitignore) | 本機開發與 `scripts/` 腳本使用 |
| Firestore 規則 | 見下方 |

1. 產生一串 32 字元的英數亂碼(不要用 `_` 開頭)。
2. 建立 `secret.local.js`:`export const dbSecret = "亂碼";`
3. 設定 GitHub Secret `DB_SECRET` = 同一串亂碼。
4. Firestore Database → **規則** 分頁,貼上以下內容(`亂碼` 換成真的值)後「發布」:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 只開放秘密路徑底下的資料(見 firebase-config.js);其他路徑沒有規則 = 一律拒絕
    match /p/亂碼/{document=**} {
      allow read, write: if true;
    }
  }
}
```

> 判斷標準是「打得開網頁的人都算合法」:秘密會出現在部署後的 JS 裡,這是預期的。擋的是只看得到 repo 的外人與掃描機器人。
> 「測試模式」預設規則 30 天後會自動鎖死,所以**務必**改成上面的規則。
> 換秘密:三個地方一起改,再用 `scripts/copy-to-secret-path.mjs` 的寫法把資料搬到新路徑。

### C. GitHub Pages(自動部署)

1. 把專案 push 到一個 **public** 的 GitHub repo。
   - ⚠️ 免費帳號的 **private** repo 不能用 GitHub Pages,需設為 public。
2. repo → **Settings → Pages** → **Source** 選 **「GitHub Actions」**(不是 Deploy from a branch)。
3. 部署流程已寫在 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml),push 到 `main` 會自動觸發。
   - 該 workflow 設了 `enablement: true`,首次會自動啟用 Pages。
4. 第一次成功後,網址會是 `https://你的帳號.github.io/你的repo/`。

---

## 手機「加到主畫面」(變成像 App)

- **iPhone(Safari)**:開網址 → 分享鈕 → 「加入主畫面」。(務必用 Safari,Chrome / Line 內建瀏覽器不行)
- **Android(Chrome)**:開網址 → 右上選單 → 「安裝應用程式 / 加到主畫面」。

加完後桌面會有一顆 🐟 圖示,點開是全螢幕,離線也能開介面(資料同步需連網)。

---

## 常見問題

- **打開顯示「未設定 Firebase」** → `firebase-config.js` 還沒填或填錯。
- **存不了資料 / 讀取失敗** → 多半是秘密不一致(規則 / GitHub Secret / `secret.local.js` 三者),回 B 檢查。
- **顯示「未設定資料庫路徑」** → 本機少了 `secret.local.js`,或部署時 `DB_SECRET` 沒注入(看 deploy 的 Actions log)。
- **手機看不到電腦記的資料** → 確認兩邊用同一個網址(同一個 Firebase 專案)。
- **Settings → Pages 顯示要 Upgrade** → repo 是 private,免費帳號需改成 public。
- **Actions 部署紅叉「Get Pages site failed」** → Pages 來源沒設成 GitHub Actions,或 repo 非 public。
- **要不要錢?** → 個人用量遠低於 Firebase 免費額度,不綁卡也不會被收費。
