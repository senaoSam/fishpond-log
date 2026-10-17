// ============================================================
//  現場溫度 — 讀魚塭現場板子(pond-site)回報的溫度
// ============================================================
// 2026-10-14 起取代氣象署文安站氣溫(原 weather.js + weather-relay.yml 已移除)。
// 探頭放在魚塭旁、不在水中,量到的是「現場氣溫」而不是水溫;但它是離魚塭最近的
// 量測點,比幾公里外的測站更有參考性。板子歷史從 2026-08-22 起才有。
//
// 資料在「另一個」Firebase 專案(esp32-e7966 的 Realtime Database),與本站
// Firestore 無關。RTDB 的 REST 端點直接 GET 就有 JSON,規則公開讀取,不需憑證。
//   devices/pond-site/latest            → { temp, ts }   板子每 60 秒覆寫
//   history/pond-site/{YYYY-MM}/{ts}    → { temp }       每 5 分鐘一筆;月份依 UTC 切
// ts 都是 unix 秒。

export const NODE_RTDB = "https://esp32-e7966-default-rtdb.asia-southeast1.firebasedatabase.app";

// latest 超過此秒數就不算「當下」溫度(板子 60 秒回報一次,留幾輪餘裕)
const LATEST_MAX_AGE_SEC = 10 * 60;
// 歷史查詢:取紀錄時間前後此秒數內最接近的一筆(歷史 5 分鐘一筆)
const HISTORY_WINDOW_SEC = 10 * 60;

// 新增紀錄時最多等溫度這麼久:網路卡住時 fetch 可能掛好幾十秒,這段期間紀錄還沒寫入,
// 使用者以為按了沒反應而離開,那筆就整個沒記到。讀不到就先存檔,溫度之後會從板子歷史補。
const LATEST_TIMEOUT_MS = 3000;

// 當下溫度。回 { temp, ts };讀不到 / 板子失聯 / 離線 / 逾時一律回 null(不丟例外,不擋存檔)。
export async function latestPondTemp() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LATEST_TIMEOUT_MS);
  try {
    const r = await fetch(`${NODE_RTDB}/devices/pond-site/latest.json`, { cache: "no-store", signal: ctrl.signal });
    if (!r.ok) return null;
    const l = await r.json();
    const temp = Number(l?.temp), ts = Number(l?.ts);
    if (!Number.isFinite(temp) || !ts) return null;
    if (Date.now() / 1000 - ts > LATEST_MAX_AGE_SEC) return null;
    return { temp, ts };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 指定時間(毫秒)的溫度:從歷史取前後 HISTORY_WINDOW_SEC 內最接近的一筆。
// 回 { temp, ts };該時段沒有資料回 null;連不上丟例外(呼叫端據此決定要不要放棄)。
export async function pondTempAt(ms) {
  const at = Math.round(ms / 1000);
  const from = at - HISTORY_WINDOW_SEC, to = at + HISTORY_WINDOW_SEC;
  // 前後時窗可能跨月(UTC),兩個月份都查
  const months = [...new Set([from, to].map((s) => new Date(s * 1000).toISOString().slice(0, 7)))];
  let best = null;
  for (const ym of months) {
    // key 是 10 位數 unix 秒字串,字串排序 = 數字排序,可直接用 startAt/endAt 讓伺服器端篩
    const url = `${NODE_RTDB}/history/pond-site/${ym}.json`
      + `?orderBy=%22%24key%22&startAt=%22${from}%22&endAt=%22${to}%22`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    for (const [k, v] of Object.entries((await r.json()) || {})) {
      const ts = Number(k), temp = Number(v?.temp);
      if (!Number.isFinite(temp)) continue;
      if (!best || Math.abs(ts - at) < Math.abs(best.ts - at)) best = { temp, ts };
    }
  }
  return best;
}
