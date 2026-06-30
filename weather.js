// ============================================================
//  天氣 — 建立紀錄當下抓中央氣象署(CWA)氣溫
// ============================================================
// 設計(已與使用者確認、API 皆實測驗證):
//   - 只抓「氣溫」,來源固定為「文安自動氣象站 C0V870」(高雄彌陀,離魚塭最近)。
//   - 用 opendata 即時資料集 O-A0001-001(CORS 開放、可純前端 fetch)。
//   - 這支 API 的 ?StationId= 參數無效,必須抓全部測站再用 JS 找 C0V870。
//   - 雨量不抓(此即時 API 只有「當日累積」,無「過去N小時」,對魚塭意義不大)。
//   - 抓不到不擋存檔;由 app.js 在「建立 +1 小時內、每次開 App」做機會式重試。
//   - 超過 1 小時不做歷史補抓(投報率低,使用者已確認),留空即可。
//
// CWA 授權碼放在前端是明文公開的 —— 此 App 採完全公開設計(見 SPEC §6),
// 且 CWA 金鑰只讀公開氣象資料、可隨時於 opendata.cwa.gov.tw 重新產生,風險低。

export const CWA_KEY = "CWA-3496C7B9-DDC8-4FF0-A8F2-D4104C4B4DDF";
export const STATION_ID = "C0V870";       // 文安(高雄彌陀)
export const STATION_NAME = "文安";

// 建立 +N 分鐘內才值得重試即時(超過此時窗,即時值已不代表建立當下)
export const RETRY_WINDOW_MIN = 60;

const API_URL =
  "https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0001-001" +
  "?Authorization=" + CWA_KEY + "&format=JSON";

// 抓文安站的即時氣溫。
// 成功回 { temp:Number, obsTime:String, station, stationName };抓不到/缺值回 null。
export async function fetchWeather() {
  const d = await fetchWeatherDebug();
  return d.ok ? d.result : null;
}

// [DEBUG-TEMP] 觀察用:回傳完整抓取結果與失敗原因,方便釐清「為何常抓不到」。
// 觀察結束後連同 app.js 的 weather_debug 寫入一併移除即可。
// 回傳 { ok, reason, result, httpStatus, stationFound, stationCount, rawTemp, obsTime, errorName }
export async function fetchWeatherDebug() {
  const out = { ok: false, reason: "", result: null, httpStatus: null,
    stationFound: false, stationCount: null, rawTemp: null, obsTime: "", errorName: "" };
  try {
    const r = await fetch(API_URL);
    out.httpStatus = r.status;
    if (!r.ok) { out.reason = "http-not-ok"; return out; }

    const j = await r.json();
    const stations = j?.records?.Station;
    if (!Array.isArray(stations)) { out.reason = "no-station-array"; return out; }
    out.stationCount = stations.length;

    const s = stations.find((x) => x.StationId === STATION_ID);
    if (!s) { out.reason = "station-not-found"; return out; }
    out.stationFound = true;

    const raw = s?.WeatherElement?.AirTemperature;
    out.rawTemp = raw === undefined ? null : raw;
    out.obsTime = s?.ObsTime?.DateTime || "";
    const temp = Number(raw);
    // CWA 缺測以 -99 表示;NaN/缺值都視為抓不到
    if (!Number.isFinite(temp) || temp <= -90) { out.reason = "missing-value"; return out; }

    out.ok = true;
    out.reason = "ok";
    out.result = { temp, obsTime: out.obsTime, station: STATION_ID, stationName: STATION_NAME };
    return out;
  } catch (e) {
    // 網路錯誤 / CORS / JSON 解析失敗 → 視為抓不到(不丟例外,不擋存檔)
    // errorName 區分 TypeError(fetch 連線/CORS/混合內容失敗)與 SyntaxError(JSON 壞)等
    out.errorName = (e && e.name) ? e.name : "";
    out.reason = "exception:" + (e && e.message ? e.message : String(e));
    return out;
  }
}
