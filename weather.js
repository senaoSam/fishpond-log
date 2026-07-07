// ============================================================
//  天氣 — 讀取 GitHub Actions 中繼寫入 Firestore 的最新氣溫
// ============================================================
// 架構(2026-07-03 定案):
//   GitHub Actions(.github/workflows/weather-relay.yml)每 10 分鐘抓
//   CWA 文安站(C0V870)氣溫 → 覆寫 Firestore 的 meta/latestWeather →
//   App 建立紀錄時只讀這個文件,完全不直連 CWA。
//
// 為什麼不直連 CWA(2026-07 實測定案):部分手機從 App 網頁 fetch
//   opendata.cwa.gov.tw 必失敗(fetch / no-cors / XHR 三種皆然),但同一支
//   手機用瀏覽器直開同網址正常、寫 Firestore 也正常。特定裝置對「App網域 ×
//   CWA主機」的連線層問題,前端無法自救;Firestore(googleapis)則所有裝置
//   100% 可連,故以它為唯一通道。附帶好處:原本每次抓溫度要下載 CWA 整包
//   850KB(該 API 不能只查單站),改讀中繼文件後每次僅約 0.3KB。
//
// 這裡用 Firestore REST 讀(免拉 SDK 進來),規則全公開、帶 key 即可。

import { firebaseConfig } from "./firebase-config.js";

export const STATION_ID = "C0V870";       // 文安(高雄彌陀)
export const STATION_NAME = "文安";

// 建立 +N 分鐘內才值得重試(超過此時窗,「現在的氣溫」已不代表建立當下)
export const RETRY_WINDOW_MIN = 90;

// 觀測時間超過此分鐘數視為過期,不寫進紀錄:
// 測站每 ~10 分鐘觀測 + 中繼每 25 分鐘抓 + GitHub 排程抖動(可達 ~15 分)
export const MAX_OBS_AGE_MIN = 60;

// 「建立當下沿用 meta 現成溫度」的門檻(比 MAX_OBS_AGE_MIN 緊):
// 連續新增時,只要 meta 的觀測時間夠新就直接沿用、不再觸發 relay,避免重複抓。
// 設 15 分 → 沿用到的溫度最舊也只離建立時間 ~15 分,兼顧「省觸發」與「數值準度」。
// 超過 15 分才重新標 pending + 觸發 relay 抓新的(見 app.js 建立流程)。
export const REUSE_OBS_AGE_MIN = 15;

const DOC_URL =
  `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}` +
  `/databases/(default)/documents/meta/latestWeather?key=${firebaseConfig.apiKey}`;

// 讀最新氣溫。成功回 { temp:Number, obsTime:String, station, stationName };
// 讀不到 / 缺值 / 資料過期都回 null(不丟例外,不擋存檔)。
export async function fetchWeather() {
  try {
    const r = await fetch(DOC_URL, { cache: "no-store" });
    if (!r.ok) return null;   // 含 404:中繼還沒寫入過

    const f = (await r.json()).fields || {};
    const temp = Number(f.temp?.doubleValue ?? f.temp?.integerValue);
    const obsTime = f.obsTime?.stringValue || "";
    if (!Number.isFinite(temp) || !obsTime) return null;

    // 過期檢查:中繼若停擺(如 GitHub 排程被停用),不拿舊溫度充數
    const age = Date.now() - Date.parse(obsTime);
    if (!Number.isFinite(age) || age > MAX_OBS_AGE_MIN * 60 * 1000) return null;

    return {
      temp,
      obsTime,
      station: f.station?.stringValue || STATION_ID,
      stationName: f.stationName?.stringValue || STATION_NAME
    };
  } catch {
    // 網路 / JSON 解析失敗 → 視為抓不到(不擋存檔,之後重試)
    return null;
  }
}

// 「建立當下沿用」專用:讀 meta,只有觀測時間 ≤ REUSE_OBS_AGE_MIN 才回值,否則 null。
// 用途:連續新增時,第 2~N 筆若讀到夠新的 meta 就直接沿用、不必再觸發 relay。
// 與 fetchWeather() 的差別只在「新鮮度門檻更緊」(15 分 vs 60 分),讀的是同一份 meta。
export async function reusableWeather() {
  try {
    const r = await fetch(DOC_URL, { cache: "no-store" });
    if (!r.ok) return null;

    const f = (await r.json()).fields || {};
    const temp = Number(f.temp?.doubleValue ?? f.temp?.integerValue);
    const obsTime = f.obsTime?.stringValue || "";
    if (!Number.isFinite(temp) || !obsTime) return null;

    const age = Date.now() - Date.parse(obsTime);
    if (!Number.isFinite(age) || age > REUSE_OBS_AGE_MIN * 60 * 1000) return null;   // 太舊→不沿用

    return {
      temp,
      obsTime,
      station: f.station?.stringValue || STATION_ID,
      stationName: f.stationName?.stringValue || STATION_NAME
    };
  } catch {
    return null;
  }
}
