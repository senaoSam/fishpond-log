// ============================================================
//  魚塭紀錄 — 主程式
// ============================================================
import { firebaseConfig, dbSecret, DB_ROOT } from "./firebase-config.js";
import { NODE_RTDB, latestPondTemp, pondTempAt } from "./pondtemp.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc,
  addDoc, setDoc, updateDoc, deleteDoc,
  getDoc, onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------- 部署版本時間戳 ----------
// header 會顯示「月/日/時」,用來肉眼確認線上載入的是新版而非 cache。
// 此值在 GitHub Actions 部署時會被自動覆寫成「當下台灣時間」(見 .github/workflows/deploy.yml),
// 不需手動維護;這裡只是本地開發用的佔位值。格式:YYYY-MM-DD HH:mm
const BUILD_TIME = "2026-06-25 23:50";

// ---------- 帶 id 的選項(池塘/飼料/拌料/消毒劑)----------
// 這四組選項存成 [{ id, name }]:紀錄欄位存 id(r.pondId 等),改名只動 name,
// 既有紀錄與 pondTags 都用 id 關聯,改名不會讓舊資料變孤兒。
// tags(群組)維持純字串陣列;pondTags 的 key 用「池塘 id」。
const ID_KEYS = ["ponds", "feedNos", "mixes", "disinfectants"];

// 產生唯一 id(瀏覽器與 Node 18+ 皆內建 crypto.randomUUID)
function uid() {
  return (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
// 取選項顯示名:相容「物件 {id,name}」與「純字串」(tags 用)
function optName(it) { return it && typeof it === "object" ? it.name : it; }
// 把一組名稱字串轉成 [{id,name}](給 DEFAULT_OPTIONS / 遷移用)
function withIds(names) { return names.map((name) => ({ id: uid(), name })); }

// ---------- 預設固定選項(首次使用會寫進 Firestore) ----------
const DEFAULT_OPTIONS = {
  ponds: [],                 // [{id, name}]
  feedNos: withIds(["0.8號", "000號", "00號", "0號", "1號", "2號", "3號", "4號", "5號", "6號", "7號"]),
  mixes: withIds(["安蒙20%", "安蒙50%", "弗洛得", "OTC"]),
  disinfectants: withIds(["二氧化氯10%", "二氧化氯50%", "三氯20G", "三氯90%"]),
  tags: [],                  // 池塘分類標籤清單(如:第一區、鱸魚)— 純字串
  pondTags: {},              // { 池塘id: [標籤...] } — 每池貼哪些標籤
  nodePonds: {}              // { 板子id: 池塘id } — 斷電偵測板綁哪個池塘(告警以池塘為單位開關)
};

// 各選項欄位的中文標題(設定頁用)。pondTags 不在此(它不是單純清單)
const OPTION_LABELS = {
  ponds: "池塘名稱",
  feedNos: "飼料編號",
  mixes: "拌料",
  disinfectants: "消毒劑",
  tags: "群組"
};

// ---------- 全域狀態 ----------
let db = null;
let cloudSynced = false;    // 目前資料是否已與雲端同步(false=離線/同步中,寫入暫存本機)
let pendingRecordIds = new Set();   // 畫面上標「上傳中」的紀錄(只在這支手機上)
let pendingRaw = new Set();         // snapshot 裡 hasPendingWrites 的紀錄(含剛送出的)
const holdPending = new Set();      // 新增 / 編輯按鈕還在轉的那筆:雲端就算先確認了,也標到按鈕轉完,兩邊同時結束
const quietPending = new Set();     // 只是背景補溫度的那筆(紀錄本身已存好):不標「上傳中」,免得已新增又閃一次
let slowWrites = 0;                 // 等超過 10 秒還沒確認、已先放開的寫入(含刪除、設定這類不在紀錄清單裡的)
let persistOff = false;             // 離線保存沒開成功:沒上傳的寫入只在記憶體,關掉分頁就沒了
let recordsFirstSnap = false;       // 紀錄已收到第一次 snapshot(之前一律顯示「連線中」)
let recordsListenErr = "";          // 紀錄 listener 出錯(之後不會再更新)
let savingRecord = false;           // 新增中(等溫度那幾秒):按鈕維持停用,避免按兩次記成兩筆
let allRecords = [];        // 由 Firestore 即時同步的全部紀錄(含 id)
let options = { ...DEFAULT_OPTIONS };
let editingId = null;       // 目前正在編輯的紀錄 id(null = 新增模式)
let currentPeriod = "morning";

// ---------- 上次使用的時段/飼料(記到 localStorage,新增/編輯後不必重選)----------
// 時段與飼料通常連續(魚不太可能短時間換飼料),記住最後一次選擇當預設值。
const LAST_CTX_KEY = "yutun-last-ctx";
function loadLastCtx() {
  try { return JSON.parse(localStorage.getItem(LAST_CTX_KEY)) || {}; } catch { return {}; }
}
function saveLastCtx(period, feedNoId) {
  try { localStorage.setItem(LAST_CTX_KEY, JSON.stringify({ period, feedNoId })); } catch {}
}

let unsubscribers = [];                       // Firestore 訂閱取消函式

// ---------- 小工具 ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function todayStr() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function thisMonthStr() {
  return todayStr().slice(0, 7); // YYYY-MM
}
function setSync(status, text) {
  const el = $("#syncStatus");
  el.className = "sync-status " + (status || "");
  el.textContent = text;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function periodLabel(p) { return p === "afternoon" ? "下午" : "早上"; }

// 把 createdAt/updatedAt(Firestore Timestamp 有 toDate(),一般是 ISO 字串)轉 Date;失敗回 null
function tsToDate(ts) {
  if (!ts) return null;
  const d = typeof ts?.toDate === "function" ? ts.toDate() : new Date(ts);
  return isNaN(d) ? null : d;
}
function recordDate(r) { return tsToDate(r.createdAt); }       // 建立時間
function recordUpdatedDate(r) { return tsToDate(r.updatedAt); } // 最後編輯時間
// 一筆紀錄有三個時間,畫面上要分開講:
//   date + period = 紀錄的時間(哪天、早上 / 下午餵的;表單選的,可以改)
//   createdAt     = 建立時間(第一次按「新增」的時刻,不會變)
//   updatedAt     = 最後更新時間(最後一次按「更新」,每次編輯覆蓋)
// 建立 / 更新一律帶日期——只寫時分會被當成是紀錄那天,事後補登就看不出來。
// Date →「10/03 08:12」;不是今年的補年份「2025/12/30 08:12」
function fmtStamp(d) {
  if (!d) return "";
  const z = (n) => String(n).padStart(2, "0");
  const year = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}/` : "";
  return `${year}${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}
// Date → 本地日期「YYYY-MM-DD」(和紀錄的 date 欄同格式)
function localDateStr(d) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
// 事後補登:建立那天和紀錄的日期不同
function recordIsBackfill(r) {
  const c = recordDate(r);
  return !!(c && r.date && localDateStr(c) !== r.date);
}
// 「建立 10/03 08:12(補登)・更新 10/15 14:03」;沒有時間的舊紀錄回空字串。純文字(呼叫端自行 escape)
function recordStampLine(r) {
  const c = recordDate(r), u = recordUpdatedDate(r);
  const parts = [];
  if (c) parts.push(`建立 ${fmtStamp(c)}${recordIsBackfill(r) ? "(補登)" : ""}`);
  if (u) parts.push(`更新 ${fmtStamp(u)}`);
  return parts.join("・");
}
// 取建立時間毫秒(供排序);無 createdAt 回 0
function recordTimeMs(r) {
  const d = recordDate(r);
  return d ? d.getTime() : 0;
}

// ---------- 選項 id → 名稱 解析(找不到時給 fallback,理論上不該發生)----------
function optNameById(key, id) {
  if (!id) return "";
  const hit = (options[key] || []).find((it) => it.id === id);
  return hit ? hit.name : "(已刪除)";
}
// 用名稱反查 id(主要給「手打新池塘名」時找既有 id;找不到回 null)
function optIdByName(key, name) {
  if (!name) return null;
  const hit = (options[key] || []).find((it) => it.name === name);
  return hit ? hit.id : null;
}
function feedName(id) { return id ? optNameById("feedNos", id) : ""; }
function mixName(id) { return id ? optNameById("mixes", id) : ""; }
function disinfectantName(id) { return id ? optNameById("disinfectants", id) : ""; }
function pondName(id) { return id ? optNameById("ponds", id) : ""; }

// 池塘顯示名:有標籤時附上「池名(標籤-標籤)」,無標籤則只回池名。參數為池塘 id。
function pondLabel(pondId) {
  const name = pondName(pondId);
  const tags = (options.pondTags || {})[pondId] || [];
  return tags.length ? `${name}(${tags.join("-")})` : name;
}

// 某標籤(群組)包含哪些池塘 → 回傳「池塘 id」集合
function pondsWithTag(tag) {
  const set = new Set();
  for (const [pondId, tags] of Object.entries(options.pondTags || {})) {
    if ((tags || []).includes(tag)) set.add(pondId);
  }
  return set;
}

// 填充「群組」下拉(共用於查詢/統計)。保留原本「全部」選項的文字。
function fillTagFilter(sel) {
  const prev = sel.value;
  const allText = sel.options[0] ? sel.options[0].textContent : "全部";
  sel.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = ""; allOpt.textContent = allText;
  sel.appendChild(allOpt);
  for (const t of options.tags || []) {
    const o = document.createElement("option");
    o.value = t; o.textContent = t;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

// ============================================================
//  深色 / 淺色主題
// ============================================================
const THEME_KEY = "yutun-theme";          // localStorage:'dark' | 'light'
const THEME_COLOR = { light: "#0b7285", dark: "#1a222b" }; // 對應 header 色,給手機狀態列

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  const btn = $("#themeToggle");
  if (btn) btn.textContent = isDark ? "☀️" : "🌙";
  // 同步更新 PWA 狀態列顏色
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", isDark ? THEME_COLOR.dark : THEME_COLOR.light);
}

function setupTheme() {
  // 優先用使用者上次的選擇;沒有的話跟隨系統偏好
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));

  $("#themeToggle").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });

  // 使用者沒手動選過時,跟著系統設定即時變化
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!localStorage.getItem(THEME_KEY)) applyTheme(e.matches ? "dark" : "light");
  });
}

// ============================================================
//  自訂對話框 / 提示(取代瀏覽器原生 alert / confirm)
// ============================================================
// 顯示確認對話框,回傳 Promise<boolean>。
// cancel:false = 只有一顆確認鈕(單純告知用)
function showConfirm(message, { okText = "確定", danger = false, cancel = true } = {}) {
  return new Promise((resolve) => {
    const overlay = $("#modalOverlay");
    const okBtn = $("#modalOk");
    const cancelBtn = $("#modalCancel");
    $("#modalText").textContent = message;
    okBtn.textContent = okText;
    okBtn.classList.toggle("btn-danger", danger);
    cancelBtn.hidden = !cancel;

    const close = (result) => {
      overlay.hidden = true;
      cancelBtn.hidden = false;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onBackdrop = (e) => { if (e.target === overlay) close(false); };
    const onKey = (e) => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    overlay.hidden = false;
    okBtn.focus();
  });
}

// 文字輸入對話框(取代 prompt)。回傳輸入字串;取消回傳 null。
// validate(value):選填。回傳非空字串=錯誤訊息,此時不關閉 modal、顯示錯誤、保留輸入;
// 回傳空/undefined=通過。
function showPrompt(message, defaultValue = "", { okText = "儲存", validate = null } = {}) {
  return new Promise((resolve) => {
    const overlay = $("#modalOverlay");
    const okBtn = $("#modalOk");
    const cancelBtn = $("#modalCancel");
    const input = $("#modalInput");
    const baseMsg = message;
    $("#modalText").textContent = baseMsg;
    okBtn.textContent = okText;
    okBtn.classList.remove("btn-danger");
    input.hidden = false;
    input.value = defaultValue;

    const close = (result) => {
      overlay.hidden = true;
      input.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    // 嘗試送出:先過 validate,有錯就留在 modal 顯示錯誤、不關閉
    const trySubmit = () => {
      const val = input.value.trim();
      if (validate) {
        const err = validate(val);
        if (err) { $("#modalText").textContent = `${baseMsg}\n⚠️ ${err}`; input.focus(); input.select(); return; }
      }
      close(val);
    };
    const onOk = () => trySubmit();
    const onCancel = () => close(null);
    const onBackdrop = (e) => { if (e.target === overlay) close(null); };
    const onKey = (e) => {
      if (e.key === "Escape") close(null);
      if (e.key === "Enter") { e.preventDefault(); trySubmit(); }
    };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    overlay.hidden = false;
    input.focus();
    input.select();
  });
}

// 短訊提示(取代資訊型 alert)。isErr=true 顯示紅底。
let toastTimer = null;
// 紅字(錯誤)還沒到時間前,一般提示不能蓋掉它——錯誤常常是唯一的線索。
let toastErrUntil = 0, toastHoldIsErr = false;
// hold:這則顯示期間,一般提示不能蓋掉(錯誤一律 hold;「網路很慢」那則也要 hold,
// 不然緊接著的「已設定…」會把它蓋掉)
function showToast(message, isErr = false, ms = 2600, hold = isErr) {
  const el = $("#toast");
  if (!isErr && Date.now() < toastErrUntil) return 0;
  el.textContent = message;
  el.className = "toast" + (isErr ? " err" : "") + (message.length > 26 ? " long" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  toastErrUntil = hold ? Date.now() + ms : 0;
  toastHoldIsErr = isErr;
}

// 寫入結果的用字(新增 / 編輯按鈕用)
const WRITE_TEXT = {
  新增: { ack: "✔ 已上傳", fail: "這筆沒有記到" },
  更新: { ack: "✔ 修改已上傳", fail: "這次修改沒有存到" },
};
// 寫入失敗:要按才會關的對話框,寫清楚哪一筆沒記到(英文錯誤原文只進 console)
function showWriteFail(verb, what, err) {
  showFailDialog(`${WRITE_TEXT[verb].fail}${what ? ` ${what}` : ""}`, err);
}
// 失敗對話框:title =「這筆沒有記到 北 3包」這類,底下一句原因
function showFailDialog(title, err) {
  console.error(err);
  const why = err?.code === "permission-denied" ? "雲端拒收(權限不符)。"
    : err?.name === "AbortError" || err?.name === "TypeError" ? "網路有問題,請確認網路後再試一次。"
    : `請再試一次。(錯誤代碼:${err?.code || err?.message || "unknown"})`;
  showConfirm(`⚠ ${title}\n\n${why}`, { okText: "知道了", cancel: false });
}

// 其他寫入(刪除紀錄、設定頁、板子頁)都走這裡:畫面中間轉圈「儲存中…」至少 1 秒,
// 這段期間擋住其他操作(避免連按、或還沒存好就去做下一件事);等真的完成才算成功。
// 回傳 "ok"(已完成)/ "slow"(網路很慢,已記在手機、會自動補傳)/ false(失敗,已跳對話框)。
//   local:true  = Firestore:沒網路時會先存在手機、之後自動上傳 → 等太久不算失敗
//   local:false = 板子頁的通知開關(RTDB,用 fetch 直接寫):不會先存在手機 → 沒成功就是沒存到
let busyCount = 0;
function showBusy(label) {
  busyCount++;
  $("#busyText").textContent = label;
  $("#busyOverlay").hidden = false;
}
function hideBusy() {
  if (--busyCount <= 0) { busyCount = 0; $("#busyOverlay").hidden = true; }
}
async function busyWrite(label, writeFn, { fail, local = true }) {
  const startedAt = Date.now();
  showBusy(label);
  let res, write;
  try {
    write = Promise.resolve().then(writeFn);
    res = await waitWrite(write, startedAt);
  } catch (err) {
    res = { ok: false, err };
  } finally {
    hideBusy();
  }
  if (res.ok) return "ok";
  if (res.slow && local) {
    showToast("⏳ 網路很慢,還在上傳中。已記在這支手機,會自動補傳,不用重做。", false, 7000, true);
    slowWrites++;
    renderSyncStatus();
    // 真的上傳了:可以蓋過自己那則「網路很慢」(但不蓋錯誤提示)
    write.then(() => { if (!toastHoldIsErr) toastErrUntil = 0; showToast("✔ 剛剛的變更已上傳"); }, (err) => showFailDialog(fail, err))
      .finally(() => { slowWrites--; renderSyncStatus(); });
    return "slow";
  }
  showFailDialog(fail, res.err || Object.assign(new Error("timeout"), { name: "AbortError" }));
  return false;
}


// 新增 / 編輯的「按下去等結果」:按鈕轉圈顯示上傳中,至少轉 WRITE_MIN_SPIN_MS(太快一閃而過看不出有在上傳),
// 等雲端確認才算成功。回傳 { ok } / { ok:false, err } / { slow:true }:
//   slow = 等了 WRITE_SLOW_MS 還沒確認。這時不能說「沒有記到」——那筆已經存在手機、之後會自動上傳,
//   說沒記到家人會重記一次變兩筆;所以先放開按鈕,讓清單的 ⏳ 和之後的「✔ 已上傳」接手。
const WRITE_MIN_SPIN_MS = 1000;
const WRITE_SLOW_MS = 10000;
function waitWrite(promise, startedAt = Date.now()) {
  const atLeast = (v) => new Promise((r) => setTimeout(() => r(v), Math.max(0, WRITE_MIN_SPIN_MS - (Date.now() - startedAt))));
  return Promise.race([
    promise.then(() => atLeast({ ok: true }), (err) => atLeast({ ok: false, err })),
    new Promise((r) => setTimeout(() => r({ slow: true }), Math.max(0, WRITE_SLOW_MS - (Date.now() - startedAt)))),
  ]);
}
// 等太久先放開之後:真的上傳了補一句,真的失敗了跳對話框
function followSlowWrite(promise, verb, what) {
  slowWrites++;
  renderSyncStatus();
  promise.then(() => { if (!toastHoldIsErr) toastErrUntil = 0; showToast(`${WRITE_TEXT[verb].ack} ${what}`); }, (err) => showWriteFail(verb, what, err))
    .finally(() => { slowWrites--; renderSyncStatus(); });
}
const SPIN_HTML = (text) => `<span class="btn-spin" aria-hidden="true"></span>${text}`;

// header 的同步狀態:有沒上傳的紀錄就直接寫幾筆(比「已同步」準:那只代表讀得到雲端)
// 點一下 header 狀態看完整說明(手機看不到 title)
const SYNC_HELP_PERSIST_OFF = "這個瀏覽器沒辦法把還沒上傳的紀錄存在手機裡。網路不好時新增的紀錄,上傳完前關掉 App 就會不見。";
const SYNC_HELP_PENDING = "這幾筆還在這支手機上,網路恢復、App 開著時會自動上傳。上傳前請不要清除瀏覽器資料或刪掉 App。";
function syncPendingCount() {
  // 同一筆新增會同時算在兩邊 → 取大的,不相加
  return Math.max(pendingRecordIds.size, slowWrites);
}
function renderSyncStatus() {
  const el = $("#syncStatus");
  if (!el || !db) return;
  const n = syncPendingCount();
  const warn = persistOff ? "・⚠ 未離線保存" : "";
  // 上傳中的筆數:接在同步狀態後面的橘色小標籤(有才出現),一眼就看得到
  const pend = $("#syncPending");
  if (pend) {
    pend.hidden = !n;
    pend.textContent = n ? `⏳ ${n} 筆上傳中` : "";
    pend.title = n ? SYNC_HELP_PENDING : "";
  }
  if (recordsListenErr) setSync("err", `讀取紀錄失敗${warn}`);
  else if (!recordsFirstSnap) setSync("", `魚塭連線中${warn}`);
  else if (cloudSynced) setSync("ok", `紀錄已同步${warn}`);
  else setSync("pending", persistOff ? "離線・⚠ 關掉會遺失" : "離線(資料暫存本機)");
  el.title = persistOff ? SYNC_HELP_PERSIST_OFF : "";
  el.classList.toggle("has-help", !!el.title);
}
// pendingRaw + holdPending → pendingRecordIds。按下新增那一刻就標「上傳中」(不延遲),
// 清單和按鈕的「上傳中」同時開始、同時結束。
function refreshPending() {
  const next = new Set([...[...pendingRaw].filter((id) => !quietPending.has(id)), ...holdPending]);
  const changed = next.size !== pendingRecordIds.size || [...next].some((id) => !pendingRecordIds.has(id));
  pendingRecordIds = next;
  return changed;
}
// 背景補溫度這類小更新:紀錄本身已經在雲端了,不標「上傳中」
async function quietUpdate(ref, data) {
  quietPending.add(ref.id);
  try { return await updateDoc(ref, data); }
  finally { quietPending.delete(ref.id); refreshPending(); renderSyncStatus(); renderTodayList(); renderList(); }
}
// 按鈕轉完:放開這筆的「上傳中」標記(雲端真的還沒確認的話,pendingRaw 會讓它繼續標著)
function releaseHold(id) {
  holdPending.delete(id);
  refreshPending();
  renderSyncStatus();
  renderTodayList();
  renderList();
}

// ============================================================
//  Firebase 初始化
// ============================================================
// 試開一個 IndexedDB(開完就關):開不了 = 這個瀏覽器不能離線保存
function probeIndexedDb() {
  return new Promise((resolve) => {
    try {
      if (!window.indexedDB) return resolve(false);
      const req = indexedDB.open("fishpond-persist-probe");
      // 試完就刪掉,不在瀏覽器裡留一個空的資料庫
      req.onsuccess = () => { try { req.result.close(); indexedDB.deleteDatabase("fishpond-persist-probe"); } catch {} resolve(true); };
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(true);
    } catch { resolve(false); }
  });
}

function initFirebase() {
  if (firebaseConfig.apiKey.startsWith("請填入")) {
    setSync("err", "未設定 Firebase");
    showConfigHint();
    return false;
  }
  // 沒有秘密路徑就不連線:否則會把資料寫到 /p/(空)/ 這種錯的地方(見 firebase-config.js)
  if (!dbSecret) {
    setSync("err", "未設定資料庫路徑");
    return false;
  }
  try {
    const app = initializeApp(firebaseConfig);
    // 離線保存:還沒上傳的寫入存在手機(IndexedDB),關掉 App 也不會掉,下次上線自動補傳。
    // 用多分頁共用的版本(舊的 enableIndexedDbPersistence 同時只能一個分頁用,
    // 電腦開兩個分頁、或 Android 的 Chrome 分頁 + 主畫面 App 同時開,後開的就沒有離線保存)。
    // 必須在任何 Firestore 操作之前呼叫。
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
    // 這個寫法失敗時 SDK 只會自己退回記憶體(不丟錯),所以另外試開一次 IndexedDB:
    // 開不了(瀏覽器不支援 / 被封鎖)就標記 persistOff,header 一直顯示警告。
    probeIndexedDb().then((ok) => { if (!ok) { persistOff = true; renderSyncStatus(); } });
    // 不能離線保存、又有還沒上傳的 → 離開前讓瀏覽器問一下。
    // 只在電腦上有用:手機滑掉 App、切走、被系統回收都不會觸發,主要防線是 header / 清單的標示。
    window.addEventListener("beforeunload", (e) => {
      if (persistOff && syncPendingCount()) { e.preventDefault(); e.returnValue = ""; }
    });
    // header 的同步狀態:有說明時點一下看完整說明(手機看不到 title)
    for (const sel of ["#syncStatus", "#syncPending"]) {
      $(sel)?.addEventListener("click", (e) => {
        const t = e.currentTarget.title;
        if (t) showConfirm(t, { okText: "知道了", cancel: false });
      });
    }
    return true;
  } catch (e) {
    console.error(e);
    setSync("err", "連線失敗");
    return false;
  }
}

function showConfigHint() {
  const banner = document.createElement("div");
  banner.style.cssText = "background:#fff3bf;color:#846200;padding:12px 16px;text-align:center;font-size:.9rem;";
  banner.innerHTML = "⚠️ 尚未設定 Firebase 金鑰。請依 <b>DEPLOY.md</b> 填好 <b>firebase-config.js</b> 才能儲存資料。";
  document.body.insertBefore(banner, $("#main"));
}

// ---------- 訂閱 Firestore(即時同步) ----------
function subscribeData() {
  // 1) 選項設定
  const optRef = doc(db, ...DB_ROOT, "settings", "options");
  // includeMetadataChanges:讓「快取不存在 → 雲端確認不存在」這種純 metadata 變化也會再觸發一次
  unsubscribers.push(onSnapshot(optRef, { includeMetadataChanges: true }, async (snap) => {
    if (!snap.exists()) {
      // 本機快取沒有這份文件(新裝置/清過資料)又剛好離線時,會先收到 fromCache 的「不存在」。
      // 這時寫預設值會在連線後把雲端真設定整份蓋掉(2026-10-12 事故)→ 只在雲端確認不存在才寫。
      if (snap.metadata.fromCache) return;
      // 首次:寫入預設值
      await setDoc(optRef, DEFAULT_OPTIONS);
      options = { ...DEFAULT_OPTIONS };
    } else {
      const data = snap.data();
      // 補齊可能缺少的 key
      options = { ...DEFAULT_OPTIONS, ...data };
      optionsReady = true;
    }
    renderOptionSelects();
    renderSettings();
    renderPondFilter();
    renderNodeHeader();   // 板子綁的池塘會影響告警狀態 → header 總結
    renderRecordTags();
    syncAlertGroups();   // 池塘 / 綁定可能變了 → 同步 watchdog 的告警群組(名稱、成員)
  }, (err) => { console.error(err); setSync("err", "讀取設定失敗"); }));

  // 2) 紀錄
  const q = query(collection(db, ...DB_ROOT, "records"), orderBy("date", "desc"));
  unsubscribers.push(onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    // serverTimestamps:"estimate":還沒上傳的 createdAt / updatedAt 先用本機時間估(只影響讀出來的值),
    // 否則是 null → 剛記的那筆沒有時間、排到當天最下面
    allRecords = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    // fromCache=true 代表尚未與雲端同步(離線或同步中);hasPendingWrites=這筆有本地未上傳的寫入。
    // 雲端確認收到時(includeMetadataChanges)會再觸發一次,hasPendingWrites 變 false → 標記消失
    cloudSynced = !snap.metadata.fromCache;
    recordsFirstSnap = true;
    pendingRaw = new Set(snap.docs.filter((d) => d.metadata.hasPendingWrites).map((d) => d.id));
    refreshPending();
    renderSyncStatus();
    updateSaveDisabled();   // 連線狀態變了 → 連動新增鈕可否按
    renderList();
    renderStatsView();
    renderPondFilter();
    renderTodayList();
    // 同步到最新後,順手補仍 pending 的溫度(只在已連雲端時試,離線無意義)
    if (cloudSynced) retryPendingSiteTemp();
  }, (err) => {
    console.error(err); cloudSynced = false;
    recordsListenErr = err?.code || "error";
    renderSyncStatus(); updateSaveDisabled();
  }));
}

// 解除所有 Firestore 訂閱
function unsubscribeData() {
  unsubscribers.forEach((fn) => { try { fn(); } catch (e) {} });
  unsubscribers = [];
}

// ---------- 啟動資料訂閱 ----------
function startData() {
  if (db) { setSync("", "魚塭連線中"); subscribeData(); }
}

// ============================================================
//  下拉選單渲染
// ============================================================
// items 為帶 id 的選項 [{id,name}]:option 的 value=id、顯示=name(或 labelFn(id))
function fillSelect(sel, items, { allowEmpty = false, emptyLabel = "(不選)", labelFn = null } = {}) {
  const prev = sel.value;
  sel.innerHTML = "";
  if (allowEmpty) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = emptyLabel;
    sel.appendChild(o);
  }
  for (const it of items) {
    const o = document.createElement("option");
    o.value = it.id; o.textContent = labelFn ? labelFn(it.id) : it.name;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function renderOptionSelects() {
  // 池塘:下拉(可空,搭配手動輸入框);顯示文字附上分類標籤
  fillSelect($("#pondSelect"), options.ponds, { allowEmpty: true, emptyLabel: "— 選擇或在下方輸入 —", labelFn: pondLabel });
  fillSelect($("#feedNoSelect"), options.feedNos);
  fillSelect($("#mixSelect"), options.mixes, { allowEmpty: true });
  fillSelect($("#disinfectantSelect"), options.disinfectants, { allowEmpty: true });
  // 選項(重新)載入後,非編輯模式下把飼料帶回上次用的(若該飼料仍存在)
  applyLastFeed();
  renderPondPicker();   // 池塘自訂下拉:同步清單與顯示文字
}

// ---------- 池塘選取(置中 modal,取代原生 select)----------
// 設計:隱藏的 select 仍是真值來源(沿用既有 .value 讀寫與 change 連動);
// 這個 modal 只負責「好按的選取體驗」,選定後寫回 select.value 並觸發 change。
// 同一個 picker modal 服務兩處:新增表單(#pondSelect)與編輯 modal(#editPondSelect)。
const POND_PICKER_TARGETS = {
  add:  { selectId: "#pondSelect",     labelId: "#pondPickerLabel",     btnId: "#pondPickerBtn",     placeholder: "— 選擇或在下方輸入 —" },
  edit: { selectId: "#editPondSelect", labelId: "#editPondPickerLabel", btnId: "#editPondPickerBtn", placeholder: "—" },
};
let pondPickerTarget = POND_PICKER_TARGETS.add;   // 目前開啟者

function setupPondPicker() {
  const overlay = $("#pondPickerOverlay");
  if (!overlay) return;
  $("#pondPickerBtn") && $("#pondPickerBtn").addEventListener("click", () => openPondPicker("add"));
  $("#editPondPickerBtn") && $("#editPondPickerBtn").addEventListener("click", () => openPondPicker("edit"));
  $("#pondPickerClose").addEventListener("click", closePondPicker);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closePondPicker(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) { closePondPicker(); }
  });
}

function openPondPicker(which = "add") {
  pondPickerTarget = POND_PICKER_TARGETS[which] || POND_PICKER_TARGETS.add;
  renderPondPickerList();
  $("#pondPickerOverlay").hidden = false;
  $(pondPickerTarget.btnId)?.setAttribute("aria-expanded", "true");
}
function closePondPicker() {
  const overlay = $("#pondPickerOverlay");
  if (overlay.hidden) return;
  overlay.hidden = true;
  $(pondPickerTarget.btnId)?.setAttribute("aria-expanded", "false");
}

// 依某個 target 的 select.value 更新其觸發鈕顯示文字(預設更新「新增表單」那顆)
function renderPondPicker(which = "add") {
  const t = POND_PICKER_TARGETS[which] || POND_PICKER_TARGETS.add;
  const sel = $(t.selectId), label = $(t.labelId);
  if (!sel || !label) return;
  const v = sel.value;
  if (v) { label.textContent = pondLabel(v); label.classList.remove("placeholder"); }
  else { label.textContent = t.placeholder; label.classList.add("placeholder"); }
}

// 重建 modal 內的池塘清單(來源=目前 target 的隱藏 select);點項目 → 寫回並觸發 change
function renderPondPickerList() {
  const sel = $(pondPickerTarget.selectId), list = $("#pondPickerList");
  if (!sel || !list) return;
  const opts = [...sel.options].filter((o) => o.value !== "");
  if (!opts.length) {
    list.innerHTML = `<li class="pond-picker-empty">尚無池塘,請在下方輸入新名稱</li>`;
    return;
  }
  list.innerHTML = opts.map((o) =>
    `<li class="pond-picker-item${o.value === sel.value ? " selected" : ""}" role="option"
        data-val="${escapeHtml(o.value)}">${escapeHtml(o.textContent)}</li>`).join("");
  list.querySelectorAll("[data-val]").forEach((li) =>
    li.addEventListener("click", () => choosePond(li.dataset.val)));
}

function choosePond(id) {
  const sel = $(pondPickerTarget.selectId);
  sel.value = id;
  sel.dispatchEvent(new Event("change"));   // 觸發各自的連動
  renderPondPicker(pondPickerTarget === POND_PICKER_TARGETS.edit ? "edit" : "add");
  closePondPicker();
}

// 把新增表單的飼料下拉設成上次使用的(該飼料仍在清單中時)
function applyLastFeed() {
  const sel = $("#feedNoSelect");
  if (!sel) return;
  const last = loadLastCtx().feedNoId;
  if (last && [...sel.options].some((o) => o.value === last)) sel.value = last;
}

// 填一個「池塘」篩選下拉:清單 = 設定的池塘 ∪ 紀錄出現過的池塘(以 id 為準)
// tag 有值時,只列出屬於該群組的池塘(避免選了群組還能挑到別群組的池子)
function fillPondFilter(sel, tag) {
  const prev = sel.value;
  const ids = new Set(options.ponds.map((p) => p.id));
  allRecords.forEach((r) => r.pondId && ids.add(r.pondId));
  let pondIds = [...ids];
  if (tag) { const inTag = pondsWithTag(tag); pondIds = pondIds.filter((id) => inTag.has(id)); }
  // 依顯示名稱排序
  pondIds.sort((a, b) => pondName(a).localeCompare(pondName(b), "zh-Hant"));
  sel.innerHTML = '<option value="">全部</option>';
  for (const id of pondIds) {
    const o = document.createElement("option");
    o.value = id; o.textContent = pondLabel(id);
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function renderPondFilter() {
  fillTagFilter($("#listTagFilter"));        // 群組下拉(查詢頁)
  fillTagFilter($("#statsTagFilter"));       // 群組下拉(統計頁)
  fillPondFilter($("#listPondFilter"), $("#listTagFilter").value);    // 池塘下拉(查詢頁)
  fillPondFilter($("#statsPondFilter"), $("#statsTagFilter").value);  // 池塘下拉(統計頁)
}

// ============================================================
//  記錄頁
// ============================================================
function setupRecordForm() {
  $("#dateInput").value = todayStr();

  // 還原上次選的時段(預設 morning),並同步分段按鈕外觀
  currentPeriod = loadLastCtx().period || "morning";
  $$("#periodSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.period === currentPeriod));

  // 改日期 → 更新「當日已記錄」清單
  $("#dateInput").addEventListener("change", renderTodayList);

  // 時段切換
  $("#periodSeg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    currentPeriod = btn.dataset.period;
    $$("#periodSeg .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  });

  // 選了下拉的池塘 → 隱藏並清空手動輸入(強制以下拉為準,避免兩邊衝突);
  // 下拉選回空白 → 顯示輸入框,可打新池塘名。
  $("#pondSelect").addEventListener("change", () => {
    syncPondInputVisibility();
    renderRecordTags();
  });
  setupPondPicker();   // 池塘選取 modal(新增與編輯共用)
  setupEditModal();    // 編輯紀錄獨立 modal
  // 手打池塘名也即時更新標籤區,並連動「新增」按鈕可否按
  $("#pondInput").addEventListener("input", () => { renderRecordTags(); updateSaveDisabled(); });

  // 包數 +/− 按鈕
  $$(".step-btn").forEach((btn) =>
    btn.addEventListener("click", () => stepBags(btn.dataset.step, Number(btn.dataset.dir))));

  // 打字輸入時即時修正:只留數字
  $("#bagsInt").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "");      // 只留數字
  });
  // 失焦時若留空,補回 0,避免空白
  $("#bagsInt").addEventListener("blur", (e) => { if (e.target.value === "") e.target.value = "0"; });

  $("#recordForm").addEventListener("submit", onSaveRecord);

  updateSaveDisabled();   // 初始:尚未選池塘 → 按鈕置灰
}

// 依下拉狀態決定輸入框顯示與否:選了既有池塘就隱藏+清空輸入框
function syncPondInputVisibility() {
  const picked = $("#pondSelect").value;
  const input = $("#pondInput");
  if (picked) { input.value = ""; input.hidden = true; }
  else { input.hidden = false; }
  updateSaveDisabled();   // 池塘狀態變了,連動「新增/更新」按鈕可否按
}

// 防呆:兩個條件都成立才可按「新增/更新」——
//   1. 有選(或手打)池塘名
//   2. 已與雲端同步:沒連上 DB 就不讓記,避免以為記好了、實際只躺在本機
// 按鈕文字會說明是哪個原因擋住,不然使用者只看到一顆灰掉的鈕不知為何。
function updateSaveDisabled() {
  const btn = $("#saveBtn");
  if (!btn) return;
  const hasPond = !!$("#pondSelect").value || $("#pondInput").value.trim() !== "";
  // 記錄中(等溫度那幾秒):snapshot 進來也不能把按鈕重新打開,不然按兩次會記成兩筆
  btn.disabled = savingRecord || !hasPond || !cloudSynced;
  // 儲存動畫進行中(btn-ok-flash)不要蓋掉「✔ 已新增」的回饋文字
  if (savingRecord) btn.innerHTML = SPIN_HTML("上傳中…");
  else if (!btn.classList.contains("btn-ok-flash")) btn.textContent = cloudSynced ? "新增" : "未連線,無法新增";
}

// 讀取包數(整數)
function getBagsValue() {
  const i = parseInt($("#bagsInt").value, 10);
  return isNaN(i) ? 0 : Math.max(0, i);
}

// +/− 按鈕:整數±1(不低於0)
function stepBags(which, dir) {
  const el = $("#bagsInt");
  el.value = Math.max(0, (parseInt(el.value, 10) || 0) + dir);
}

// 記錄頁:依目前選定的池塘,顯示可勾選的標籤(分類)。
// 只有「下拉選了既有池塘(有 id)」才能貼標籤;手打的新池塘要先存檔才有 id。
function renderRecordTags() {
  const box = $("#recordTags");
  const pondId = $("#pondSelect").value;        // 既有池塘才有 id
  const tags = options.tags || [];
  if (!pondId || !tags.length) { box.hidden = true; box.innerHTML = ""; return; }
  const mine = new Set((options.pondTags || {})[pondId] || []);
  box.hidden = false;
  box.innerHTML = `
    <span class="record-tags-label">群組(${escapeHtml(pondName(pondId))}):</span>
    ${tags.map((t) => `
      <button type="button" class="tag-pick ${mine.has(t) ? "on" : ""}" data-rectag="${escapeHtml(t)}">${escapeHtml(t)}</button>
    `).join("")}`;
  box.querySelectorAll("[data-rectag]").forEach((b) =>
    b.addEventListener("click", async () => {
      // togglePondTag 會寫回 Firestore;onSnapshot 回來會更新 options,成功就先即時切換顯示
      if (await togglePondTag(pondId, b.dataset.rectag)) b.classList.toggle("on");
    }));
}

// 紀錄的溫度,依來源分兩種(都是氣溫):
//   siteTemp  魚塭現場板子(2026-08-22 起,主要來源)
//   weather   氣象署文安站(板子還沒裝之前的舊紀錄才有)
function siteTempValue(r) {
  const t = Number(r?.siteTemp?.temp);
  return Number.isFinite(t) ? t : null;
}
function stationTempValue(r) {
  const w = r?.weather;
  const t = Number(w?.temp);
  return w && !w.pending && Number.isFinite(t) ? t : null;
}
// 顯示字串:現場「27.3°C」、測站「28°C(測站)」;都沒有回空字串。
function siteTempStr(r) {
  const s = siteTempValue(r);
  if (s != null) return `${fmt(s)}°C`;
  const w = stationTempValue(r);
  return w != null ? `${fmt(w)}°C(測站)` : "";
}

// 把一筆紀錄轉成條列文字:池塘 - 時段 - 飼料 - N包 - 拌料 - 消毒 - 備註(空欄略過)
function recordSummaryLine(r) {
  const parts = [
    pondLabel(r.pondId),
    periodLabel(r.period),
    feedName(r.feedNoId),
    `${fmt(Number(r.bags) || 0)}包`,
    mixName(r.mixId),
    disinfectantName(r.disinfectantId),
    r.note
  ].filter((x) => x != null && String(x).trim() !== "");
  return parts.map(escapeHtml).join(" - ");
}

// 把一筆紀錄轉成「欄位名稱:值」的多行純文字(給刪除確認等需要看完整內容的地方)。
// 空欄一律顯示「—」,讓使用者清楚知道刪掉的是哪一筆、有哪些內容。
function recordDetailText(r) {
  if (!r) return "";
  const dash = (v) => (v != null && String(v).trim() !== "" ? String(v) : "—");
  const temp = siteTempStr(r);
  const lines = [
    ["日期", dash(r.date)],
    ["時段", dash(periodLabel(r.period))],
    ["池塘", dash(pondLabel(r.pondId))],
    ["飼料", dash(feedName(r.feedNoId))],
    ["包數", `${fmt(Number(r.bags) || 0)}包`],
    ["拌料", dash(mixName(r.mixId))],
    ["消毒劑", dash(disinfectantName(r.disinfectantId))],
    ["溫度", temp ? temp : "—"],
    ["備註", dash(r.note)],
  ];
  const c = recordDate(r), u = recordUpdatedDate(r);
  if (c) lines.push(["建立", fmtStamp(c) + (recordIsBackfill(r) ? "(補登)" : "")]);
  if (u) lines.push(["更新", fmtStamp(u)]);
  return lines.map(([k, v]) => `${k}:${v}`).join("\n");
}

// 記錄頁上方:列出「日期欄」當天已記錄的清單,點可編輯
function renderTodayList() {
  const box = $("#todayList");
  const date = $("#dateInput").value;
  if (!date) { box.innerHTML = ""; return; }
  const recs = allRecords
    .filter((r) => r.date === date)
    // 依建立時間新→舊(剛記的在最上);無 createdAt 退回用時段排
    .sort((a, b) => {
      const ta = recordTimeMs(a), tb = recordTimeMs(b);
      if (ta !== tb) return tb - ta;
      return (a.period === "morning" ? 0 : 1) - (b.period === "morning" ? 0 : 1);
    });

  if (!recs.length) {
    box.innerHTML = `<div class="today-head">${escapeHtml(date)}</div><p class="today-empty">這天還沒有紀錄</p>`;
    return;
  }
  // 還沒上傳的:標題寫幾筆,那一列整列橘底 + 一行字說明(網路很慢時,要在這裡就看得到)
  const pendingN = recs.filter((r) => pendingRecordIds.has(r.id)).length;
  box.innerHTML = `
    <div class="today-head">${escapeHtml(date)} 已記錄 ${recs.length} 筆${pendingN ? `<b class="today-pending-count">・⏳ ${pendingN} 筆上傳中</b>` : ""} <span class="today-hint">(點擊可編輯)</span></div>
    ${recs.map((r) => {
      const label = recordStampLine(r);
      const timeTag = label ? `<span class="today-time">${escapeHtml(label)}</span>` : "";
      const t = siteTempStr(r);
      const tempTag = t ? ` <span class="today-temp">${escapeHtml(t)}</span>` : "";
      const editingCls = r.id === editingId ? " editing" : "";   // 目前正在編輯這筆 → 高亮
      const editingTag = r.id === editingId ? ` <span class="today-editing">編輯中</span>` : "";
      const pending = pendingRecordIds.has(r.id);
      const pendingTag = pending ? `<span class="today-pending">⏳ 上傳中・已記在這支手機,會自動補傳</span>` : "";
      return `<button type="button" class="today-item${label ? " has-time" : ""}${pending ? " pending" : ""}${editingCls}" data-edit="${r.id}">${timeTag}${recordSummaryLine(r)}${tempTag}${pendingTag}${editingTag}</button>`;
    }).join("")}`;
  box.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => startEdit(b.dataset.edit)));
}

async function onSaveRecord(e) {
  e.preventDefault();
  if (!db) { showMsg("尚未設定 Firebase,無法儲存", true); return; }

  // 池塘:下拉選了既有池塘 → 直接用其 id;否則為手打的新池塘名 → 找既有 id 或新建一筆
  const pickedId = $("#pondSelect").value;
  const typedName = $("#pondInput").value.trim();
  const bags = getBagsValue();
  if (!pickedId && !typedName) { showMsg("請選擇或輸入池塘名稱", true); return; }
  if (bags <= 0) { showMsg("包數需大於 0", true); return; }

  let pondId = pickedId;
  if (!pondId) {
    // 手打:同名已存在就沿用;否則本地先產 id,連同新池塘一起寫回 Firestore
    pondId = optIdByName("ponds", typedName);
    if (!pondId) {
      pondId = uid();
      addOption("ponds", typedName, pondId).catch((err) => {
        console.error(err);
        showConfirm(`⚠ 新池塘「${typedName}」沒有存到設定,紀錄會顯示不出池塘名稱。請到「設定」頁重新新增這個池塘。`, { okText: "知道了", cancel: false });
      });
    }
  }

  const rec = {
    pondId,
    date: $("#dateInput").value,
    period: currentPeriod,
    bags,
    feedNoId: $("#feedNoSelect").value || "",
    mixId: $("#mixSelect").value || "",
    disinfectantId: $("#disinfectantSelect").value || "",
    note: $("#noteInput").value.trim()
  };
  // 記住這次的時段/飼料,下次新增/編輯後自動帶回(不必重選)
  saveLastCtx(rec.period, rec.feedNoId);

  // 按下去:按鈕轉圈「上傳中…」(至少 1 秒),雲端確認收到才說「已新增」、才清表單;
  // 失敗 → 「沒有記到」,表單內容保留,可以直接再按一次。上方表單只負責「新增」(編輯走獨立 modal)。
  const startedAt = Date.now();
  const what = `${pondLabel(rec.pondId)} ${fmt(rec.bags)}包`;
  savingRecord = true;
  updateSaveDisabled();
  let res, newId = "";
  try {
    // 溫度:0.3 秒內讀到就一起寫;讀不到(網路差時最多要等 3 秒)就先寫紀錄、溫度讀到再補,
    // 這樣按下去那一刻清單就有這筆,不會按鈕在轉、清單卻空等。真的讀不到 → pending,之後從板子歷史補
    const tempP = currentSiteTempField();
    const quick = await Promise.race([tempP, new Promise((r) => setTimeout(() => r(null), 300))]);
    const siteTemp = quick || { pending: true, at: startedAt };
    // 先產生編號再寫入(和 addDoc 一樣是自動編號):一開始就知道是哪一筆,
    // 清單上那筆從出現的那一刻就標「上傳中」,直到按鈕轉完
    const ref = doc(collection(db, ...DB_ROOT, "records"));
    newId = ref.id;
    holdPending.add(newId);
    const write = setDoc(ref, { ...rec, createdAt: serverTimestamp(), siteTemp });
    // 紀錄確認存好之後才補溫度(安靜更新,不標上傳中)
    if (!quick) Promise.all([write, tempP]).then(([, t]) => {
      if (t && !t.pending) quietUpdate(ref, { siteTemp: t }).catch((e) => console.warn("補溫度失敗(之後從板子歷史補):", e));
    }, () => {});
    res = await waitWrite(write, startedAt);
    if (res.slow) followSlowWrite(write, "新增", what);
  } catch (err) {
    res = { ok: false, err };   // 例如資料格式有問題,SDK 當場丟錯
  } finally {
    savingRecord = false;
    if (newId) releaseHold(newId);
  }
  if (res.ok) {
    flashSaveOk("新增");
    showToast(`已新增 ✔ ${what}`);
    resetForm({ keepContext: true });
  } else if (res.slow) {
    // 已經在手機上排隊,之後會自動上傳 → 清表單,免得家人以為沒記到又記一次
    showToast(`⏳ 網路很慢,${what} 還在上傳中。已記在這支手機,會自動補傳,不用重記。`, false, 7000);
    resetForm({ keepContext: true });
  } else {
    showWriteFail("新增", what, res.err);
  }
  updateSaveDisabled();   // 依目前(保留的)池塘狀態決定按鈕可否按
}

// ---------- 溫度:建立當下讀魚塭板子,讀不到就事後從板子歷史補 ----------
// 紀錄欄位 siteTemp:
//   { temp, ts }          已取得(ts = 板子量測時間,unix 秒)
//   { pending: true, at } 待補:at = 要對應的時刻(毫秒,用本機時間 —— 離線建立時
//                         serverTimestamp 要等上線才定,不能代表建立當下)
//   { missing: true, at } 板子歷史在該時段沒資料(板子當時失聯),不再嘗試
// 板子歷史是永久的,所以 pending 不必搶時間:任何一台裝置之後上線、開著 App 就會補上。
async function currentSiteTempField() {
  const t = await latestPondTemp();
  return t ? { temp: t.temp, ts: t.ts } : { pending: true, at: Date.now() };
}

// 歷史 5 分鐘一筆,上傳也有延遲:時刻過了這麼久還查不到,才判定該時段沒資料
const SITE_TEMP_GIVE_UP_MS = 30 * 60 * 1000;

// fillingSiteTemp:正在補的 recordId。查歷史是 async,期間 onSnapshot 可能再觸發一次
// retryPendingSiteTemp,用此 Set 上鎖,確保同一筆同時間只補一次。
const fillingSiteTemp = new Set();
async function fillSiteTemp(r) {
  // 這筆本身還沒上傳完就先不補(補溫度是安靜更新,會蓋掉它的「上傳中」標記);之後會再試
  if (!db || fillingSiteTemp.has(r.id) || pendingRaw.has(r.id)) return;
  fillingSiteTemp.add(r.id);
  try {
    const at = Number(r.siteTemp.at);
    const t = await pondTempAt(at);
    let siteTemp = null;
    if (t) siteTemp = { temp: t.temp, ts: t.ts };
    else if (Date.now() - at > SITE_TEMP_GIVE_UP_MS) siteTemp = { missing: true, at };
    if (siteTemp) await quietUpdate(doc(db, ...DB_ROOT, "records", r.id), { siteTemp });
  } catch (e) { console.warn("補溫度失敗(之後再試):", e); }   // 連不上 RTDB → 維持 pending
  finally { fillingSiteTemp.delete(r.id); }
}

function pendingSiteTempTargets() {
  return allRecords.filter((r) => r.siteTemp && r.siteTemp.pending === true && Number(r.siteTemp.at));
}

// 機會式補溫度:同步完成 / App 回前景 / 取得焦點 / 前景定時器(見 ensureSiteTempTimer)時掃一次。
let retryingSiteTemp = false;
async function retryPendingSiteTemp() {
  if (!db || !cloudSynced || retryingSiteTemp) return;
  const targets = pendingSiteTempTargets();
  if (!targets.length) return;
  retryingSiteTemp = true;
  try {
    for (const r of targets) await fillSiteTemp(r);   // 逐筆,避免一次大量請求
  } finally {
    retryingSiteTemp = false;
  }
  ensureSiteTempTimer();
}

// 前景定時器:有 pending 時每分鐘試一次(剛建立的紀錄要等板子歷史寫進來);
// 只在分頁可見時跑,無待補就自動停掉,不空轉。
const SITE_TEMP_RETRY_INTERVAL_MS = 60 * 1000;
let siteTempTimer = null;
function ensureSiteTempTimer() {
  const needed = document.visibilityState === "visible" && pendingSiteTempTargets().length > 0;
  if (needed && !siteTempTimer) {
    siteTempTimer = setInterval(retryPendingSiteTemp, SITE_TEMP_RETRY_INTERVAL_MS);
  } else if (!needed && siteTempTimer) {
    clearInterval(siteTempTimer);
    siteTempTimer = null;
  }
}

// 送出後:按鈕短暫變色 + 文字回饋(有沒有上傳到雲端看 toast 與清單的 ⏳)
function flashSaveOk(action = "新增") {
  const btn = $("#saveBtn");
  btn.classList.add("btn-ok-flash");
  btn.textContent = `✔ 已${action}`;
  setTimeout(() => {
    btn.classList.remove("btn-ok-flash");
    btn.textContent = "新增";   // 存檔後一律回新增模式
  }, 1200);
}

function showMsg(text, isErr) {
  const el = $("#recordMsg");
  el.textContent = text;
  el.className = "msg " + (isErr ? "err" : "ok");
  if (!isErr) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 2500);
}

// 重設「新增」表單(編輯有獨立 modal,不經過這裡)。
// keepContext=true(新增成功後):保留池塘/日期/時段/飼料/包數,只清空備註、拌料、消毒。
// keepContext=false(整張清回預設)。
function resetForm(opts = {}) {
  const keep = opts.keepContext === true;
  // 這三項每筆通常不同,存檔後一律清空
  $("#mixSelect").value = "";
  $("#disinfectantSelect").value = "";
  $("#noteInput").value = "";
  if (!keep) {
    $("#bagsInt").value = "2";       // 預設 2 包
    $("#dateInput").value = todayStr();
    $("#pondSelect").value = "";
    $("#pondInput").value = "";
    // 時段/飼料帶回上次使用的(連續性高,免重選);預設 morning/第一項
    const ctx = loadLastCtx();
    $("#feedNoSelect").selectedIndex = 0;
    applyLastFeed();
    currentPeriod = ctx.period || "morning";
    $$("#periodSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.period === currentPeriod));
  }
  renderPondPicker();          // 同步池塘自訂下拉顯示文字
  syncPondInputVisibility();   // 同步池塘輸入框顯隱
  renderRecordTags();          // 池塘可能變動或清空,更新標籤區
  renderTodayList();           // 日期可能重設,更新當日清單
}

// ============================================================
//  ESP32 節點心跳(魚塭溫度探頭 + 家中看門狗 + 斷電偵測 A01、A02…)
// ============================================================
// 為什麼用 fetch 而不是 Firebase SDK:那兩片板子寫的是「另一個」Firebase 專案
// (esp32-e7966 的 Realtime Database),與本站的 Firestore(fishpond-log-e4c57)
// 無關。RTDB 的 REST 端點直接 GET 就有 JSON,不必為了讀兩個數字把 RTDB SDK
// 也載進來。規則目前為公開讀取,所以不需要任何憑證。
//
// 判斷失聯的門檻刻意沿用韌體自己的規則:meta.interval × STALE_MULTIPLE。
// watchdog 韌體就是用這個算式決定要不要發 Discord 告警,前端照抄同一套,
// 網站顯示的狀態才不會和 Discord 各說各話。interval 讀不到時退回 60 秒。
const NODE_STALE_MULTIPLE = 5;      // 與 watchdog 的 meta.staleMultiple 一致
const NODE_DEFAULT_INTERVAL = 60;   // meta.interval 缺失時的保底(秒)
const NODE_POLL_MS = 60 * 1000;     // 對齊板子的上傳週期
// 固定的兩片:id → 短名(給家人看的,不用角色名)。watchdog 那片固定放在家裡(刻意與感測器
// 不同地點,魚塭斷電時才有人能發通知),叫「家裡板」。
// pond-site 的探頭在魚塭旁的空氣中,量的是現場氣溫(不是水溫),所以不叫「溫度感測」。
// 這兩片一律列出(RTDB 裡不見了也要看到「還沒收到資料」);其餘板子從 devices 動態讀。
const NODE_LABELS = { "pond-site": "魚塭板子", "watchdog": "家裡板" };
// 斷電偵測板(A01、A02…):新板子開機會自己註冊(registry 的 MAC → 編號)並寫進
// devices/{編號},meta.role = "heartbeat"。App 不寫死清單,有幾片就列幾片。
const isHeartbeat = (node) => node?.meta?.role === "heartbeat" || node?.meta?.group === "heartbeat";

function nodeLabel(id, node) {
  return NODE_LABELS[id] || node?.meta?.name || id;
}
// 依編號排序的斷電偵測板 id(A01、A02…)
function heartbeatIds(data) {
  return Object.keys(data || {}).filter((id) => !NODE_LABELS[id] && isHeartbeat(data[id])).sort();
}
// 不屬於以上任何一類的板子(日後新角色),也列出來,免得被默默忽略
function otherNodeIds(data) {
  return Object.keys(data || {}).filter((id) => !NODE_LABELS[id] && !isHeartbeat(data[id])).sort();
}

let nodeTimer = null;
let nodeFetching = false;

// 一段時間的短句:給「沒回報 12 分鐘」用。用「已經多久」而不是「幾分前」——
// 「失聯 50 分前」會被讀成「50 分鐘前失聯」,其實意思是「已經 50 分鐘沒消息」。
function nodeAgoText(sec) {
  if (sec < 60) return `${Math.max(0, Math.round(sec))} 秒`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分鐘`;
  if (sec < 86400) return `${Math.round(sec / 3600)} 小時`;
  return `${Math.round(sec / 86400)} 天`;
}
// 時:分(補零)
function nodeHm(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
// 「最後回報」用:「1 分鐘前(01:55)」;不是今天的補日期「10/16 22:35」
function nodeRelTime(ts) {
  const n = Number(ts);
  if (!n) return "—";
  if (!nodeTimeValid(n)) return "剛開機,時間還在對";
  const d = new Date(n * 1000);
  const ago = Date.now() / 1000 - n;
  const when = d.toDateString() === new Date().toDateString() ? nodeHm(d) : `${d.getMonth() + 1}/${d.getDate()} ${nodeHm(d)}`;
  return ago < 60 ? `剛剛(${when})` : `${nodeAgoText(ago)}前(${when})`;
}

// 板子回報的 unix 秒是否可信(見 nodeState 的說明)
const nodeTimeValid = (ts) => Number(ts) > 978307200;   // 2001-01-01

// 單一節點 → { cls, text }。cls 對應 header 那組 ● 顏色。
function nodeState(id, node) {
  const label = nodeLabel(id, node);
  if (!node) { delete nodeAge[id]; return { cls: "err", text: `${label} 還沒收到資料` }; }
  const ts = Number(node?.latest?.ts);
  if (!ts) { delete nodeAge[id]; return { cls: "err", text: `${label} 還沒收到資料` }; }
  // 板子剛開機、還沒向 NTP 校時就寫入時,ts 只是「開機後第幾秒」(例如 18),
  // 當成 unix 時間會算成「沒回報 2 萬天」。早於 2001 年的一律視為剛開機、時間還沒對好。
  if (!nodeTimeValid(ts)) { delete nodeAge[id]; return { cls: "pending", text: `${label} 剛開機` }; }

  const interval = Number(node?.meta?.interval) || NODE_DEFAULT_INTERVAL;
  const age = Date.now() / 1000 - ts;          // 板子寫的是 unix 秒
  const stale = interval * NODE_STALE_MULTIPLE;
  nodeAge[id] = age;                           // 給斷電偵測總結挑「最久沒回報」那片

  // 活著:有溫度就顯示氣溫(它本身就證明有在回報,比「正常」兩個字有用)
  if (age <= stale) {
    const temp = Number(node?.latest?.temp);
    return { cls: "ok", text: Number.isFinite(temp) ? `${label} 氣溫 ${temp.toFixed(1)}°C` : `${label} 正常` };
  }
  // 逾時但還不久(約 5~30 分鐘):黃燈。watchdog 這時已經傳 Discord,沒人按 ✅ 約 10 分鐘後才打電話
  return { cls: age <= stale * 6 ? "pending" : "err", text: `${label} 沒回報 ${nodeAgoText(age)}` };
}
// 剛開機、時間還沒對好(這時 watchdog 不會通知)
const nodeJustBooted = (node) => { const ts = Number(node?.latest?.ts); return !!ts && !nodeTimeValid(ts); };
// 暫停通知中的板子(家裡板自己不在通知範圍,永遠不算)
const nodeMuted = (id) => id !== "watchdog" && !alertState(id).on;
// 去掉名稱的狀態字(卡片 / modal 標題旁用):「沒回報 12 分鐘」;正常有氣溫的只寫「正常」
function nodeStateShort(id, node) {
  const st = nodeState(id, node);
  const t = st.text.replace(nodeLabel(id, node), "").trim();
  return st.cls === "ok" ? "正常" : t;
}
const nodeAge = {};

// 斷電偵測板的 header 總結:板子一多不能逐片列,只列一顆 ●。
// 暫停通知的板子不算進燈號(那是「知道了、先別吵」的意思,header 不該再喊紅燈),
// 但要用字寫出來有幾片暫停——只寫「1/1 正常」會讓人以為全部都好。
//   全部正常 → 「斷電偵測 3 片正常」(有暫停的:「斷電偵測 1 片正常・3 片暫停通知」)
//   有狀況   → 直接點名最久沒回報那片,例如「斷電偵測 A02 沒回報 5 分鐘」;多片再加「等 N 片」
//   全部暫停 → 灰燈「斷電偵測 全部暫停通知」
function heartbeatSummary(data) {
  const ids = heartbeatIds(data);
  if (!ids.length) return null;
  const watched = ids.filter((id) => alertState(id).on);
  const muted = ids.length - watched.length;
  const tail = muted ? `・${muted} 片暫停通知` : "";
  if (!watched.length) return { cls: "unknown", text: `斷電偵測 全部暫停通知` };
  const states = watched.map((id) => ({ id, ...nodeState(id, data[id]) }));
  const bad = states.filter((s) => s.cls !== "ok");
  if (!bad.length) return { cls: "ok", text: `斷電偵測 ${watched.length} 片正常${tail}` };
  const worst = bad.slice().sort((a, b) => (nodeAge[b.id] || 0) - (nodeAge[a.id] || 0))[0];
  const cls = bad.some((s) => s.cls === "err") ? "err" : "pending";
  return { cls, text: `斷電偵測 ${worst.text}${bad.length > 1 ? ` 等 ${bad.length} 片` : ""}${tail}` };
}

// 用最近一次抓到的 devices 畫 header。告警設定(alertCtl)讀到 / 改了之後也會重畫,
// 所以剛開 App 時關了告警的板子可能先閃一下,讀到設定就消失。
function renderNodeHeader() {
  const el = $("#nodeStatus");
  const data = nodeLastData;
  if (!el || !data) return;
  // 固定兩片一律列出(不 filter):某片在 RTDB 裡整個不見,本身就是要看到的狀態,
  // 悄悄少一個反而看不出是哪片出事。nodeState 收到 undefined 會回「還沒收到資料」。
  // 斷電偵測板只列一顆總結 ●;其他未知角色的板子(日後新增)逐片列。
  const ids = Object.keys(NODE_LABELS);
  const states = ids.map((id) => {
    const st = nodeState(id, data[id]);
    if (id !== "pond-site") return st;
    // 魚塭板子在 header 不寫名字:正常只顯示「● 27.2°C」;有狀況寫「氣溫沒回報 12 分鐘」(光寫沒回報看不出是哪片)
    const temp = Number(data[id]?.latest?.temp);
    return { ...st, text: st.cls === "ok" && Number.isFinite(temp) ? `${temp.toFixed(1)}°C` : `氣溫${nodeStateShort(id, data[id])}` };
  });
  const hb = heartbeatSummary(data);
  if (hb) states.push(hb);
  for (const id of otherNodeIds(data)) states.push(nodeState(id, data[id]));
  el.innerHTML = states
    .map((s) => `<span class="node-dot ${s.cls}">${escapeHtml(s.text)}</span>`)
    .join("");
  // 細節收在 title 裡:韌體版本 / IP / 連上哪個 WiFi,自己除錯時滑過可看。
  // 斷電偵測板會有幾十片,逐片列 hover 會長到看不完 → 只用一行總結,
  // 點名「有開告警且異常」的編號;每片的詳細到板子頁看。
  const hbIds = heartbeatIds(data);
  const hbMuted = hbIds.filter((id) => !alertState(id).on).length;
  const hbBad = hbIds.filter((id) => alertState(id).on && nodeState(id, data[id]).cls !== "ok");
  const hbLine = hbIds.length
    ? `斷電偵測 ${hbIds.length} 片:${hbIds.length - hbMuted - hbBad.length} 片正常` +
      (hbBad.length ? `、${hbBad.length} 片沒回報(${hbBad.slice(0, 10).join("、")}${hbBad.length > 10 ? "…" : ""})` : "") +
      (hbMuted ? `、${hbMuted} 片暫停通知` : "") + `\n  每片的詳細請到「板子」頁`
    : [];
  el.title = [...ids, ...otherNodeIds(data)]
    .map((id) => {
      const n = data[id], l = n?.latest || {}, m = n?.meta || {};
      if (!n) return `${nodeLabel(id, n)}(${id})\n  還沒收到這片的資料`;
      const seen = Number(l.ts) ? new Date(l.ts * 1000).toLocaleString("zh-TW") : "無紀錄";
      return `${nodeLabel(id, n)}(${id})\n  最後回報:${seen}\n  韌體:${m.fw || "?"}  IP:${l.ip || "?"}  WiFi:${l.ssid || "?"}`;
    })
    .concat(hbLine)
    .join("\n");
  el.hidden = false;
}

// 抓一次 RTDB 並更新 header。這一行永遠顯示,連抓不到時也是——看不到板子本身
// 就是一種狀態,藏起來會讓「板子掛了」和「這裡沒東西」長得一模一樣。
// 但要分清楚是誰的問題:手機自己沒網路 → 灰字說明是本機,不要誣賴板子;
// 真的連得出去卻讀不到 RTDB → 紅字,那是雲端或板子端的事。
async function refreshNodeStatus() {
  const el = $("#nodeStatus");
  if (!el || nodeFetching) return;
  nodeFetching = true;
  try {
    const res = await fetch(`${NODE_RTDB}/devices.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    nodeLastData = data || {};   // 供板子狀態頁使用,不再另抓一次
    nodeLastError = null;
    nodeFetchedAt = Date.now();  // 板子頁總結卡顯示「幾點更新」
    renderNodeHeader();
  } catch (e) {
    nodeLastError = String(e && e.message || e);
    // 分兩種:手機沒網路是本機問題(灰),連得出去卻讀不到才是真異常(紅)。
    const offline = navigator.onLine === false;
    const cls = offline ? "unknown" : "err";
    const text = offline ? "板子狀態:手機無網路" : "板子狀態:讀取失敗";
    el.innerHTML = `<span class="node-dot ${cls}">${escapeHtml(text)}</span>`;
    el.title = offline
      ? "這支手機目前沒有網路,所以讀不到板子狀態——不代表板子有問題。"
      : `連不上監測資料庫(${String(e && e.message || e)})。
可能是雲端資料庫暫時有問題,或這支手機連不到該網址。`;
    el.hidden = false;
  } finally {
    nodeFetching = false;
    // 狀態頁若正開著,跟著這次結果一起更新(斷電紀錄也重抓,畫完狀態再補上)
    if ($("#page-nodes")?.classList.contains("active")) {
      renderNodesPage();
      Promise.all([loadNodePowerLog(), loadAlertControl().then(syncAlertGroups)]).then(renderNodesPage);
    }
  }
}

// 前景才輪詢:背景分頁被 OS 凍結,空轉只是浪費手機電力和流量。
function ensureNodeTimer() {
  const needed = document.visibilityState === "visible";
  if (needed && !nodeTimer) {
    nodeTimer = setInterval(refreshNodeStatus, NODE_POLL_MS);
  } else if (!needed && nodeTimer) {
    clearInterval(nodeTimer);
    nodeTimer = null;
  }
}


// ---------- 板子狀態頁 ----------
// 與 header 心跳共用同一次 fetch 的結果(nodeLastData),不各抓一次。
// 溫度曲線只抓最近 24 小時:整個月的 history 有 5400+ 筆(~148KB),
// 24 小時只有 ~288 筆(~7.8KB),手機上差很多。
const NODE_HISTORY_HOURS = 24;
const NODE_HISTORY_POINTS = 288;          // 24h ÷ 5 分鐘一筆
let nodeLastData = null;                  // 最近一次成功抓到的 devices 內容
let nodeLastError = null;                 // 失敗原因(給狀態頁顯示)
let nodeFetchedAt = 0;                    // 最近一次成功抓到的時間(ms)
let nodeHistory = null;                   // [[ts, temp], ...] 由舊到新
let nodeHistoryLoading = false;
let nodeIncidents = {};                   // id → 重開機紀錄 [{ ts, reset, gap, … }],新→舊
let nodePowerLog = {};                    // id → 斷線紀錄 [{ start, end, dur, active, cause }],新→舊

// 斷線紀錄只讀 outages/{id}/{start}:watchdog 從外部監看,心跳停超過 5 分鐘就記一筆
// (start / end / dur / cause;還沒恢復時 active = true、cause 未定)。
// incidents 是「板子為什麼重開」的診斷資料,不能拿來算斷電(例如超過 3 分鐘的一般斷電它不記),
// 只用來顯示「最近重開」與重開紀錄。
// 目前只有斷電偵測板(A01…)的 outages 完整;魚塭板子的 outages 沒有 cause;
// 看門狗自己沒有 outages(沒有別的板子監看它)。
// 兩個節點都很小,進板子頁時各抓一次整包,不逐片打請求。
async function loadNodePowerLog() {
  try {
    const [outRes, incRes] = await Promise.all([
      fetch(`${NODE_RTDB}/outages.json`, { cache: "no-store" }),
      fetch(`${NODE_RTDB}/incidents.json`, { cache: "no-store" }),
    ]);
    if (!outRes.ok || !incRes.ok) return;
    const outages = (await outRes.json()) || {};
    const incidents = (await incRes.json()) || {};
    const log = {};
    for (const [id, byStart] of Object.entries(outages)) {
      log[id] = Object.entries(byStart || {})
        .map(([k, o]) => ({
          start: Number(o?.start) || Number(k),
          end: o?.active ? null : Number(o?.end),
          dur: Number(o?.dur),
          active: !!o?.active,
          cause: o?.cause || "",
        }))
        .sort((a, b) => b.start - a.start);
    }
    const resets = {};
    for (const [id, byTs] of Object.entries(incidents)) {
      resets[id] = Object.entries(byTs || {})
        .map(([k, v]) => ({ ts: Number(k), ...v }))
        .sort((a, b) => b.ts - a.ts);
    }
    nodeIncidents = resets;
    nodePowerLog = log;
  } catch { /* 讀不到就維持上次的資料 */ }
}

// outages.cause → 中文。目前看到的只有 power;網路斷的另外標;其他值沒有就顯示原文
function outageCauseText(e) {
  if (e.active) return "";
  if (e.cause === "power") return "斷電";
  if (/net|wifi/i.test(e.cause)) return "網路斷";
  return e.cause || "原因不明";
}
const outageIsNet = (e) => /net|wifi/i.test(e.cause || "");

// 近 N 小時內開始的沒回報次數(含進行中);onlyPower = 只算 cause 為斷電的
function powerCount(id, hours, onlyPower = false) {
  const since = Date.now() / 1000 - hours * 3600;
  return (nodePowerLog[id] || []).filter((e) => e.start >= since && (!onlyPower || e.cause === "power")).length;
}
function nodeShortTime(ts) {
  return new Date(ts * 1000).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
function nodeDurText(sec) {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} 秒`;
  return nodeUptimeText(sec);
}
// 重開紀錄(incidents):時間、原因、重開前停了多久。這是維修用的診斷資料,
// 只放在「進階資訊」裡;卡片只放按鈕(limit = 0),modal 列出全部。
function resetLogHtml(id, limit) {
  const list = nodeIncidents[id] || [];
  if (!list.length) return "";
  if (!limit) {
    return `<button type="button" class="power-more" data-node="${escapeHtml(id)}">看重開紀錄 ›</button>`;
  }
  const items = list.slice(0, limit).map((e) => {
    const gap = Number(e.gap) >= 60 ? `之前停了 ${nodeDurText(Number(e.gap))}` : "";
    return `<li><span>${nodeShortTime(e.ts)}</span><b>${escapeHtml(nodeResetText(e.reset))}</b>${gap ? `<small class="power-why">${gap}</small>` : ""}</li>`;
  }).join("");
  return `<div class="power-log"><div class="power-head">重開紀錄<span>共 ${list.length} 次</span></div><ul>${items}</ul></div>`;
}

// 沒回報紀錄:watchdog 發現某片超過 5 分鐘沒消息就記一筆,恢復後才知道原因(斷電 / 網路斷)。
// 標題的次數只算斷電(家人在意的是斷電;網路斷的照列,但字淡一點)。
function powerLogHtml(id, limit) {
  const list = nodePowerLog[id] || [];
  if (id === "watchdog") {
    return `<div class="power-log"><div class="power-head">斷電紀錄</div>`
      + `<p class="nodes-empty">這片自己斷電時沒有人會通知,請偶爾看一下它是不是「正常」。</p></div>`;
  }
  // 斷電偵測板的紀錄有原因(斷電 / 網路斷),次數只算斷電;魚塭板子的紀錄沒有原因,只能算全部沒回報。
  // 看板子類型決定,不看清單內容——否則沒紀錄的斷電偵測板會和隔壁那片標題不一樣。
  const hb = isHeartbeat(nodeLastData?.[id]);
  const cnt = (h) => powerCount(id, h, hb);
  const title = hb ? "斷電紀錄" : "沒回報紀錄";
  const head = `<div class="power-head">${title}<span>近 24 小時 ${cnt(24)} 次・近 7 天 ${cnt(24 * 7)} 次</span></div>`;
  if (!list.length) {
    return `<div class="power-log">${head}<p class="nodes-empty">${hb ? "最近沒有斷電" : "最近都有正常回報"}(超過 5 分鐘沒回報才會記一筆)</p></div>`;
  }
  const muted = nodeMuted(id) ? " muted" : "";
  const items = list.slice(0, limit).map((e) => e.active
    ? `<li class="active"><span>${nodeShortTime(e.start)} 起</span><b>現在沒回報,已 ${nodeDurText(Date.now() / 1000 - e.start)}</b>`
      + (hb ? `<small class="power-why">恢復後才知道是斷電還是網路斷</small>` : "") + `</li>`
    : `<li${outageIsNet(e) ? ` class="minor"` : ""}><span>${nodeShortTime(e.start)} – ${nodeShortTime(e.end).slice(-5)}</span>`
      + `<b>${nodeDurText(e.dur)}<em class="cause-${e.cause === "power" ? "power" : "other"}">${escapeHtml(outageCauseText(e))}</em></b></li>`).join("");
  // 卡片只列幾筆;其餘點按鈕開 modal 看全部(modal 不設上限,內部捲動)
  const more = list.length > limit
    ? `<button type="button" class="power-more" data-node="${escapeHtml(id)}">看全部 ${list.length} 筆 ›</button>` : "";
  return `<div class="power-log${muted}">${head}<ul>${items}</ul>${more}</div>`;
}

// 韌體回報的重開原因 → 家人看得懂的話。字串長得像「BROWNOUT (power dip)」,只看開頭的代碼。
const NODE_RESET_TEXT = {
  POWERON: "斷電後重新通電",
  BROWNOUT: "電力不穩重開(多半是電線沒接好,請檢查)",
  SW: "自動重新啟動",
  SW_CPU: "自動重新啟動",
  PANIC: "當機後自動重開",
  INT_WDT: "卡住後自動重開",
  TASK_WDT: "卡住後自動重開",
  WDT: "卡住後自動重開",
  DEEPSLEEP: "睡眠喚醒",
  EXT: "按了重置鍵",
};
function nodeResetText(reset) {
  const code = String(reset || "").split(/[\s(]/)[0];
  return NODE_RESET_TEXT[code] || String(reset || "—");
}

// 秒數 → 「x 天 y 小時」(給開機至今用)
function nodeUptimeText(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return h ? `${d} 天 ${h} 小時` : `${d} 天`;
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? (m ? `${h} 小時 ${m} 分鐘` : `${h} 小時`) : `${m} 分鐘`;
}

function nodeTimeText(ts) {
  const n = Number(ts);
  if (!n) return "—";
  if (!nodeTimeValid(n)) return `剛開機,時間還在對`;
  return new Date(n * 1000).toLocaleString("zh-TW", { hour12: false });
}

// 抓最近 24 小時溫度。RTDB 的 orderBy="$key"+limitToLast 讓伺服器端就切好,
// 不必整包下載再丟掉。key 是 unix 秒的字串。
async function loadNodeHistory() {
  if (nodeHistoryLoading) return;
  nodeHistoryLoading = true;
  try {
    const ym = new Date().toISOString().slice(0, 7);          // YYYY-MM
    const url = `${NODE_RTDB}/history/pond-site/${ym}.json`
      + `?orderBy=%22%24key%22&limitToLast=${NODE_HISTORY_POINTS}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const cutoff = Date.now() / 1000 - NODE_HISTORY_HOURS * 3600;
    nodeHistory = Object.entries(raw || {})
      .map(([k, v]) => [Number(k), Number(v?.temp)])
      .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v) && t >= cutoff)
      .sort((a, b) => a[0] - b[0]);
    // 跨月初時本月筆數可能不足,不補抓上個月:曲線短一點無妨,不值得多一次請求
  } catch (e) {
    nodeHistory = null;
  } finally {
    nodeHistoryLoading = false;
  }
}

// 氣溫折線圖(純 inline SVG,不引入圖表庫——本專案其他圖表也是自己畫的)。
// viewBox 固定、寬度 100%,所以在任何螢幕寬度都不會爆版。
// SVG 只畫線與格線(preserveAspectRatio="none" 撐滿寬度);刻度文字用 HTML 疊在圖外,
// 否則寬螢幕上文字會跟著被橫向拉長變形。
// Y 軸用整數度的刻度(1 / 2 / 5 度一格,取 3~5 格),上下界就是刻度,不會被誤讀。
// 滑過(手機:手指左右滑)顯示游標與 tooltip,處理在 setupNodeChartHover。
const NSPARK_W = 320, NSPARK_H = 110;
function nodeSparkTicks(tMin, tMax) {
  const span = Math.max(tMax - tMin, 0.5);
  const step = [1, 2, 5, 10].find((st) => span / st <= 4) || 10;
  let lo = Math.floor(tMin / step) * step, hi = Math.ceil(tMax / step) * step;
  if (hi === lo) hi = lo + step;
  const ticks = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v);
  return { lo, hi, ticks };
}
function nodeSparkline(points) {
  if (!points || points.length < 2) {
    return `<p class="nodes-empty">氣溫紀錄還不夠,暫時畫不出圖</p>`;
  }
  const W = NSPARK_W, H = NSPARK_H;
  const temps = points.map((p) => p[1]);
  const tMin = Math.min(...temps), tMax = Math.max(...temps);
  const { lo, hi, ticks } = nodeSparkTicks(tMin, tMax);
  const span = hi - lo;
  const x0 = points[0][0], x1 = points[points.length - 1][0];
  const xSpan = (x1 - x0) || 1;
  const px = (t) => ((t - x0) / xSpan) * W;
  const py = (v) => (1 - (v - lo) / span) * H;

  const d = points.map((p, i) => `${i ? "L" : "M"}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join("");
  const area = `${d}L${W},${H}L0,${H}Z`;
  const grid = ticks.map((v) => `<line x1="0" y1="${py(v).toFixed(1)}" x2="${W}" y2="${py(v).toFixed(1)}" class="nspark-grid" />`).join("");
  const yLabels = ticks.map((v) => `<span style="top:${((1 - (v - lo) / span) * 100).toFixed(2)}%">${v}°</span>`).join("");
  // X 刻度:頭、中、尾。兩端跨日時補 M/D,否則 24 小時的兩端會同樣是「23:xx」
  const sameDayEnds = new Date(x0 * 1000).getDate() === new Date(x1 * 1000).getDate();
  const tick = (t) => {
    const dt = new Date(t * 1000);
    return sameDayEnds ? nodeHm(dt) : `${dt.getMonth() + 1}/${dt.getDate()} ${nodeHm(dt)}`;
  };
  const at = (v) => nodeHm(new Date(points.find((p) => p[1] === v)[0] * 1000));
  return `
    <div class="nspark-wrap">
      <div class="nspark-y" aria-hidden="true">${yLabels}</div>
      <div class="nspark-plot" data-nspark data-lo="${lo}" data-hi="${hi}">
        <svg class="nspark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
             aria-label="最近 ${NODE_HISTORY_HOURS} 小時氣溫,範圍 ${tMin.toFixed(1)} 到 ${tMax.toFixed(1)} 度">
          ${grid}
          <path d="${area}" class="nspark-area" />
          <path d="${d}" class="nspark-line" />
        </svg>
        <div class="nspark-cursor" hidden><i class="nspark-vline"></i><i class="nspark-dot"></i></div>
      </div>
      <span></span>
      <div class="nspark-x"><span>${tick(x0)}</span><span>${tick((x0 + x1) / 2)}</span><span>${tick(x1)}</span></div>
    </div>
    <p class="nspark-range">最高 <b>${tMax.toFixed(1)}°C</b>(${at(tMax)})・最低 <b>${tMin.toFixed(1)}°C</b>(${at(tMin)})</p>`;
}

// 氣溫圖的游標 + tooltip。圖每分鐘會重畫、也會出現在 modal 裡,所以委派在 document 上;
// 資料直接用 nodeHistory(只有魚塭板子有這張圖)。手機用手指在圖上左右滑(touch-action: pan-y,
// 上下滑仍可捲動頁面)。
function setupNodeChartHover() {
  const hideCursor = (plot) => {
    const c = plot?.querySelector(".nspark-cursor");
    if (c) c.hidden = true;
    chartTipHide();
  };
  const onMove = (e) => {
    const plot = e.target.closest?.("[data-nspark]");
    if (!plot || !nodeHistory || nodeHistory.length < 2) return;
    const r = plot.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const x0 = nodeHistory[0][0], x1 = nodeHistory[nodeHistory.length - 1][0];
    const t = x0 + frac * (x1 - x0);
    // 二分搜尋最近的一筆
    let i = 0, j = nodeHistory.length - 1;
    while (j - i > 1) { const m = (i + j) >> 1; if (nodeHistory[m][0] < t) i = m; else j = m; }
    const [ts, temp] = t - nodeHistory[i][0] <= nodeHistory[j][0] - t ? nodeHistory[i] : nodeHistory[j];
    const lo = Number(plot.dataset.lo), hi = Number(plot.dataset.hi);
    const c = plot.querySelector(".nspark-cursor");
    c.hidden = false;
    c.style.left = `${((ts - x0) / ((x1 - x0) || 1)) * 100}%`;
    c.querySelector(".nspark-dot").style.top = `${(1 - (temp - lo) / ((hi - lo) || 1)) * 100}%`;
    const dt = new Date(ts * 1000);
    chartTipShow(`${dt.getMonth() + 1}/${dt.getDate()} ${nodeHm(dt)}|氣溫 ${temp.toFixed(1)}°C`, e.clientX, e.clientY);
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerdown", onMove);
  document.addEventListener("pointerout", (e) => {
    const plot = e.target.closest?.("[data-nspark]");
    if (plot && !plot.contains(e.relatedTarget)) hideCursor(plot);
  });
  // 手指離開 / 被捲動取消:收起游標
  document.addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") hideCursor(e.target.closest?.("[data-nspark]")); });
  document.addEventListener("pointercancel", (e) => hideCursor(e.target.closest?.("[data-nspark]")));
}

// 一列「標籤:值」
function nodeRow(k, v, cls = "") {
  return `<div class="nodes-row${cls ? ` ${cls}` : ""}"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`;
}

// 「進階資訊(維修用)」摺疊區開著的板子:頁面每分鐘重畫,不記住的話一更新就自己收起來
const nodeAdvOpen = new Set();

// 單片板子一張卡。家人要看的(狀態、氣溫、最後回報、斷電紀錄、通知開關)放外面;
// 韌體 / IP / WiFi 這類維修用的收進預設收合的「進階資訊」。
function nodeCard(id, node, logLimit = 3) {
  // logLimit:斷電紀錄列幾筆(卡片 3 筆;modal 傳 Infinity = 全部,並列出重開紀錄)
  const label = nodeLabel(id, node);
  const icon = id === "pond-site" ? "🌡️" : id === "watchdog" ? "🏠" : isHeartbeat(node) ? "🔌" : "📟";
  const st = nodeState(id, node);
  const head = `
    <div class="nodes-head">
      <span class="nodes-title">${icon} ${escapeHtml(label)}</span>
      <span class="node-dot ${st.cls}${nodeMuted(id) && node ? " muted" : ""}">${escapeHtml(nodeStateShort(id, node))}</span>
    </div>`;

  if (!node) {
    return `<div class="card nodes-card">${head}
      <p class="nodes-empty">還沒收到這片的資料(可能還沒裝好或沒通電)。</p>
      <p class="nodes-empty nodes-tech">編號:${escapeHtml(id)}</p>
    </div>`;
  }

  const l = node.latest || {}, m = node.meta || {};
  // 家裡板正在發通知:最重要的一件事,放最上面
  const alerting = l.alerting === true
    ? `<p class="nodes-alerting">⚠ 正在發通知(有板子沒回報,已傳 Discord,沒人按 ✅ 會打電話)</p>` : "";
  const rows = [];
  if (Number.isFinite(Number(l.temp))) rows.push(nodeRow("現場氣溫", `${Number(l.temp).toFixed(1)}°C`));
  if (l.alerting === false) rows.push(nodeRow("正在發通知", "沒有"));
  rows.push(nodeRow("最後回報", nodeRelTime(l.ts)));

  const adv = [];
  if (Number.isFinite(Number(l.checks))) adv.push(nodeRow("已檢查", `${Number(l.checks).toLocaleString()} 次`));
  // 開機至今 = 現在 − 開機時間;板子沒回報時這個數字還會一直往上加,不顯示才不會誤導
  if (Number(m.bootAt) && st.cls === "ok") {
    adv.push(nodeRow("開機至今", nodeTimeValid(m.bootAt) ? nodeUptimeText(Date.now() / 1000 - Number(m.bootAt)) : "—(開機那時還沒對時)"));
  }
  const inc = nodeIncidents[id]?.[0];
  if (inc) {
    // 例:「2026/10/14 22:47 電力不穩重開(之前停了 14 小時 42 分)」
    const gap = Number(inc.gap) >= 60 ? `(之前停了 ${nodeUptimeText(Number(inc.gap))})` : "";
    adv.push(nodeRow("最近重開", `${nodeTimeText(inc.ts)} ${nodeResetText(inc.reset)}${gap}`));
  }
  if (Number.isFinite(Number(l.rssi))) adv.push(nodeRow("WiFi 訊號", `${l.rssi} dBm`));
  adv.push(nodeRow("韌體", m.fw || "—"));
  adv.push(nodeRow("上傳週期", Number(m.interval) ? `${m.interval} 秒` : "—"));
  adv.push(nodeRow("IP", l.ip || "—"));
  adv.push(nodeRow("WiFi 名稱", l.ssid || "—"));
  if (m.mac) adv.push(nodeRow("MAC", m.mac));
  adv.push(nodeRow("編號", id));
  const advHtml = `<details class="nodes-adv" data-adv="${escapeHtml(id)}"${nodeAdvOpen.has(id) ? " open" : ""}>
    <summary>進階資訊(維修用)</summary>
    <div class="nodes-rows">${adv.join("")}</div>
    ${resetLogHtml(id, logLimit === Infinity ? Infinity : 0)}
  </details>`;

  // 氣溫曲線只有魚塭那片有。探頭在魚塭旁的空氣中,量的是氣溫,不是水溫
  const chart = id === "pond-site"
    ? `<div class="nodes-chart"><div class="nodes-chart-t">魚塭旁氣溫(近 ${NODE_HISTORY_HOURS} 小時,不是水溫)</div>${nodeSparkline(nodeHistory)}</div>`
    : "";

  return `<div class="card nodes-card">${head}${alerting}${alertNodeHtml(id)}${chart}<div class="nodes-rows">${rows.join("")}</div>${powerLogHtml(id, logLimit)}${advHtml}</div>`;
}

// ============================================================
//  告警開關(alertControl/,watchdog 每分鐘讀一次)
// ============================================================
// 規格見 pond-monitor 的 docs/notes.md「告警開關」:
//   alertControl/groups/<gid>  { name, members: {A01:true}, enabled, until?, note? }
//   alertControl/nodes/<id>    { enabled, until?, note? }
// - enabled:false = 不發 Discord、不打電話;斷線照樣偵測,outages 照記(統計不會有缺口)
// - until(unix 秒)過了這筆就失效 = 回到預設開;不寫 = 永久。過期的 entry watchdog 不刪
// - 優先順序:nodes/<id> > 所屬群組 > 預設開;一片板子只屬於一個群組
//
// 對應方式(2026-10-15 使用者定案):
//   - 每片板子綁一個池塘(Firestore options.nodePonds = { A01: 池塘id })
//   - watchdog 看到的群組 = 池塘:groups/p_<池塘id>,members = 綁在該池塘的板子。
//     每片板子剛好屬於一個群組,符合韌體規則;池塘群組改名 / 刪除也不影響(key 用池塘 id)
//   - 網站上多一層「池塘群組」(options.tags,如文安、龍雲場):開關它 = 開關底下每個池塘
// groups 的 name / members 由網站依 Firestore 自動同步(syncAlertGroups),不手動建立。
// 「整組跟著走」:開關池塘群組 → 清掉底下池塘之外的個別板子設定;開關池塘 → 清掉該池板子的個別設定。
// 之後仍可個別調,個別設定與池塘不同時顯示「衝突」提示。
// RTDB 規則目前完全開放,直接用 REST 讀寫,不需憑證。
let alertCtl = { groups: {}, nodes: {} };
let alertLoaded = false;
// Firestore 的設定讀到之前,options 是空的預設值(沒有任何池塘)。
// 這時同步會把 RTDB 的群組全部刪掉 → 一定要等真的設定讀到才同步。
let optionsReady = false;

async function loadAlertControl() {
  try {
    const r = await fetch(`${NODE_RTDB}/alertControl.json`, { cache: "no-store" });
    if (!r.ok) return;
    const d = (await r.json()) || {};
    alertCtl = { groups: d.groups || {}, nodes: d.nodes || {} };
    alertLoaded = true;
    renderNodeHeader();   // header 的斷電偵測總結要排除關告警的板子
  } catch { /* 讀不到就維持上次的資料 */ }
}

// 多路徑更新:patch 的 key 是相對 alertControl/ 的路徑,值為 null = 刪除
async function writeAlertControl(patch, { render = true } = {}) {
  // 9 秒沒回應就放棄(busyWrite 等 10 秒):這裡不會先存在手機,卡住就當沒存到,讓人再按一次
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  let r;
  try {
    r = await fetch(`${NODE_RTDB}/alertControl.json`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await loadAlertControl();
  if (render) renderNodesPage();
}

// 池塘 id → RTDB 群組 key(池塘 id 是 uuid,只含英數與 -,可直接當 key)
const pondKey = (pid) => "p_" + pid;
// 板子綁的池塘 id
const boardPond = (id) => (options.nodePonds || {})[id] || "";
// 綁在某池塘的板子(依編號排序)
function pondBoards(pid) {
  return Object.keys(options.nodePonds || {}).filter((id) => boardPond(id) === pid).sort();
}
// 池塘群組底下的池塘,照設定頁的池塘順序
function tagPonds(tag) {
  const set = pondsWithTag(tag);
  return (options.ponds || []).map((p) => p.id).filter((pid) => set.has(pid));
}
const pondExists = (pid) => (options.ponds || []).some((p) => p.id === pid);

// 依 Firestore 的池塘 / 綁定,把 alertControl/groups 的 name、members 同步成正確狀態。
// enabled / until / note 不動(那是開關狀態;池塘暫時沒綁板子也保留,之後綁上就生效)。
// 池塘已刪除、或不是 p_ 開頭(舊版格式)的群組刪掉。只在有差異時才寫;
// 任何裝置開著 App 都會做,結果相同,不怕重複。
let alertSyncing = false;
async function syncAlertGroups() {
  if (!alertLoaded || !optionsReady || !db || alertSyncing) return;
  const patch = {};
  const want = {};
  for (const p of options.ponds || []) {
    const members = pondBoards(p.id);
    const key = pondKey(p.id);
    // 沒板子、也沒開關狀態 → 不必留(有狀態就保留,之後綁上板子就生效)
    if (!members.length && typeof alertCtl.groups[key]?.enabled !== "boolean") continue;
    want[key] = { name: pondLabel(p.id), members };
  }
  for (const [key, w] of Object.entries(want)) {
    const g = alertCtl.groups[key] || {};
    if (g.name !== w.name) patch[`groups/${key}/name`] = w.name;
    const cur = Object.keys(g.members || {}).filter((id) => g.members[id]).sort().join(",");
    if (cur !== w.members.join(",")) {
      patch[`groups/${key}/members`] = w.members.length ? Object.fromEntries(w.members.map((id) => [id, true])) : null;
    }
  }
  for (const key of Object.keys(alertCtl.groups)) if (!want[key]) patch[`groups/${key}`] = null;
  if (!Object.keys(patch).length) return;
  alertSyncing = true;
  try { await writeAlertControl(patch, { render: false }); }
  catch (e) { console.warn("告警群組同步失敗(下次再試):", e); }
  finally { alertSyncing = false; }
}

const nowSec = () => Math.floor(Date.now() / 1000);
// 這筆設定目前有沒有效(與 watchdog 的 alertEntryLive 相同)
function alertLive(e) {
  return !!e && typeof e.enabled === "boolean" && (e.until == null || nowSec() < Number(e.until));
}
// 池塘的告警狀態:沒設定 / 過期 → 開
function pondAlertOn(pid) {
  const g = alertCtl.groups[pondKey(pid)];
  return alertLive(g) ? g.enabled : true;
}
// 板子跟著池塘時的狀態(沒綁池塘 = 預設開)
const boardGroupOn = (id) => (boardPond(id) ? pondAlertOn(boardPond(id)) : true);
// 板子實際狀態。by:node(個別設定)/ pond / default;conflict:個別設定與池塘不同
function alertState(id) {
  const own = alertCtl.nodes[id];
  const pid = boardPond(id);
  const groupOn = boardGroupOn(id);
  if (alertLive(own)) {
    return { on: own.enabled, by: "node", entry: own, pid, conflict: !!pid && own.enabled !== groupOn };
  }
  return { on: groupOn, by: pid ? "pond" : "default", entry: pid ? alertCtl.groups[pondKey(pid)] : null, pid, conflict: false };
}
// 剩多久:「2 小時 5 分」「25 分」「3 天 2 小時」
function alertLeftText(sec) {
  return nodeUptimeText(Math.max(60, sec));
}
// 「18:00 恢復(還有 2 小時 5 分)」/「10/18 08:00 恢復(…)」/「直到手動恢復」
function alertUntilText(e) {
  if (!e || e.until == null) return "直到手動恢復";
  const u = Number(e.until);
  const d = new Date(u * 1000);
  const today = new Date();
  const tomorrow0 = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const when = d.getTime() === tomorrow0.getTime() ? "今晚 12 點"
    : d.toDateString() === today.toDateString() ? nodeHm(d) : `${d.getMonth() + 1}/${d.getDate()} ${nodeHm(d)}`;
  const left = u - nowSec();
  return `${when} 恢復${left > 0 ? `(還有 ${alertLeftText(left)})` : ""}`;
}
// 告警可以設定的板子:看門狗自己不被監看,不列
function alertableIds() {
  return Object.keys(nodeLastData || {}).filter((id) => id !== "watchdog").sort();
}
const boardName = (id) => nodeLabel(id, nodeLastData?.[id]);
// 「A01、A02、A03」;太多時「A01、A02、A03 等 12 片」
function boardNames(ids, max = 3) {
  return ids.slice(0, max).map(boardName).join("、") + (ids.length > max ? ` 等 ${ids.length} 片` : "");
}
const ALERT_APPLY_HINT = ",1 分鐘內生效";

// 暫停通知的對話框:先選暫停多久(預設 1 小時,下方即時顯示幾點恢復)+ 選填備註,
// 按「開始暫停」才回傳 { until, note };取消 / 點背景 / Esc 回傳 null。
// 「直到我手動恢復」是配合轉換電路這類長時間施工用的(不然會一直被自己吵),放最後、單獨一排。
function pauseUntil(choice) {
  const now = new Date();
  return {
    "1h": nowSec() + 3600,
    "4h": nowSec() + 4 * 3600,
    today: Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() / 1000),
    "3d": nowSec() + 3 * 86400,
    forever: null,
  }[choice];
}
// title:「文安2池 要暫停通知多久?」;scope:影響範圍(「1 片板子:A01」)
function chooseAlertPause(title, scope = "") {
  return new Promise((resolve) => {
    const overlay = $("#alertPauseOverlay");
    let choice = "1h";
    const paint = () => {
      $$("#alertPauseOpts [data-pause]").forEach((b) => b.classList.toggle("active", b.dataset.pause === choice));
      const until = pauseUntil(choice);
      const el = $("#alertPauseUntil");
      el.textContent = until == null
        ? "不會自動恢復。弄好後記得回來按「恢復通知」。"
        : `${alertUntilText({ until })},時間到會自動恢復通知`;
      el.classList.toggle("warn", until == null);
    };
    $("#alertPauseTitle").textContent = title;
    $("#alertPauseScope").textContent = scope;
    $("#alertPauseScope").hidden = !scope;
    $("#alertPauseNote").value = "";
    paint();
    const close = (result) => {
      overlay.hidden = true;
      overlay.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    // 確認當下才算 until(對話框開著期間時間會走)
    const confirm = () => close({ until: pauseUntil(choice), note: $("#alertPauseNote").value.trim() || null });
    const onClick = (e) => {
      if (e.target === overlay || e.target.id === "alertPauseCancel") return close(null);
      if (e.target.id === "alertPauseOk") return confirm();
      const b = e.target.closest("[data-pause]");
      if (b) { choice = b.dataset.pause; paint(); }
    };
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    overlay.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    overlay.hidden = false;
  });
}

// 把一批池塘設成開 / 關,並清掉這些池塘上板子的個別設定(整組跟著走)
function pondsPatch(pids, on, opt) {
  const patch = {};
  for (const pid of pids) {
    const key = pondKey(pid);
    const members = pondBoards(pid);
    patch[`groups/${key}/name`] = pondLabel(pid);
    patch[`groups/${key}/members`] = members.length ? Object.fromEntries(members.map((id) => [id, true])) : null;
    patch[`groups/${key}/enabled`] = on;
    patch[`groups/${key}/until`] = on ? null : opt.until;
    patch[`groups/${key}/note`] = on ? null : opt.note;
    for (const id of members) patch[`nodes/${id}`] = null;
  }
  return patch;
}

// 開關池塘 / 整組會清掉底下板子的單獨設定 → 有的話先講清楚再做,免得單獨暫停的板子被默默打開
async function confirmClearOwn(pids, on) {
  const own = pids.flatMap(pondBoards).filter((id) => alertLive(alertCtl.nodes[id]));
  if (!own.length) return true;
  return showConfirm(
    `${boardNames(own)} 目前是單獨設定,這次會一起改成跟池塘一樣(${on ? "恢復通知" : "暫停通知"})。要繼續嗎?`,
    { okText: "繼續" });
}
// 恢復通知時,如果有板子正在沒回報,一恢復就會馬上傳 Discord、打電話 → 先問
async function confirmResumeBad(ids) {
  // 黃燈(5~30 分鐘)的一恢復也會馬上通知;剛開機、或資料整個不見的不會,不必問
  const bad = ids.filter((id) => {
    const n = nodeLastData?.[id];
    return n && !nodeJustBooted(n) && nodeState(id, n).cls !== "ok";
  });
  if (!bad.length) return true;
  return showConfirm(
    `${boardNames(bad)} 現在沒回報,恢復後會馬上傳 Discord、打電話。確定要恢復嗎?`,
    { okText: "恢復通知" });
}

// 池塘群組:整組暫停 / 整組恢復(兩個方向各一顆按鈕,部分暫停時兩顆都有)
async function setAlertTag(tag, on) {
  const pids = tagPonds(tag);
  if (!pids.length) { showToast(`「${tag}」底下還沒有池塘`, true); return; }
  // 只改這次真的要變的池塘:已經暫停的池塘保留原本的時間與備註
  // (例如轉換電路設的「直到手動恢復」,不能被整組暫停 1 小時蓋掉)
  const target = pids.filter((pid) => pondAlertOn(pid) !== on);
  if (!target.length) return;
  const kept = pids.length - target.length;
  const boards = target.flatMap(pondBoards);
  if (on && !(await confirmResumeBad(boards))) return;
  if (!(await confirmClearOwn(target, on))) return;
  let opt = null;
  if (!on) {
    opt = await chooseAlertPause(`「${tag}」整組要暫停通知多久?`,
      `${target.length} 池、${boards.length} 片板子${boards.length ? `:${boardNames(boards, 6)}` : ""}`
      + (kept ? `(已經暫停的 ${kept} 池維持原本的設定)` : ""));
    if (!opt) return;
  }
  if (await busyWrite("儲存中…", () => writeAlertControl(pondsPatch(target, on, opt)), { fail: "通知設定沒有存到", local: false }) === "ok") {
    showToast(on ? `已恢復「${tag}」${target.length} 池的通知${ALERT_APPLY_HINT}` : `已暫停「${tag}」${target.length} 池的通知,${alertUntilText(opt)}${ALERT_APPLY_HINT}`);
  }
}

// 單一池塘開關
async function toggleAlertPond(pid) {
  const turnOff = pondAlertOn(pid);
  const boards = pondBoards(pid);
  if (!turnOff && !(await confirmResumeBad(boards))) return;
  if (!(await confirmClearOwn([pid], !turnOff))) return;
  let opt = null;
  if (turnOff) {
    opt = await chooseAlertPause(`「${pondName(pid)}」要暫停通知多久?`, `${boards.length} 片板子${boards.length ? `:${boardNames(boards, 6)}` : ""}`);
    if (!opt) return;
  }
  if (await busyWrite("儲存中…", () => writeAlertControl(pondsPatch([pid], !turnOff, opt)), { fail: "通知設定沒有存到", local: false }) === "ok") {
    showToast(turnOff
      ? `已暫停「${pondName(pid)}」的通知,${alertUntilText(opt)}${ALERT_APPLY_HINT}`
      : `已恢復「${pondName(pid)}」的通知${ALERT_APPLY_HINT}`);
  }
}

// 個別板子開關。與池塘(或預設)相同且永久時刪掉個別設定,不留多餘的 entry;
// 不同時寫個別設定 → 畫面顯示衝突提示
async function toggleAlertNode(id) {
  const turnOff = alertState(id).on;
  if (!turnOff && !(await confirmResumeBad([id]))) return;
  let opt = { until: null, note: null };
  if (turnOff) {
    opt = await chooseAlertPause(`${boardName(id)} 要暫停通知多久?`, "只暫停這一片");
    if (!opt) return;
  }
  const want = !turnOff;
  const value = want === boardGroupOn(id) && opt.until == null && !opt.note
    ? null
    : { enabled: want, ...(opt.until != null && { until: opt.until }), ...(opt.note && { note: opt.note }) };
  if (await busyWrite("儲存中…", () => writeAlertControl({ [`nodes/${id}`]: value }), { fail: "通知設定沒有存到", local: false }) === "ok") {
    showToast(want
      ? `已恢復 ${boardName(id)} 的通知${ALERT_APPLY_HINT}`
      : `已暫停 ${boardName(id)} 的通知,${alertUntilText(opt)}${ALERT_APPLY_HINT}`);
  }
}

// 單獨暫停的板子一次全部恢復(做法同 toggleAlertNode 的恢復:跟池塘一樣就刪掉個別設定)
async function resumeAlertNodes(ids) {
  if (!ids.length || !(await confirmResumeBad(ids))) return;
  const patch = Object.fromEntries(ids.map((id) => [`nodes/${id}`, boardGroupOn(id) ? null : { enabled: true }]));
  if (await busyWrite("儲存中…", () => writeAlertControl(patch), { fail: "通知設定沒有存到", local: false }) === "ok") {
    showToast(`已恢復 ${ids.length} 片的通知${ALERT_APPLY_HINT}`);
  }
}

// 讓個別設定回到跟池塘一樣(清掉衝突)
async function resetAlertNode(id) {
  if (await busyWrite("儲存中…", () => writeAlertControl({ [`nodes/${id}`]: null }), { fail: "通知設定沒有存到", local: false }) === "ok") {
    showToast(`${boardName(id)} 已改成跟池塘一樣`);
  }
}

// 板子綁定池塘(寫 Firestore options.nodePonds),寫完立刻同步告警群組
async function bindBoardPond(id, pondId) {
  if (!db) return;
  const nodePonds = { ...(options.nodePonds || {}) };
  if (pondId) nodePonds[id] = pondId; else delete nodePonds[id];
  const res = await busyWrite("儲存中…", () => updateDoc(doc(db, ...DB_ROOT, "settings", "options"), { nodePonds }), { fail: "池塘設定沒有存到" });
  if (!res) { renderNodesPage(); return; }   // 失敗:畫面(下拉 / 勾選)回到原本的樣子
  options.nodePonds = nodePonds;   // onSnapshot 回來前先用新值,讓同步與畫面立即正確
  await syncAlertGroups();
  renderNodesPage();
  // 綁到一個正在暫停的池塘,這片也會跟著暫停 → 要講,不然以為它會通知
  const followsPaused = pondId && alertState(id).by === "pond" && !pondAlertOn(pondId);
  if (res === "ok") showToast(pondId
    ? `✓ ${boardName(id)} 已設定在 ${pondLabel(pondId)}${followsPaused ? `(這個池塘暫停通知中,這片也會跟著暫停)` : ""}`
    : `✓ ${boardName(id)} 已取消指定池塘`);
}

// 從池塘這邊增減板子:勾選 = 放在這池,取消勾選 = 移出(變成沒指定池塘)。
// 列出所有可設定的板子(看門狗除外),每片標出目前在哪,勾了別池的板子 = 從那池移過來。
// 只在畫面上改勾選狀態(不重畫整個清單,捲動位置才不會跳),按「儲存」才回傳 { added, removed }。
function choosePondBoards(pid) {
  return new Promise((resolve) => {
    const overlay = $("#pondBoardsOverlay");
    const list = $("#pondBoardsList");
    const ids = alertableIds();
    const before = new Set(pondBoards(pid));
    const sel = new Set(before);
    const where = (id) => {
      const cur = boardPond(id);
      return cur === pid ? "在這池" : cur ? `目前在「${pondName(cur)}」` : "沒指定池塘";
    };
    $("#pondBoardsTitle").textContent = `「${pondName(pid)}」的板子`;
    list.innerHTML = ids.length
      ? ids.map((id) => `<label class="pb-item${sel.has(id) ? " on" : ""}">
          <input type="checkbox" data-pb="${escapeHtml(id)}"${sel.has(id) ? " checked" : ""} />
          <b>${escapeHtml(boardName(id))}</b><small>${escapeHtml(where(id))}</small>
        </label>`).join("")
      : `<p class="nodes-empty">還沒有任何板子</p>`;
    list.scrollTop = 0;
    const diff = () => ({
      added: ids.filter((id) => sel.has(id) && !before.has(id)),
      removed: ids.filter((id) => !sel.has(id) && before.has(id)),
    });
    const paint = () => {
      const { added, removed } = diff();
      const moved = (id) => boardPond(id) && boardPond(id) !== pid ? `(從「${pondName(boardPond(id))}」移過來)` : "";
      $("#pondBoardsSummary").innerHTML = !added.length && !removed.length ? `<span class="pb-none">還沒有變更</span>`
        : [added.length && `<b>加入</b> ${added.map((id) => escapeHtml(boardName(id) + moved(id))).join("、")}`,
           removed.length && `<b>移出</b> ${removed.map((id) => escapeHtml(boardName(id))).join("、")}(變成沒指定池塘)`]
          .filter(Boolean).join("<br>");
      $("#pondBoardsOk").disabled = !added.length && !removed.length;
    };
    paint();
    const close = (result) => {
      overlay.hidden = true;
      overlay.removeEventListener("click", onClick);
      list.removeEventListener("change", onChange);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onChange = (e) => {
      const cb = e.target.closest("[data-pb]");
      if (!cb) return;
      cb.checked ? sel.add(cb.dataset.pb) : sel.delete(cb.dataset.pb);
      cb.closest(".pb-item").classList.toggle("on", cb.checked);
      paint();
    };
    const onClick = (e) => {
      if (e.target === overlay || e.target.id === "pondBoardsCancel" || e.target.id === "pondBoardsClose") return close(null);
      if (e.target.id === "pondBoardsOk") return close(diff());
    };
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    overlay.addEventListener("click", onClick);
    list.addEventListener("change", onChange);
    document.addEventListener("keydown", onKey);
    overlay.hidden = false;
  });
}
async function editPondBoards(pid) {
  const r = await choosePondBoards(pid);
  if (!r || !db || (!r.added.length && !r.removed.length)) return;
  const nodePonds = { ...(options.nodePonds || {}) };
  r.added.forEach((id) => { nodePonds[id] = pid; });
  r.removed.forEach((id) => { delete nodePonds[id]; });
  const res = await busyWrite("儲存中…", () => updateDoc(doc(db, ...DB_ROOT, "settings", "options"), { nodePonds }), { fail: "池塘設定沒有存到" });
  if (!res) { renderNodesPage(); return; }   // 失敗:畫面(下拉 / 勾選)回到原本的樣子
  options.nodePonds = nodePonds;   // onSnapshot 回來前先用新值,讓同步與畫面立即正確
  await syncAlertGroups();
  renderNodesPage();
  // 加進一個正在暫停的池塘,跟著池塘走的板子也會一起暫停 → 要講,不然以為它會通知
  const followsPaused = !pondAlertOn(pid) && r.added.some((id) => alertState(id).by === "pond");
  if (res === "ok") showToast(`✓「${pondName(pid)}」`
    + [r.added.length && `加入 ${boardNames(r.added)}`, r.removed.length && `移出 ${boardNames(r.removed)}`].filter(Boolean).join("、")
    + (followsPaused ? "(這個池塘暫停通知中,加入的板子也會跟著暫停)" : ""));
}

// 暫停狀態 + 備註(池塘列 / 單獨暫停清單共用)
function alertOffHtml(e) {
  return `<span class="alert-st off">🔕 暫停中・${escapeHtml(alertUntilText(e))}</span>`
    + (e?.note ? `<small class="alert-note-inline">${escapeHtml(e.note)}</small>` : "");
}

// 通知區的每一列都長一樣:左邊名稱 + 小字說明 + 狀態,右邊固定一顆按鈕(列與列之間細線分隔)
function alertLineHtml({ name, meta = "", status = "", btn = "", cls = "" }) {
  return `<div class="alert-line${cls ? ` ${cls}` : ""}">
    <div class="alert-main">
      <div class="alert-name">${name}${meta ? ` <small>${meta}</small>` : ""}</div>
      ${status ? `<div class="alert-sub">${status}</div>` : ""}
    </div>
    ${btn ? `<div class="alert-btns">${btn}</div>` : ""}
  </div>`;
}
const alertBtn = (action, id, text, primary = false) =>
  `<button type="button" class="btn-sm${primary ? " btn-primary" : ""}" data-alert-action="${action}"${id != null ? ` data-alert-id="${escapeHtml(id)}"` : ""}>${text}</button>`;
// 一組:小標題(右邊可放一顆整組按鈕)+ 內容
function alertGroupHtml(title, body, headBtn = "") {
  return `<div class="alert-group">
    <div class="alert-group-head"><span class="alert-group-t">${title}</span>${headBtn}</div>
    ${body}
  </div>`;
}

// 一列池塘(池塘群組底下,或「沒分群組」裡)
function alertPondRow(pid) {
  const boards = pondBoards(pid);
  const on = pondAlertOn(pid);
  const g = alertCtl.groups[pondKey(pid)];
  const conflicts = boards.filter((id) => alertState(id).conflict);
  const conflict = conflicts.length
    ? `<span class="alert-conflict">⚠ ${conflicts.map((id) => escapeHtml(boardName(id))).join("、")} 是單獨設定,和這個池塘不一樣</span>` : "";
  return alertLineHtml({
    cls: "alert-pond",
    name: escapeHtml(pondName(pid)),
    meta: `${boards.length} 片${boards.length ? `:${boards.map((id) => escapeHtml(boardName(id))).join("、")}` : ""}`,
    status: (on ? `<span class="alert-st on">會通知</span>` : alertOffHtml(g)) + conflict,
    btn: alertBtn("pond-boards", pid, "增減板子") + alertBtn("pond-toggle", pid, on ? "暫停通知" : "恢復通知", !on),
  });
}

// 還沒放板子的池塘:列成一排池塘名稱按鈕,點了直接開「增減板子」加板子進去
function emptyPondsHtml(pids, lead) {
  if (!pids.length) return "";
  return `<div class="alert-pond-empty">${lead}
    <div class="alert-pond-chips">${pids.map((pid) => `<button type="button" class="chip-btn" data-alert-action="pond-boards" data-alert-id="${escapeHtml(pid)}">＋ ${escapeHtml(pondName(pid))}</button>`).join("")}</div>
  </div>`;
}

// 板子頁的「通知」區塊,分三組(有內容才出現):
//   單獨暫停的板子(可直接恢復)→ 還沒指定池塘(提醒去設定)→ 依池塘(池塘群組 → 池塘)
function alertControlSection() {
  const ids = alertableIds();
  if (!ids.length) return "";
  const offCount = ids.filter((id) => !alertState(id).on).length;

  // 單獨暫停的板子:每片一列、直接按「恢復通知」,不必一片片點開方塊
  const looseOff = ids.filter((id) => { const s = alertState(id); return s.by === "node" && !s.on; });
  const loose = looseOff.length
    ? alertGroupHtml(`單獨暫停的板子(${looseOff.length})`,
        looseOff.map((id) => alertLineHtml({
          name: escapeHtml(boardName(id)),
          meta: boardPond(id) ? escapeHtml(pondName(boardPond(id))) : "沒指定池塘",
          status: alertOffHtml(alertCtl.nodes[id]),
          btn: alertBtn("node-toggle", id, "恢復通知", true),
        })).join(""),
        looseOff.length >= 2 ? alertBtn("resume-all", null, "全部恢復") : "")
    : "";

  // 沒指定池塘的板子:不受池塘開關控制,提醒去設定(按鈕直接進「一次設定多片的池塘」)
  //「一次設定多片」只管斷電偵測板;魚塭板子 / 其他板子各一列,按「設定」開它的詳細改「所在池塘」。
  // 不寫「一樣會通知」:清單裡可能有單獨暫停中的板子,會和上面那組互相矛盾。
  const unbound = ids.filter((id) => !boardPond(id));
  const unboundHb = unbound.filter((id) => isHeartbeat(nodeLastData[id]));
  const unboundOther = unbound.filter((id) => !isHeartbeat(nodeLastData[id]));
  const unboundGroup = unbound.length
    ? alertGroupHtml(`還沒指定池塘(${unbound.length})`,
        (unboundHb.length ? `<p class="alert-group-note"><b>${escapeHtml(boardNames(unboundHb, 6))}</b></p>` : "")
        + unboundOther.map((id) => alertLineHtml({ name: escapeHtml(boardName(id)), btn: alertBtn("open-node", id, "設定") })).join("")
        + `<p class="alert-group-note">沒指定池塘的板子,不能跟著池塘一起暫停。</p>`,
        unboundHb.length ? alertBtn("bind-unbound", null, "現在指定") : "")
    : "";

  // 依池塘:池塘群組一列(整組按鈕),底下縮排列出有板子的池塘
  const tagRows = (options.tags || []).map((tag) => {
    const pids = tagPonds(tag);
    // 狀態與按鈕只看有板子的池塘(畫面上看得到的那幾列);整組暫停時仍會連空池塘一起設定
    const used = pids.filter((pid) => pondBoards(pid).length);
    const offPonds = used.filter((pid) => !pondAlertOn(pid)).length;
    const n = used.reduce((sum, pid) => sum + pondBoards(pid).length, 0);
    const allOff = used.length > 0 && offPonds === used.length;
    // 還沒放板子的池塘不逐列顯示(會很長),收成一句;整組暫停仍會一起設定它們,之後放上板子就生效
    const empties = pids.filter((pid) => !pondBoards(pid).length);
    const emptyLine = empties.length
      ? emptyPondsHtml(empties, used.length ? `另有 ${empties.length} 池還沒放板子,點池塘名稱加板子:` : `${empties.length} 池都還沒放板子,點池塘名稱加板子:`)
      : pids.length ? "" : `<p class="alert-pond-empty">這個群組還沒有池塘</p>`;
    const status = allOff ? `<span class="alert-st off">🔕 整組暫停中</span>`
      : offPonds ? `<span class="alert-st part">${offPonds} 池暫停中</span>` : "";
    const btns = n
      ? (allOff ? "" : alertBtn("tag-off", tag, "整組暫停")) + (offPonds ? alertBtn("tag-on", tag, "整組恢復", true) : "")
      : "";
    return `<div class="alert-tagrow">
      ${alertLineHtml({ cls: "alert-tag", name: escapeHtml(tag), meta: `${n} 片板子`, status, btn: btns })}
      ${used.map(alertPondRow).join("")}
      ${emptyLine}
    </div>`;
  }).join("");
  // 沒有任何池塘群組的池塘 → 另外列:有板子的才暫停得到,沒板子的才加得了板子
  const untaggedAll = (options.ponds || []).map((p) => p.id)
    .filter((pid) => !((options.pondTags || {})[pid] || []).some((t) => (options.tags || []).includes(t)));
  const untagged = untaggedAll.filter((pid) => pondBoards(pid).length);
  const untaggedEmpty = untaggedAll.filter((pid) => !pondBoards(pid).length);
  const untaggedRows = untaggedAll.length
    ? `<div class="alert-tagrow">${alertLineHtml({ cls: "alert-tag", name: "沒分群組的池塘" })}${untagged.map(alertPondRow).join("")}`
      + emptyPondsHtml(untaggedEmpty, untagged.length ? `另有 ${untaggedEmpty.length} 池還沒放板子,點池塘名稱加板子:` : "還沒放板子,點池塘名稱加板子:")
      + `</div>` : "";
  const byPond = alertGroupHtml("依池塘",
    (tagRows + untaggedRows) || `<p class="alert-group-note">還沒有池塘群組,可到「設定」頁新增</p>`);

  return `<div class="card nodes-card alert-card">
    <div class="nodes-head">
      <span class="nodes-title">🔔 通知(Discord・電話)</span>
      <span class="nodes-count">${offCount ? `<b class="part">${offCount} 片暫停中</b>` : "全部會通知"}</span>
    </div>
    <p class="nodes-desc">板子沒回報時,會傳 Discord、打電話。暫停期間照樣記錄,只是不通知。</p>
    ${loose}${unboundGroup}${byPond}
  </div>`;
}

// 板子詳細(卡片 / modal)裡的通知列 + 所在池塘
function alertNodeHtml(id) {
  if (id === "watchdog" || !nodeLastData?.[id]) return "";
  const st = alertState(id);
  const pondOpts = [`<option value="">(沒指定池塘)</option>`]
    .concat((options.ponds || []).map((p) => `<option value="${escapeHtml(p.id)}"${p.id === st.pid ? " selected" : ""}>${escapeHtml(pondLabel(p.id))}</option>`))
    .join("");
  const bind = `<label class="alert-bind">所在池塘
    <select data-bind-board="${escapeHtml(id)}">${pondOpts}</select></label>`;
  const by = st.by === "node" ? "這片單獨設定" : st.pid ? `跟「${escapeHtml(pondName(st.pid))}」一起` : "還沒指定池塘";
  const state = st.on ? "會通知" : `🔕 暫停中・${escapeHtml(alertUntilText(st.entry))}`;
  const note = !st.on && st.entry?.note ? `・${escapeHtml(st.entry.note)}` : "";
  const conflict = st.conflict
    ? `<p class="alert-conflict">⚠ 這片單獨設成「${st.on ? "會通知" : "暫停"}」,但「${escapeHtml(pondName(st.pid))}」是${boardGroupOn(id) ? "會通知" : "暫停"}
       <button type="button" class="btn-sm" data-alert-action="node-reset" data-alert-id="${escapeHtml(id)}">改成跟池塘一樣</button></p>` : "";
  return `<div class="alert-node">
    <div><span class="alert-st ${st.on ? "on" : "off"}">${state}</span><small>${by}${note}</small></div>
    <button type="button" class="btn-sm${st.on ? "" : " btn-primary"}" data-alert-action="node-toggle" data-alert-id="${escapeHtml(id)}">${st.on ? "暫停通知" : "恢復通知"}</button>
  </div>${conflict}${bind}`;
}

// 「現在指定」:直接進「一次設定多片」並只顯示沒指定池塘的,捲到方塊區
function startBindUnbound() {
  closeNodeModal();
  nodeBatchMode = true;
  nodeBatchSel.clear();
  nodeFilterBeforeBind = nodeFilter;   // 離開設定模式時還原
  nodeFilter = "unbound";
  renderNodesPage();
  $("#nodeTiles")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setupAlertControl() {
  // 告警按鈕散在板子頁與詳細 modal,統一用 document 層級的事件代理
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-alert-action]");
    if (!b) return;
    const id = b.dataset.alertId;
    ({
      "tag-off": () => setAlertTag(id, false),
      "tag-on": () => setAlertTag(id, true),
      "pond-toggle": () => toggleAlertPond(id),
      "node-toggle": () => toggleAlertNode(id),
      "node-reset": () => resetAlertNode(id),
      "resume-all": () => resumeAlertNodes(alertableIds().filter((x) => { const s = alertState(x); return s.by === "node" && !s.on; })),
      "bind-unbound": startBindUnbound,
      "open-node": () => openNodeModal(id),
      "pond-boards": () => editPondBoards(id),
    })[b.dataset.alertAction]?.();
  });
  document.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-bind-board]");
    if (sel) bindBoardPond(sel.dataset.bindBoard, sel.value);
  });
  // 開 App 就讀一次告警設定,讓設定頁改了池塘 / 綁定時能立即同步 watchdog 的群組成員
  loadAlertControl().then(syncAlertGroups);
}

// 頁首的「現在狀況」:家人打開這頁只想知道一件事——有沒有事要處理。
// 會通知的板子有狀況 → 紅 / 黃,點名是哪幾片;沒有 → 綠「一切正常」。
// 暫停通知的另外一行灰字說明(轉換電路等施工時會刻意暫停,不算「有事」,但要看得到)。
function nodesSummaryHtml() {
  const data = nodeLastData;
  const fetched = nodeFetchedAt ? nodeHm(new Date(nodeFetchedAt)) : "";
  // 讀不到最新資料:不要用舊資料下「一切正常」或「已通知」的結論
  if (nodeLastError || (nodeFetchedAt && Date.now() - nodeFetchedAt > 2 * NODE_POLL_MS)) {
    const offline = navigator.onLine === false;
    return `<div class="card nodes-card nodes-sum unknown">
      <div class="nodes-sum-t">暫時讀不到最新狀態</div>
      <div class="nodes-sum-s">${offline ? "請檢查手機網路・" : ""}${fetched ? `最後更新 ${fetched}` : ""}${
        !offline && nodeLastError ? ` <small class="nodes-tech">(${escapeHtml(nodeLastError)})</small>` : ""}</div>
    </div>`;
  }
  const all = [...Object.keys(NODE_LABELS), ...heartbeatIds(data), ...otherNodeIds(data)];
  const bad = all.filter((id) => nodeState(id, data[id]).cls !== "ok");
  const watchedBad = bad.filter((id) => !nodeMuted(id));
  const mutedBad = bad.filter(nodeMuted);
  const paused = all.filter((id) => data[id] && nodeMuted(id));
  let cls, title, sub;
  if (watchedBad.length) {
    cls = watchedBad.some((id) => nodeState(id, data[id]).cls === "err") ? "err" : "pending";
    const one = watchedBad.length === 1 ? nodeStateShort(watchedBad[0], data[watchedBad[0]]) : "沒回報";
    title = `⚠ ${escapeHtml(boardNames(watchedBad))} ${escapeHtml(one)}`;
    // 說法照 watchdog 的實際行為:沒回報約 5 分鐘就傳 Discord,沒人按 ✅ 再過約 10 分鐘才打電話;
    // 剛開機不會通知;整個不見的(devices 裡沒有)watchdog 看不到,也不會通知
    sub = watchedBad.includes("watchdog")
      ? "家裡板沒回報時,其他板子出事也不會有人收到通知,請去看看"
      : watchedBad.every((id) => !data[id]) ? "還沒收到資料,不會通知,請檢查這片"
      : watchedBad.every((id) => nodeJustBooted(data[id])) ? "剛開機,等它對好時間"
      : "已傳 Discord,沒人按 ✅ 會打電話";
  } else if (data.watchdog?.latest?.alerting === true) {
    // 板子剛恢復時,家裡板的狀態最多晚 1 分鐘才更新
    cls = "pending";
    title = "⚠ 家裡板正在發通知";
    sub = "如果板子剛恢復,1 分鐘內會停;沒停請看 Discord";
  } else {
    cls = "ok";
    title = "✅ 一切正常";
    const watched = all.filter((id) => !nodeMuted(id));
    sub = paused.length ? `會通知的 ${watched.length} 片板子都有回報` : `${all.length} 片板子都有回報`;
  }
  const pausedNote = !mutedBad.length ? ""
    : mutedBad.length === paused.length ? (paused.length > 1 ? "(都沒回報)" : "(沒回報)")
    : `(其中 ${mutedBad.length} 片沒回報)`;
  const pausedLine = paused.length
    ? `<p class="nodes-sum-paused">🔕 ${escapeHtml(boardNames(paused))} 暫停通知中${pausedNote}</p>` : "";
  return `<div class="card nodes-card nodes-sum ${cls}">
    <div class="nodes-sum-t">${title}</div>
    <div class="nodes-sum-s">${escapeHtml(sub)}${fetched ? `・${fetched} 更新` : ""}</div>
    ${pausedLine}
  </div>`;
}

function renderNodesPage() {
  const box = $("#nodesContainer");
  if (!box) return;
  if (!nodeLastData) {
    box.innerHTML = `<div class="card"><p class="nodes-empty">${
      nodeLastError ? `暫時讀不到板子資料,請檢查手機網路。<small class="nodes-tech">(${escapeHtml(nodeLastError)})</small>` : "查詢中…"
    }</p></div>`;
    return;
  }
  // 順序照家人關心的程度:現在狀況 → 斷電偵測方塊 → 通知開關 → 其他 → 固定兩片。
  // 斷電偵測板 / 其他板子數量會很多,用小方塊格狀排列,點方塊才開完整資料(modal),避免整頁無限往下長。
  const fixed = Object.keys(NODE_LABELS).map((id) => nodeCard(id, nodeLastData[id])).join("");
  // 版面:電腦上主欄(現在狀況、方塊、通知)+ 右側固定寬的側欄(魚塭板子、家裡板),
  // 兩欄上緣對齊;手機上側欄自然接在主欄後面,順序不變。
  box.innerHTML = `<div class="nodes-layout">
    <div class="nodes-main">${
      nodesSummaryHtml() +
      nodeTileSection("斷電偵測", heartbeatIds(nodeLastData), { batch: true, anchor: "nodeTiles" }) +
      alertControlSection() +
      nodeTileSection("其他板子", otherNodeIds(nodeLastData))
    }</div>
    <aside class="nodes-side">${fixed}</aside>
  </div>`;
  if (nodeOpenId) renderNodeModal();
}

// 方塊上的短狀態:正常 / 沒回報 7分鐘。完整說明在 modal 裡。
function nodeShortAgo(sec) {
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}分鐘`;
  if (sec < 86400) return `${Math.round(sec / 3600)}小時`;
  return `${Math.round(sec / 86400)}天`;
}
function nodeTile(id) {
  const node = nodeLastData[id];
  const st = nodeState(id, node);
  const age = nodeAge[id];
  const short = st.cls === "ok" ? "正常"
    : nodeJustBooted(node) ? "剛開機"
    : !node || !Number.isFinite(age) ? "還沒收到資料"
    : `沒回報 ${nodeShortAgo(age)}`;
  const muted = !alertState(id).on;
  // 編號右邊:近 24 小時斷電幾次(只算斷電;網路斷不在意,點進去才看得到)
  const power = powerCount(id, 24, true);
  const cuts = power
    ? `<span class="node-tile-cut power" title="近 24 小時斷電 ${power} 次">⚡斷電${power}次</span>` : "";
  const pond = boardPond(id) ? pondName(boardPond(id)) : "";
  const cls = `node-tile ${st.cls}${muted ? " muted" : ""}${nodeBatchMode && nodeBatchSel.has(id) ? " picked" : ""}`;
  return `<button type="button" class="${cls}" data-node="${escapeHtml(id)}" title="${escapeHtml(st.text)}${muted ? "(暫停通知中)" : ""}">
    <span class="node-tile-top">
      <span class="node-tile-id">${escapeHtml(nodeLabel(id, node))}</span>${cuts}
    </span>
    <span class="node-tile-st">${escapeHtml(short)}</span>
    <span class="node-tile-foot">
      <span class="node-tile-pond${pond ? "" : " none"}">${pond ? escapeHtml(pond) : "沒指定池塘"}</span>${muted ? `<span class="node-tile-mute">🔕暫停</span>` : ""}
    </span>
  </button>`;
}

// 一組方塊:標題列附統計(正常 / 沒回報),可切「全部 / 只看有狀況的 / 沒指定池塘」。
// 排序固定照編號,不因狀態跳動 —— 線路多時,位置固定比較好找。
// batch = true 的區塊(斷電偵測)有「一次設定多片的池塘」:點方塊多選、或用編號範圍選取,一次設到同一個池塘。
let nodeFilter = "all";   // all | bad | unbound
function nodeTileSection(title, ids, { batch = false, anchor = "" } = {}) {
  if (!ids.length) return "";
  const bad = ids.filter((id) => nodeState(id, nodeLastData[id]).cls !== "ok");
  // 紅字只給會通知的;暫停中的灰字(顏色規則:紅 = 會通知而且出事,灰 = 暫停中)
  const badOn = bad.filter((id) => !nodeMuted(id)), badMuted = bad.filter(nodeMuted);
  const unbound = ids.filter((id) => !boardPond(id));
  const shown = nodeFilter === "bad" ? bad : nodeFilter === "unbound" ? unbound : ids;
  const empty = nodeFilter === "bad" ? "全部正常 👍" : "全部都指定好池塘了 👍";
  const tiles = shown.length
    ? `<div class="node-grid">${shown.map(nodeTile).join("")}</div>`
    : `<p class="nodes-empty">${empty}</p>`;
  const chip = (key, label) => `<button type="button" class="chip-btn${nodeFilter === key ? " active" : ""}" data-node-filter="${key}">${label}</button>`;
  const batchBtn = batch
    ? `<button type="button" class="btn-sm nodes-batch-btn${nodeBatchMode ? " btn-primary" : ""}" data-batch="toggle">${nodeBatchMode ? "取消" : "一次設定多片的池塘"}</button>` : "";
  const hasPower = ids.some((id) => powerCount(id, 24, true));
  const hasMuted = ids.some((id) => !alertState(id).on);
  const legend = [hasPower && "⚡ 近 24 小時斷電次數", hasMuted && "🔕 暫停通知(不傳 Discord、不打電話)", "點方塊看詳細"].filter(Boolean).join("・");
  return `<div class="card nodes-card"${anchor ? ` id="${anchor}"` : ""}>
    <div class="nodes-head">
      <span class="nodes-title">${escapeHtml(title)}${batchBtn}</span>
      <span class="nodes-count">${ids.length - bad.length}/${ids.length} 正常${badOn.length ? `<b class="err">・${badOn.length} 片沒回報</b>` : ""}${badMuted.length ? `・${badMuted.length} 片暫停中沒回報` : ""}</span>
    </div>
    <div class="nodes-filter">
      ${chip("all", `全部 ${ids.length}`)}${chip("bad", `只看有狀況的 ${bad.length}`)}${chip("unbound", `沒指定池塘 ${unbound.length}`)}
    </div>
    ${batch && nodeBatchMode ? nodeBatchTools(shown) : ""}
    ${tiles}
    <p class="node-legend">${legend}</p>
    ${batch && nodeBatchMode ? nodeBatchBar() : ""}
  </div>`;
}

// ---------- 一次設定多片的池塘 ----------
let nodeBatchMode = false;
const nodeBatchSel = new Set();
let nodeFilterBeforeBind = null;   //「現在指定」進來前的篩選
function exitBatchMode() {
  nodeBatchMode = false;
  nodeBatchSel.clear();
  if (nodeFilterBeforeBind != null) { nodeFilter = nodeFilterBeforeBind; nodeFilterBeforeBind = null; }
}
// 輸入框 / 下拉的值存起來:頁面每分鐘重畫,不存會被清掉
const nodeBatchForm = { from: "", to: "", pond: "" };

// 編號拆成「字首 + 數字」:A07 → ["A", 7];比較時同字首才算同一段
function boardIdParts(id) {
  const m = /^([A-Za-z]*)(\d+)$/.exec(String(id).trim());
  return m ? [m[1].toUpperCase(), Number(m[2])] : null;
}

// 上方工具列:步驟說明、編號範圍選取、全選目前顯示的、清除
function nodeBatchTools(shown) {
  return `<div class="batch-tools">
    <p class="nodes-empty">① 點選板子(或輸入編號一次選一段) ② 在最下面選池塘 ③ 按「套用」</p>
    <div class="batch-range">
      <input type="text" class="batch-input" data-batch-field="from" placeholder="從 A10" value="${escapeHtml(nodeBatchForm.from)}" />
      <span>~</span>
      <input type="text" class="batch-input" data-batch-field="to" placeholder="到 A25" value="${escapeHtml(nodeBatchForm.to)}" />
      <button type="button" class="btn-sm" data-batch="range">選這一段</button>
    </div>
    <div class="batch-quick">
      <button type="button" class="btn-sm" data-batch="all" data-batch-ids="${escapeHtml(shown.join(","))}">全選下面的 ${shown.length} 片</button>
      <button type="button" class="btn-sm" data-batch="clear">清除選取</button>
    </div>
  </div>`;
}

// 下方固定列(捲動時黏在分頁列上方):已選幾片 → 設到哪個池塘 → 取消 / 套用
function nodeBatchBar() {
  const opts = [`<option value="">選擇池塘…</option>`]
    .concat((options.ponds || []).map((p) => `<option value="${escapeHtml(p.id)}"${p.id === nodeBatchForm.pond ? " selected" : ""}>${escapeHtml(pondLabel(p.id))}</option>`))
    .concat(`<option value="__none"${nodeBatchForm.pond === "__none" ? " selected" : ""}>(清除池塘設定)</option>`)
    .join("");
  return `<div class="batch-bar">
    <b>已選 ${nodeBatchSel.size} 片</b>
    <select data-batch-field="pond">${opts}</select>
    <button type="button" class="btn-sm" data-batch="toggle">取消</button>
    <button type="button" class="btn-sm btn-primary" data-batch="apply"${nodeBatchSel.size && nodeBatchForm.pond ? "" : " disabled"}>套用</button>
  </div>`;
}

function selectBoardRange() {
  const a = boardIdParts(nodeBatchForm.from), b = boardIdParts(nodeBatchForm.to || nodeBatchForm.from);
  if (!a || !b) { showToast("請輸入板子編號,例如 A10", true); return; }
  // 只打數字時沿用另一端的字首(例如「A10 ~ 25」)
  const prefix = a[0] || b[0] || "A";
  if ((a[0] || prefix) !== (b[0] || prefix)) { showToast("前面的英文字母要一樣(例如 A10 到 A25)", true); return; }
  const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
  const hit = heartbeatIds(nodeLastData).filter((id) => {
    const p = boardIdParts(id);
    return p && p[0] === prefix && p[1] >= lo && p[1] <= hi;
  });
  if (!hit.length) { showToast(`${prefix}${lo} ~ ${prefix}${hi} 沒有找到板子`, true); return; }
  hit.forEach((id) => nodeBatchSel.add(id));
  showToast(`已選取 ${hit.length} 片(${prefix}${lo} ~ ${prefix}${hi})`);
  renderNodesPage();
}

// 一次寫入:所有選取的板子設到同一個池塘(或清除),再同步告警群組
async function applyBatchBind() {
  if (!db || !nodeBatchSel.size || !nodeBatchForm.pond) return;
  const pondId = nodeBatchForm.pond === "__none" ? "" : nodeBatchForm.pond;
  const ids = [...nodeBatchSel];
  const nodePonds = { ...(options.nodePonds || {}) };
  for (const id of ids) { if (pondId) nodePonds[id] = pondId; else delete nodePonds[id]; }
  const res = await busyWrite("儲存中…", () => updateDoc(doc(db, ...DB_ROOT, "settings", "options"), { nodePonds }), { fail: "池塘設定沒有存到" });
  if (!res) { renderNodesPage(); return; }   // 失敗:畫面(下拉 / 勾選)回到原本的樣子
  options.nodePonds = nodePonds;   // onSnapshot 回來前先用新值
  await syncAlertGroups();
  exitBatchMode();   // 套用完就離開;要再設定下一批,重按「一次設定多片的池塘」
  renderNodesPage();
  if (res === "ok") showToast(pondId ? `✓ ${ids.length} 片已設定在 ${pondLabel(pondId)}` : `✓ ${ids.length} 片已清除池塘設定`);
}

// 點方塊 → modal 顯示該板完整資料(沿用 nodeCard);資料每分鐘更新時 modal 一起更新。
let nodeOpenId = null;
function renderNodeModal() {
  const node = nodeLastData?.[nodeOpenId];
  // 狀態直接放在標題名稱後面(「A01 ● 正常」),卡片本身的標題列在 modal 裡隱藏
  const label = nodeLabel(nodeOpenId, node);
  const st = nodeState(nodeOpenId, node);
  $("#nodeModalTitle").innerHTML = `${escapeHtml(label)}<span class="node-dot ${st.cls}${nodeMuted(nodeOpenId) && node ? " muted" : ""}">${escapeHtml(nodeStateShort(nodeOpenId, node))}</span>`;
  $("#nodeModalBody").innerHTML = nodeCard(nodeOpenId, node, Infinity);
}
function openNodeModal(id) {
  nodeOpenId = id;
  renderNodeModal();
  $("#nodeOverlay").hidden = false;
}
function closeNodeModal() {
  nodeOpenId = null;
  $("#nodeOverlay").hidden = true;
}
function setupNodesPage() {
  const box = $("#nodesContainer");
  box.addEventListener("click", (e) => {
    const tile = e.target.closest(".node-tile[data-node]");
    if (tile && nodeBatchMode) {
      const id = tile.dataset.node;
      nodeBatchSel.has(id) ? nodeBatchSel.delete(id) : nodeBatchSel.add(id);
      renderNodesPage();
      return;
    }
    const open = e.target.closest("[data-node]");
    if (open) { openNodeModal(open.dataset.node); return; }
    const f = e.target.closest("[data-node-filter]");
    if (f) { nodeFilter = f.dataset.nodeFilter; renderNodesPage(); return; }
    const b = e.target.closest("[data-batch]");
    if (!b) return;
    ({
      toggle: () => { if (nodeBatchMode) exitBatchMode(); else { nodeBatchMode = true; nodeBatchSel.clear(); } renderNodesPage(); },
      range: selectBoardRange,
      all: () => { b.dataset.batchIds.split(",").filter(Boolean).forEach((id) => nodeBatchSel.add(id)); renderNodesPage(); },
      clear: () => { nodeBatchSel.clear(); renderNodesPage(); },
      apply: applyBatchBind,
    })[b.dataset.batch]?.();
  });
  // 範圍輸入 / 池塘下拉:存進 nodeBatchForm(重畫時還原);池塘一選就更新「套用」可否按
  box.addEventListener("input", (e) => {
    const f = e.target.dataset?.batchField;
    if (f) nodeBatchForm[f] = e.target.value.trim();
  });
  box.addEventListener("change", (e) => {
    if (e.target.dataset?.batchField !== "pond") return;
    nodeBatchForm.pond = e.target.value;
    renderNodesPage();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.dataset?.batchField) selectBoardRange();
  });
  // 記住「進階資訊」摺疊區開著哪幾片(toggle 事件不冒泡,用 capture 接)
  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (!d.matches?.("details[data-adv]")) return;
    d.open ? nodeAdvOpen.add(d.dataset.adv) : nodeAdvOpen.delete(d.dataset.adv);
  }, true);
  $("#nodeModalClose").addEventListener("click", closeNodeModal);
  $("#nodeOverlay").addEventListener("click", (e) => { if (e.target.id === "nodeOverlay") closeNodeModal(); });
  // Esc:上面還疊著確認框 / 暫停框時只關那一層(它們自己會處理),不要連板子 modal 一起關
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#nodeOverlay").hidden && $("#modalOverlay").hidden && $("#alertPauseOverlay").hidden && $("#pondBoardsOverlay").hidden) closeNodeModal();
  });
}

// ============================================================
//  編輯紀錄 modal(獨立於上方新增表單;上方永遠新增,編輯一律走這裡)
// ============================================================
let editPeriod = "morning";   // 編輯 modal 自己的時段狀態(與新增的 currentPeriod 分離)

function setupEditModal() {
  const overlay = $("#editOverlay");
  if (!overlay) return;
  $("#editClose").addEventListener("click", closeEditModal);
  $("#editCancelBtn").addEventListener("click", closeEditModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeEditModal(); });
  document.addEventListener("keydown", (e) => {
    // 池塘 picker 開著時 Esc 讓它先處理;這裡只在編輯 modal 是最上層時關閉
    if (e.key === "Escape" && !overlay.hidden && $("#pondPickerOverlay").hidden) closeEditModal();
  });

  // 時段切換
  $("#editPeriodSeg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    editPeriod = btn.dataset.period;
    $$("#editPeriodSeg .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  });

  // 池塘選定後(picker 觸發 change)→ 更新編輯 modal 的群組標籤
  $("#editPondSelect").addEventListener("change", renderEditTags);

  // 包數 +/−
  $$("#editForm [data-editstep]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const el = $("#editBagsInt");
      el.value = Math.max(0, (parseInt(el.value, 10) || 0) + Number(btn.dataset.editstep));
    }));
  $("#editBagsInt").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, ""); });
  $("#editBagsInt").addEventListener("blur", (e) => { if (e.target.value === "") e.target.value = "0"; });

  $("#editForm").addEventListener("submit", onSaveEdit);
  $("#editDeleteBtn").addEventListener("click", async () => {
    if (!editingId) return;
    const id = editingId;
    // 先收起編輯 modal,只留刪除確認框(避免被編輯 modal 擋住);保留編輯中的欄位狀態
    $("#editOverlay").hidden = true;
    const ok = await onDelete(id);
    if (ok) {
      closeEditModal();   // 真的刪了 → 收尾(清 editingId、取消反白)
    } else {
      $("#editOverlay").hidden = false;   // 取消刪除 → 原封不動把編輯 modal 開回來
    }
  });
}

// 編輯只選現有池塘 → 填入「現有池塘」選項(隱藏 select 作為 picker 真值來源)
function fillEditPondSelect() {
  fillSelect($("#editPondSelect"), options.ponds, { allowEmpty: true, emptyLabel: "—", labelFn: pondLabel });
}

function startEdit(id) {
  const r = allRecords.find((x) => x.id === id);
  if (!r) return;
  editingId = id;

  // 選項清單(可能在 options 載入後才齊全)→ 開啟時重填一次,確保有值可選
  fillEditPondSelect();
  fillSelect($("#editFeedNoSelect"), options.feedNos);
  fillSelect($("#editMixSelect"), options.mixes, { allowEmpty: true });
  fillSelect($("#editDisinfectantSelect"), options.disinfectants, { allowEmpty: true });

  $("#editDateInput").value = r.date;
  editPeriod = r.period || "morning";
  $$("#editPeriodSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.period === editPeriod));

  // 池塘:原池仍在清單就選它;已被刪則留空(編輯只能選現有池塘,需重新挑一個)
  $("#editPondSelect").value = options.ponds.some((p) => p.id === r.pondId) ? r.pondId : "";
  renderPondPicker("edit");
  renderEditTags();

  $("#editBagsInt").value = Math.round(Number(r.bags) || 0);
  $("#editFeedNoSelect").value = r.feedNoId || "";
  $("#editMixSelect").value = r.mixId || "";
  $("#editDisinfectantSelect").value = r.disinfectantId || "";
  $("#editNoteInput").value = r.note || "";
  $("#editUpdateWeather").checked = true;   // 每次開啟預設打勾(modal 重用,需重設避免殘留上次狀態)
  // 標題下:這筆什麼時候建立、最後什麼時候改過(和上面的「日期」= 紀錄的日期分開)
  const stamp = recordStampLine(r);
  $("#editStamp").textContent = stamp;
  $("#editStamp").hidden = !stamp;

  renderTodayList();           // 反白「編輯中」那筆
  $("#editOverlay").hidden = false;
}

function closeEditModal() {
  if ($("#editOverlay").hidden) return;
  $("#editOverlay").hidden = true;
  editingId = null;
  renderTodayList();           // 取消「編輯中」反白
}

// 編輯 modal 內:依選定池塘顯示可勾選的群組標籤(沿用 togglePondTag)
function renderEditTags() {
  const box = $("#editRecordTags");
  const pondId = $("#editPondSelect").value;
  const tags = options.tags || [];
  if (!pondId || !tags.length) { box.hidden = true; box.innerHTML = ""; return; }
  const mine = new Set((options.pondTags || {})[pondId] || []);
  box.hidden = false;
  box.innerHTML = `
    <span class="record-tags-label">群組(${escapeHtml(pondName(pondId))}):</span>
    ${tags.map((t) => `
      <button type="button" class="tag-pick ${mine.has(t) ? "on" : ""}" data-rectag="${escapeHtml(t)}">${escapeHtml(t)}</button>
    `).join("")}`;
  box.querySelectorAll("[data-rectag]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (await togglePondTag(pondId, b.dataset.rectag)) b.classList.toggle("on");
    }));
}

async function onSaveEdit(e) {
  e.preventDefault();
  if (!db) { showToast("尚未設定 Firebase,無法儲存", true); return; }
  if (!editingId) return;

  const pondId = $("#editPondSelect").value;
  if (!pondId) { showToast("請選擇池塘", true); return; }
  const bags = Math.max(0, parseInt($("#editBagsInt").value, 10) || 0);
  if (bags <= 0) { showToast("包數需大於 0", true); return; }

  const rec = {
    pondId,
    date: $("#editDateInput").value,
    period: editPeriod,
    bags,
    feedNoId: $("#editFeedNoSelect").value || "",
    mixId: $("#editMixSelect").value || "",
    disinfectantId: $("#editDisinfectantSelect").value || "",
    note: $("#editNoteInput").value.trim(),
  };

  const btn = $("#editSaveBtn");
  const startedAt = Date.now();
  const id = editingId;   // 等待期間 editingId 可能被清掉,先記下來
  const what = `${pondLabel(rec.pondId)} ${fmt(rec.bags)}包`;
  const btnText = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = SPIN_HTML("上傳中…");

  // 溫度:依「更新當下溫度」checkbox 決定。
  //   打勾 → 改成「更新此刻」的溫度(用途:清晨建立、上午吃完才更新,溫度應反映更新時刻)。
  //   不打勾 → 完全不動 siteTemp 欄(用途:晚上或隔天才補登,不該把溫度改成補登當下)。
  let res;
  try {
    const patch = { ...rec, updatedAt: serverTimestamp() };
    if ($("#editUpdateWeather").checked) patch.siteTemp = await currentSiteTempField();
    holdPending.add(id);
    const write = updateDoc(doc(db, ...DB_ROOT, "records", id), patch);
    res = await waitWrite(write, startedAt);
    if (res.slow) followSlowWrite(write, "更新", what);
  } catch (err) {
    res = { ok: false, err };
  } finally {
    btn.disabled = false;
    btn.textContent = btnText;
    releaseHold(id);
  }
  if (res.ok) {
    showToast(`已更新 ✔ ${what}`);
    closeEditModal();
  } else if (res.slow) {
    showToast(`⏳ 網路很慢,修改還在上傳中。已記在這支手機,會自動補傳,不用重改。`, false, 7000);
    closeEditModal();
  } else {
    showWriteFail("更新", what, res.err);   // 視窗不關,改的內容還在,可以再按一次
  }
}

// ============================================================
//  列表 / 查詢頁
// ============================================================
let listMode = "month";   // 'month'(月區間)| 'day'(日區間)

function setupList() {
  // 預設:月模式查當月、日模式查今天
  $("#listMonthFrom").value = thisMonthStr();
  $("#listMonthTo").value = thisMonthStr();
  $("#listDayFrom").value = todayStr();
  $("#listDayTo").value = todayStr();

  $("#listModeMonth").addEventListener("click", () => setListMode("month"));
  $("#listModeDay").addEventListener("click", () => setListMode("day"));

  ["#listMonthFrom", "#listMonthTo", "#listDayFrom", "#listDayTo",
   "#listPondFilter"].forEach((sel) =>
    $(sel).addEventListener("change", renderList));

  // 切換群組:池塘下拉只留該群組的池塘,再重新查詢
  $("#listTagFilter").addEventListener("change", () => {
    fillPondFilter($("#listPondFilter"), $("#listTagFilter").value);
    renderList();
  });
}

function setListMode(mode) {
  listMode = mode;
  $("#listModeMonth").classList.toggle("active", mode === "month");
  $("#listModeDay").classList.toggle("active", mode === "day");
  $("#listMonthRange").hidden = mode !== "month";
  $("#listDayRange").hidden = mode !== "day";
  renderList();
}

function filteredRecords() {
  const tag = $("#listTagFilter").value;     // 群組(標籤)或 ""
  const pond = $("#listPondFilter").value;
  let recs = allRecords.slice();

  if (listMode === "month") {
    // 月區間:比較 YYYY-MM;起迄可顛倒、可同月、可只填一邊
    let from = $("#listMonthFrom").value;
    let to = $("#listMonthTo").value;
    if (from && to && from > to) [from, to] = [to, from];
    if (from) recs = recs.filter((r) => (r.date || "").slice(0, 7) >= from);
    if (to)   recs = recs.filter((r) => (r.date || "").slice(0, 7) <= to);
  } else {
    // 日區間:比較 YYYY-MM-DD;起迄可顛倒、可同日、可只填一邊
    let from = $("#listDayFrom").value;
    let to = $("#listDayTo").value;
    if (from && to && from > to) [from, to] = [to, from];
    if (from) recs = recs.filter((r) => (r.date || "") >= from);
    if (to)   recs = recs.filter((r) => (r.date || "") <= to);
  }

  if (tag) { const set = pondsWithTag(tag); recs = recs.filter((r) => set.has(r.pondId)); }
  if (pond) recs = recs.filter((r) => r.pondId === pond);
  // 排序:日期新→舊,同日早上在前,同日同時段再依建立時間新→舊
  recs.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    const pa = a.period === "morning" ? 0 : 1;
    const pb = b.period === "morning" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return recordTimeMs(b) - recordTimeMs(a);
  });
  return recs;
}

function renderList() {
  const recs = filteredRecords();
  $("#listCount").textContent = `共 ${recs.length} 筆`;
  const c = $("#listContainer");
  if (!recs.length) { c.innerHTML = '<p class="empty">這個範圍沒有紀錄</p>'; return; }

  c.innerHTML = recs.map((r) => {
    const parts = [];
    const fn = feedName(r.feedNoId), mn = mixName(r.mixId), dn = disinfectantName(r.disinfectantId);
    // 飼料 + 包數合併:有飼料顯示「y號 x包」,沒飼料只顯示「x包」
    parts.push(`<b>${fn ? escapeHtml(fn) + " " : ""}${escapeHtml(r.bags)}包</b>`);
    if (mn) parts.push(`<span class="k">拌料</span> ${escapeHtml(mn)}`);
    if (dn) parts.push(`<span class="k">消毒</span> ${escapeHtml(dn)}`);
    const wt = siteTempStr(r);
    if (wt) parts.push(`<span class="rec-temp">${escapeHtml(wt)}</span>`);
    const note = r.note ? `<div class="rec-body"><span class="k">備註</span> ${escapeHtml(r.note)}</div>` : "";
    // 右上角只放「紀錄的日期」;建立 / 更新時間(一律帶日期)放下方動作列左側,不再和紀錄日期黏在一起
    const dateLine = escapeHtml(r.date);
    const stamp = recordStampLine(r);
    const edited = stamp ? `<span class="rec-edited">${escapeHtml(stamp)}</span>` : "";
    return `
      <div class="rec">
        <div class="rec-top">
          <span class="rec-pond">${escapeHtml(pondLabel(r.pondId))}
            <span class="badge ${r.period}">${periodLabel(r.period)}</span>${pendingRecordIds.has(r.id) ? ` <span class="rec-pending" title="還在這支手機上,網路恢復會自動上傳">⏳ 上傳中</span>` : ""}
          </span>
          <span class="rec-date">${dateLine}</span>
        </div>
        <div class="rec-body">${parts.join(" ・ ")}</div>
        ${note}
        <div class="rec-actions">
          ${edited}
          <span class="rec-actions-btns">
            <button class="btn-sm" data-edit="${r.id}">編輯</button>
            <button class="btn-sm btn-danger" data-del="${r.id}">刪除</button>
          </span>
        </div>
      </div>`;
  }).join("");

  c.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => startEdit(b.dataset.edit)));
  c.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => onDelete(b.dataset.del)));
}

// 回傳 true=已刪除(或網路很慢、已排隊會自動補傳)、false=取消或失敗(供編輯模式刪除後決定是否關視窗)
async function onDelete(id) {
  const r = allRecords.find((x) => x.id === id);
  const ok = await showConfirm(
    `確定刪除這筆紀錄?\n\n${recordDetailText(r)}`,
    { okText: "刪除", danger: true }
  );
  if (!ok) return false;
  const what = r ? ` ${pondLabel(r.pondId)} ${fmt(Number(r.bags) || 0)}包` : "";
  const res = await busyWrite("刪除中…", () => deleteDoc(doc(db, ...DB_ROOT, "records", id)), { fail: `這筆沒有刪掉${what}` });
  if (res === "ok") showToast(`已刪除 ✔${what}`);
  return !!res;
}

// ============================================================
//  月統計頁
// ============================================================
let statsMode = "overview";   // 'overview'(月份總覽)| 'single'(單月詳細)

function setupStats() {
  $("#statsMonth").value = thisMonthStr();
  $("#statsMonth").addEventListener("change", renderStats);
  $("#statsTagFilter").addEventListener("change", () => {
    fillPondFilter($("#statsPondFilter"), $("#statsTagFilter").value);
    renderStatsView();
  });
  $("#statsPondFilter").addEventListener("change", renderStatsView);
  $("#exportBtn").addEventListener("click", exportExcel);
  $("#exportRangeBtn").addEventListener("click", exportRange);
  $("#exportPdfBtn").addEventListener("click", exportPdf);
  $("#exportRangePdfBtn").addEventListener("click", exportRangePdf);
  $("#previewBtn").addEventListener("click", previewExcel);
  $("#previewRangeBtn").addEventListener("click", previewRange);
  setupChartTooltip();

  // 總覽 / 單月 切換
  $$("#statsModeSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      statsMode = btn.dataset.mode;
      $$("#statsModeSeg .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderStatsView();
    });
  });

  // 快選區間鈕:換算成起訖月填入欄位
  $$("#quickRange .chip-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const r = btn.dataset.range;
      if (r === "all") {
        $("#rangeFrom").value = "";
        $("#rangeTo").value = "";
      } else {
        const months = Number(r);
        const now = thisMonthStr();                 // YYYY-MM
        $("#rangeTo").value = now;
        $("#rangeFrom").value = addMonths(now, -(months - 1));
      }
      setActiveQuick(r);
      renderOverview();
    });
  });

  // 手動改起訖月 → 視為自訂區間,清掉快選高亮
  ["#rangeFrom", "#rangeTo"].forEach((sel) => {
    $(sel).addEventListener("change", () => { setActiveQuick(null); renderOverview(); });
  });
}

// YYYY-MM 加減月份
function addMonths(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const idx = (y * 12 + (m - 1)) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

// 設定快選鈕高亮(null = 全部不亮,代表自訂區間)
function setActiveQuick(range) {
  $$("#quickRange .chip-btn").forEach((b) => b.classList.toggle("active", b.dataset.range === range));
}

// 依目前模式決定要渲染總覽還是單月
function renderStatsView() {
  const single = statsMode === "single";
  $("#statsSingleControls").hidden = !single;
  $("#statsRangeControls").hidden = single;
  $("#statsOverview").innerHTML = "";
  $("#statsContainer").innerHTML = "";
  if (single) renderStats();
  else renderOverview();
}

// 套用統計頁「群組 + 池塘」過濾(可疊加)
function statsTagFiltered(recs) {
  const tag = $("#statsTagFilter").value;
  const pond = $("#statsPondFilter").value;
  let out = recs;
  if (tag) { const set = pondsWithTag(tag); out = out.filter((r) => set.has(r.pondId)); }
  if (pond) out = out.filter((r) => r.pondId === pond);
  return out;
}

function statsRecords() {
  const month = $("#statsMonth").value;
  const recs = allRecords.filter((r) => month && (r.date || "").startsWith(month));
  return statsTagFiltered(recs);
}

// ---------- 月份總覽 ----------
// 列出所有有資料的月份,每月顯示總包數、長條圖、各飼料包數;點月份可展開單月詳細。
function renderOverview() {
  const c = $("#statsOverview");
  if (!allRecords.length) { c.innerHTML = '<p class="empty">尚無任何紀錄</p>'; return; }

  // 區間(起訖月,空字串代表不限)
  const from = $("#rangeFrom").value;
  const to = $("#rangeTo").value;

  // 依月份彙整(套用群組視角 + 區間過濾)
  const byMonth = {};   // { 'YYYY-MM': { total, count, feeds: {編號: 包數} } }
  for (const r of statsTagFiltered(allRecords)) {
    const m = (r.date || "").slice(0, 7);
    if (!m) continue;
    if (from && m < from) continue;
    if (to && m > to) continue;
    const b = Number(r.bags) || 0;
    const e = (byMonth[m] ||= { total: 0, count: 0, feeds: {} });
    e.total += b;
    e.count += 1;
    const fk = feedName(r.feedNoId) || "(未填)";
    e.feeds[fk] = (e.feeds[fk] || 0) + b;
  }

  const months = Object.keys(byMonth).sort().reverse();   // 新月份在上
  if (!months.length) { c.innerHTML = '<p class="empty">這個區間內沒有紀錄</p>'; return; }
  const maxTotal = Math.max(...months.map((m) => byMonth[m].total), 1);
  const grandTotal = months.reduce((s, m) => s + byMonth[m].total, 0);
  // 區間說明文字
  const rangeText = (from || to)
    ? `${from || "最早"} ～ ${to || "最新"}`
    : "全部月份";

  // 飼料配色:用區間內紀錄建一次,跨月一致(月份 bar 依此堆疊)
  const ovRecs = statsTagFiltered(allRecords).filter((r) => {
    const m = (r.date || "").slice(0, 7);
    return m && (!from || m >= from) && (!to || m <= to);
  });
  const feedColor = buildFeedColorMap(ovRecs);

  const rows = months.map((m) => {
    const e = byMonth[m];
    const pct = Math.max(2, Math.round((e.total / maxTotal) * 100));
    // 月份 bar:依飼料堆疊色塊(柱長=該月 vs 最大月;段內依飼料佔該月比例)
    const sortedFeeds = Object.entries(e.feeds).sort((a, b) => b[1] - a[1]);
    const lastIdx = sortedFeeds.length - 1;
    const segs = sortedFeeds.map(([f, v], i) => {
      const style = i === lastIdx
        ? `flex:1 1 auto;background:${feedColor[f]}`
        : `flex:0 0 ${(v / e.total) * 100}%;background:${feedColor[f]}`;
      return `<span class="gseg" style="${style}"><span class="gseg-txt">${escapeHtml(f)} ${fmt(v)}</span></span>`;
    }).join("");
    // 各飼料:依包數大→小,做成小標籤(保留)
    const feedTags = sortedFeeds
      .map(([k, v]) => `<span class="feed-tag"><span class="feed-dot" style="background:${feedColor[k]}"></span>${escapeHtml(k)} <b>${fmt(v)}</b></span>`).join("");
    return `
      <div class="ov-row" data-month="${m}" role="button" tabindex="0" title="點此查看 ${m} 詳細">
        <div class="ov-head">
          <span class="ov-month">${m}</span>
          <span class="ov-total">${fmt(e.total)} <small>包</small></span>
        </div>
        <div class="ov-bar"><span class="ov-bar-fill" style="width:${pct}%">${segs}</span></div>
        <div class="ov-meta">
          <span class="ov-count">${e.count} 筆</span>
          <span class="ov-feeds">${feedTags}</span>
        </div>
      </div>`;
  }).join("");

  // 分組堆疊橫條圖:每月一區,區內每池一條,柱內依飼料編號堆疊
  const groupedCard = renderMonthlyGroupedChart(months, rangeText);

  c.innerHTML = `
    ${groupedCard}
    <div class="card ov-card">
      <div class="stats-title">📅 月份總覽(${months.length} 個月・${rangeText})</div>
      ${rows}
      <div class="ov-grand">區間合計 <b>${fmt(grandTotal)}</b> 包</div>
    </div>`;

  // 點某月 → 切到單月詳細
  c.querySelectorAll(".ov-row").forEach((el) => {
    const go = () => openSingleMonth(el.dataset.month);
    el.addEventListener("click", go);
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
  });
  // 點分組圖的某月區塊 → 跳單月詳細
  c.querySelectorAll("[data-gmonth]").forEach((el) =>
    el.addEventListener("click", () => openSingleMonth(el.dataset.gmonth)));
}

// 跟隨滑鼠的圖表 tooltip:text 用「|」分行,第一行粗體。統計頁與板子頁的氣溫圖共用
function chartTipShow(text, x, y) {
  const tip = $("#chartTip");
  tip.innerHTML = text.split("|").map((line, i) =>
    i === 0 ? `<b>${escapeHtml(line)}</b>` : escapeHtml(line)).join("<br>");
  tip.hidden = false;
  // 預設在滑鼠右下,靠近右/下邊界時翻向左/上,避免超出視窗
  const pad = 14;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = x + pad, top = y + pad;
  if (left + w > window.innerWidth - 8) left = x - w - pad;
  if (top + h > window.innerHeight - 8) top = y - h - pad;
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}
function chartTipHide() { $("#chartTip").hidden = true; }

// 統計頁:委派在統計容器上,hover [data-tip] 顯示
function setupChartTooltip() {
  const containers = ["#statsOverview", "#statsContainer"].map($);
  const show = chartTipShow;
  const hide = chartTipHide;

  for (const c of containers) {
    if (!c) continue;
    c.addEventListener("pointermove", (e) => {
      const row = e.target.closest("[data-tip]");
      if (row) show(row.dataset.tip, e.clientX, e.clientY);
      else hide();
    });
    c.addEventListener("pointerleave", hide);
  }
}

// 分組堆疊橫條圖:每月一區,區內每池一條,柱長=該池總包數,柱內依飼料編號堆疊色塊。
// months: 月份陣列(新→舊);用全域過濾後的紀錄重新彙整到「月→池→飼料」。
function renderMonthlyGroupedChart(months, rangeText) {
  if (!months.length) return "";
  // 月→池→{ total, feeds:{飼料:包數} }
  const data = {};
  let maxPond = 1;                       // 全部池條的最大總量(統一比例尺,跨月可比)
  const filtered = statsTagFiltered(allRecords).filter((r) => months.includes((r.date || "").slice(0, 7)));
  for (const r of filtered) {
    const m = (r.date || "").slice(0, 7);
    const b = Number(r.bags) || 0;
    const mo = (data[m] ||= {});
    const po = (mo[r.pondId] ||= { total: 0, feeds: {} });
    const fk = feedName(r.feedNoId) || "(未填)";
    po.total += b;
    po.feeds[fk] = (po.feeds[fk] || 0) + b;
    if (po.total > maxPond) maxPond = po.total;
  }
  const feedColor = buildFeedColorMap(filtered);

  const monthBlocks = [...months].reverse().map((m) => {   // 舊→新
    const ponds = Object.entries(data[m] || {}).sort((a, b) => b[1].total - a[1].total);
    const monthTotal = ponds.reduce((s, [, info]) => s + info.total, 0);
    return `
      <div class="gmonth" data-gmonth="${m}" role="button" tabindex="0">
        <div class="gmonth-head">${escapeHtml(m)} <span class="gmonth-total">(共 ${fmt(monthTotal)} 包)</span></div>
        ${stackedPondRows(ponds, maxPond, feedColor)}
      </div>`;
  }).join("");

  // 飼料圖例
  const legend = Object.keys(feedColor).map((f) =>
    `<span class="g-leg"><span class="pie-dot" style="background:${feedColor[f]}"></span>${escapeHtml(f)}</span>`).join("");

  return `
    <div class="card">
      <div class="stats-title">📊 各月 × 各池包數(依飼料堆疊)</div>
      <div class="g-legend">${legend}</div>
      <div class="grouped-chart">${monthBlocks}</div>
      <p class="hint">每月一區,每條為一個池;柱內顏色=飼料編號。點月份可看詳細。</p>
    </div>`;
}

// 產生堆疊橫條列(共用於月份總覽與單月詳細)。
// pondsEntries: [[pond, {total, feeds:{料號:包數}}], ...](已排序);maxVal: 比例尺;feedColor: 料號→色。
function stackedPondRows(pondsEntries, maxVal, feedColor) {
  return pondsEntries.map(([pond, info]) => {
    const widthPct = Math.max(2, Math.round((info.total / maxVal) * 100));
    const sortedFeeds = Object.entries(info.feeds).sort((a, b) => b[1] - a[1]);
    const lastIdx = sortedFeeds.length - 1;
    const segs = sortedFeeds.map(([f, v], i) => {
      // 最後一段用 flex:1 吃掉剩餘,避免各段 round 後加總 ≠ 100% 在末端露出底色
      const style = i === lastIdx
        ? `flex:1 1 auto;background:${feedColor[f]}`
        : `flex:0 0 ${(v / info.total) * 100}%;background:${feedColor[f]}`;
      return `<span class="gseg" style="${style}"><span class="gseg-txt">${escapeHtml(f)} ${fmt(v)}包</span></span>`;
    }).join("");
    const tip = `${pondLabel(pond)}(共 ${fmt(info.total)} 包)|` +
      sortedFeeds.map(([f, v]) => `${f}: ${fmt(v)} 包`).join("|");
    return `
      <div class="gp-row" data-tip="${escapeHtml(tip)}">
        <span class="gp-name">${escapeHtml(pondLabel(pond))}</span>
        <span class="gp-track"><span class="gp-bar" style="width:${widthPct}%">${segs}</span></span>
        <span class="gp-val">${fmt(info.total)}包</span>
      </div>`;
  }).join("");
}

// 依一組紀錄建「料號→顏色」對應(用設定的料號順序,讓配色穩定一致)
function buildFeedColorMap(recs) {
  const present = new Set(recs.map((r) => feedName(r.feedNoId) || "(未填)"));
  const ordered = [...(options.feedNos || []).map((it) => it.name), "(未填)"].filter((f) => present.has(f));
  // 補上不在設定清單裡的(保險)
  for (const f of present) if (!ordered.includes(f)) ordered.push(f);
  const map = {};
  ordered.forEach((f, i) => { map[f] = CHART_COLORS[i % CHART_COLORS.length]; });
  return map;
}

// 從總覽點某月,切換到單月詳細並定位到該月
function openSingleMonth(month) {
  statsMode = "single";
  $$("#statsModeSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === "single"));
  $("#statsMonth").value = month;
  renderStatsView();
}

function renderStats() {
  const recs = statsRecords();
  const c = $("#statsContainer");
  if (!recs.length) { c.innerHTML = '<p class="empty">這個月沒有紀錄</p>'; return; }
  const month = $("#statsMonth").value;
  c.innerHTML = buildStatsCardsHtml(recs, month ? [month] : []) +
    `<p class="hint">本月共 ${recs.length} 筆紀錄。</p>`;
}

// 依一組紀錄組出統計八卡 HTML(池塘堆疊圖/池塘明細卡/料號總量/群組總量/每日日曆/群組表/池塘表/料號表)。
// months=要畫日曆的月份陣列(單月詳細傳一個;PDF 區間匯出傳多個,每月一張日曆)。
// 統計頁畫面與 PDF 匯出共用,確保兩邊內容一致。
function buildStatsCardsHtml(recs, months = [], { pdf = false } = {}) {
  // (1) 各池塘總包數
  const byPond = {};
  // (2) 各飼料編號包數
  const byFeed = {};
  let totalBags = 0;
  for (const r of recs) {
    const b = Number(r.bags) || 0;
    totalBags += b;
    byPond[r.pondId] = (byPond[r.pondId] || 0) + b;
    const fk = feedName(r.feedNoId) || "(未填)";
    byFeed[fk] = (byFeed[fk] || 0) + b;
  }

  // (3) 各標籤(群組)總包數:該標籤涵蓋的池塘加總,並記錄涵蓋哪些池
  const byTag = {};   // { 標籤: { total, ponds:Set(池名) } }
  for (const [pondId, bags] of Object.entries(byPond)) {
    for (const t of (options.pondTags || {})[pondId] || []) {
      const e = (byTag[t] ||= { total: 0, ponds: new Set() });
      e.total += bags;
      e.ponds.add(pondName(pondId));
    }
  }

  const pondRows = Object.entries(byPond).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${escapeHtml(pondLabel(k))}</td><td class="num">${fmt(v)}</td></tr>`).join("");
  const feedRows = Object.entries(byFeed)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td class="num">${fmt(v)}</td></tr>`).join("");
  // 標籤列依設定的標籤順序排列
  const tagRows = (options.tags || []).filter((t) => byTag[t])
    .map((t) => {
      const e = byTag[t];
      const ponds = [...e.ponds].join("、");
      return `<tr><td>${escapeHtml(t)}<span class="tag-ponds">${escapeHtml(ponds)}</span></td><td class="num">${fmt(e.total)}</td></tr>`;
    }).join("");

  // 各標籤統計表(有貼標籤才顯示);刻意無合計列 —— 不同標籤不應相加
  const tagCard = tagRows ? `
    <div class="card">
      <div class="stats-title">🏷️ 各群組總包數</div>
      <table>
        <thead><tr><th>群組</th><th class="num">總包數</th></tr></thead>
        <tbody>${tagRows}</tbody>
      </table>
      <p class="hint">每個群組獨立計算(該群組所有池的加總);不同群組不應相加。</p>
    </div>` : "";

  // ---- 圖形化 ----
  // 每池→料號→包數(供堆疊橫條圖)
  const pondFeeds = {};   // { pond: { total, feeds:{料號:包數} } }
  for (const r of recs) {
    const b = Number(r.bags) || 0;
    const e = (pondFeeds[r.pondId] ||= { total: 0, feeds: {} });
    const fk = feedName(r.feedNoId) || "(未填)";
    e.total += b;
    e.feeds[fk] = (e.feeds[fk] || 0) + b;
  }
  const pondEntries = Object.entries(pondFeeds).sort((a, b) => b[1].total - a[1].total);
  const maxPondVal = Math.max(...pondEntries.map(([, e]) => e.total), 1);
  const feedColorMap = buildFeedColorMap(recs);
  const feedLegend = Object.keys(feedColorMap)
    .map((f) => `<span class="g-leg"><span class="pie-dot" style="background:${feedColorMap[f]}"></span>${escapeHtml(f)}</span>`).join("");

  // 各池塘(依料號堆疊)
  const barCard = pondEntries.length ? `
    <div class="card">
      <div class="stats-title">📊 各池塘包數(依料號堆疊)</div>
      <div class="g-legend">${feedLegend}</div>
      <div class="grouped-chart">${stackedPondRows(pondEntries, maxPondVal, feedColorMap)}</div>
    </div>` : "";

  // 各料號總量(不分池,用料號色)
  const feedData = Object.entries(byFeed).sort((a, b) => b[1] - a[1])
    .map(([f, v]) => ({ label: f, value: v, color: feedColorMap[f] }));
  const feedBarCard = feedData.length ? `
    <div class="card">
      <div class="stats-title">🥡 各料號總量</div>
      ${simpleBar(feedData)}
    </div>` : "";

  // 各群組總量(用調色盤色)
  const groupData = Object.entries(byTag).sort((a, b) => b[1].total - a[1].total)
    .map(([t, e], i) => ({ label: t, value: e.total, color: CHART_COLORS[i % CHART_COLORS.length] }));
  const groupBarCard = groupData.length ? `
    <div class="card">
      <div class="stats-title">🏷️ 各群組總量</div>
      ${simpleBar(groupData)}
      <p class="hint">每個群組獨立計算,不同群組不應相加。</p>
    </div>` : "";

  // 各池塘 × 飼料明細:每池做成一張小卡(卡內直式條列各飼料 + 總共),多張卡自動換行並排。
  // PDF 時改為三張一列包成 .pf-row(不可跨頁的單位,避免同列小卡被頁界切到)。
  const pondFeedCards = pondEntries.map(([pondId, info]) => {
    const feedLines = Object.entries(info.feeds).sort((a, b) => b[1] - a[1])
      .map(([f, v]) => `<div class="pf-feed"><span>${escapeHtml(f)}</span><span class="num">${fmt(v)}包</span></div>`).join("");
    return `
      <div class="pf-card">
        <div class="pf-pond">${escapeHtml(pondLabel(pondId))}</div>
        ${feedLines}
        <div class="pf-total"><span>總共</span><span class="num">${fmt(info.total)}包</span></div>
      </div>`;
  });
  let pondFeedBody;
  if (pdf) {
    const rows = [];
    for (let i = 0; i < pondFeedCards.length; i += 3) rows.push(`<div class="pf-row">${pondFeedCards.slice(i, i + 3).join("")}</div>`);
    pondFeedBody = rows.join("");
  } else {
    pondFeedBody = `<div class="pf-cards">${pondFeedCards.join("")}</div>`;
  }
  const pondFeedCard = pondEntries.length ? `
    <div class="card pdf-flow">
      <div class="stats-title">🐟 各池塘飼料明細</div>
      ${pondFeedBody}
    </div>` : "";

  // 每日日曆熱力圖(單月一張;多月各一張,PDF 區間匯出用)
  const calBlock = (m, withHead) => {
    const mRecs = recs.filter((r) => (r.date || "").slice(0, 7) === m);
    const head = withHead ? `<div class="cal-month-head">${escapeHtml(m)}</div>` : "";
    return `<div class="cal-block">${head}${calendarHeatmap(mRecs, m)}</div>`;
  };
  // PDF 多月:每個月各自一張卡(外層再一卡一頁),避免同一卡塞多月被頁界切開
  const heatCards = !months.length ? [] : (pdf && months.length > 1)
    ? months.map((m) => `
      <div class="card">
        <div class="stats-title">🗓️ ${escapeHtml(m)} 每日包數</div>
        ${calBlock(m, false)}
      </div>`)
    : [`
      <div class="card pdf-flow">
        <div class="stats-title">🗓️ ${months.length > 1 ? "各月每日包數" : "當月每日包數"}</div>
        ${months.map((m) => calBlock(m, months.length > 1)).join("")}
      </div>`];

  const pondTotalCard = `
    <div class="card">
      <div class="stats-title">🏊 各池塘總包數</div>
      <table>
        <thead><tr><th>池塘</th><th class="num">總包數</th></tr></thead>
        <tbody>
          ${pondRows}
          <tr class="total"><td>合計</td><td class="num">${fmt(totalBags)}</td></tr>
        </tbody>
      </table>
    </div>`;
  const feedTotalCard = `
    <div class="card">
      <div class="stats-title">🥡 各飼料編號包數</div>
      <table>
        <thead><tr><th>飼料編號</th><th class="num">包數</th></tr></thead>
        <tbody>
          ${feedRows}
          <tr class="total"><td>合計</td><td class="num">${fmt(totalBags)}</td></tr>
        </tbody>
      </table>
    </div>`;

  const cards = [barCard, pondFeedCard, feedBarCard, groupBarCard, ...heatCards, tagCard, pondTotalCard, feedTotalCard]
    .filter((c) => c && c.trim());
  // PDF:一個統計角度獨占一頁 —— 卡與卡之間插入 html2pdf 的 legacy 分頁標記,
  // 列印/裁切時不會有圖表被頁界切成兩半(單卡本身仍可能超過一頁,如多月日曆)。
  if (pdf) return cards.join('<div class="html2pdf__page-break"></div>');
  return cards.join("\n");
}

function fmt(n) {
  // 去掉多餘小數(3.0 → 3,3.5 → 3.5)
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// ============================================================
//  圖形化統計(純 CSS/SVG,不依賴圖表庫)
// ============================================================
const CHART_COLORS = ["#0b7285", "#1971c2", "#2f9e44", "#e8590c", "#9c36b5", "#c2255c", "#5c940d", "#1098ad", "#f08c00", "#495057"];

// 簡單橫條圖(單色)。data = [{label, value, color}],已排序傳入。
function simpleBar(data) {
  if (!data.length) return "";
  const max = Math.max(...data.map((d) => d.value), 1);
  return `<div class="grouped-chart">` + data.map((d) => {
    const pct = Math.max(2, Math.round((d.value / max) * 100));
    return `
      <div class="gp-row" data-tip="${escapeHtml(`${d.label}: ${fmt(d.value)} 包`)}">
        <span class="gp-name">${escapeHtml(d.label)}</span>
        <span class="gp-track"><span class="gp-bar" style="width:${pct}%;background:${d.color || "var(--primary)"}"></span></span>
        <span class="gp-val">${fmt(d.value)}包</span>
      </div>`;
  }).join("") + `</div>`;
}

// 當月日曆熱力圖:格子=當月每一天,顏色深淺=當天總包數。recs=當月紀錄,month='YYYY-MM'。
function calendarHeatmap(recs, month) {
  if (!month) return "";
  const [y, m] = month.split("-").map(Number);
  const days = new Date(y, m, 0).getDate();              // 當月天數
  const firstDow = new Date(y, m - 1, 1).getDay();        // 1 號是星期幾(0=日)
  // 每日:總包數 + 明細紀錄(供 tooltip)
  const byDay = {};      // d -> { total, lines:[每筆字串] }
  let maxDay = 0;
  for (const r of recs) {
    const d = Number((r.date || "").slice(8, 10));
    if (!d) continue;
    const b = Number(r.bags) || 0;
    const e = (byDay[d] ||= { total: 0, lines: [] });
    e.total += b;
    // 每筆:池 時段 料號 N包(拌料/消毒若有附後)
    const extra = [mixName(r.mixId), disinfectantName(r.disinfectantId)].filter(Boolean).join("·");
    e.lines.push(`${pondLabel(r.pondId)} ${periodLabel(r.period)} ${feedName(r.feedNoId) || "(未填)"} ${fmt(b)}包${extra ? " " + extra : ""}`);
    if (e.total > maxDay) maxDay = e.total;
  }
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(`<div class="cal-cell cal-empty"></div>`);
  for (let d = 1; d <= days; d++) {
    const e = byDay[d];
    const v = e ? e.total : 0;
    const dateStr = `${month}-${String(d).padStart(2, "0")}`;
    // 0=無色,有值依比例上色(4 階)
    const level = v === 0 ? 0 : Math.min(4, Math.ceil((v / maxDay) * 4));
    // tooltip:第一行日期+總數,後面每筆明細
    const tip = v > 0
      ? [`${dateStr}(共 ${fmt(v)} 包・${e.lines.length} 筆)`, ...e.lines].join("|")
      : `${dateStr}|無紀錄`;
    cells.push(`<div class="cal-cell cal-l${level}" data-tip="${escapeHtml(tip)}"><span class="cal-d">${d}</span>${v > 0 ? `<span class="cal-v">${fmt(v)}<span class="cal-u">包</span></span>` : ""}</div>`);
  }
  const heads = ["日", "一", "二", "三", "四", "五", "六"].map((w) => `<div class="cal-head">${w}</div>`).join("");
  return `<div class="cal-grid">${heads}${cells.join("")}</div>`;
}

// ============================================================
//  匯出 Excel (SheetJS)
// ============================================================
// 單月:依目前月份 + 篩選,收集要輸出的紀錄與檔名標籤。null=無月份。
function collectMonth() {
  const month = $("#statsMonth").value;
  if (!month) { showToast("請先選擇月份", true); return null; }
  const recs = statsRecords();              // 已含群組/池塘篩選
  const tag = $("#statsTagFilter").value;
  const pond = $("#statsPondFilter").value;
  const label = [month, tag, pond].filter(Boolean).join("_");
  return { recs, label };
}

// 區間:依區間 + 群組/池塘篩選,收集紀錄與檔名標籤。
function collectRange() {
  const from = $("#rangeFrom").value;
  const to = $("#rangeTo").value;
  let recs = allRecords.filter((r) => {
    const m = (r.date || "").slice(0, 7);
    if (!m) return false;
    if (from && m < from) return false;
    if (to && m > to) return false;
    return true;
  });
  recs = statsTagFiltered(recs);   // 與畫面一致:套用群組/池塘篩選
  // 檔名帶上區間與篩選,方便辨識
  const tag = $("#statsTagFilter").value;
  const pond = $("#statsPondFilter").value;
  const range = (from || to) ? `${from || "最早"}_${to || "最新"}` : "全部";
  const label = [range, tag, pond].filter(Boolean).join("_");
  return { recs, label };
}

// 單月詳細頁:匯出 / 預覽
function exportExcel() {
  const c = collectMonth(); if (!c) return;
  exportToExcel(c.recs, c.label, { byMonth: false });
}
function previewExcel() {
  const c = collectMonth(); if (!c) return;
  previewExport(c.recs, c.label, { byMonth: false });
}

// 總覽頁:匯出 / 預覽(附月分總覽表)
function exportRange() {
  const c = collectRange();
  exportToExcel(c.recs, c.label, { byMonth: true });
}
function previewRange() {
  const c = collectRange();
  previewExport(c.recs, c.label, { byMonth: true });
}

// 一組紀錄涵蓋的月份(舊→新),供 PDF 決定要畫幾張日曆
function monthsOf(recs) {
  return [...new Set(recs.map((r) => (r.date || "").slice(0, 7)).filter(Boolean))].sort();
}

// 單月詳細頁:匯出 PDF(日曆只有當月一張)
function exportPdf() {
  const c = collectMonth(); if (!c) return;
  exportToPdf(c.recs, c.label, [$("#statsMonth").value]);
}
// 總覽頁:匯出 PDF(統計卡算整個區間;日曆每月一張)
function exportRangePdf() {
  const c = collectRange();
  exportToPdf(c.recs, c.label, monthsOf(c.recs));
}

// 組出各工作表的資料(明細 / 統計 / 群組統計 / 月分總覽),供匯出與預覽共用。
// 回傳 null 代表沒有資料。
function buildExportData(records, { byMonth = false } = {}) {
  const recs = records.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const pa = a.period === "morning" ? 0 : 1, pb = b.period === "morning" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    // 同日同時段依建立時間舊→新(與本表日期升序方向一致)
    return recordTimeMs(a) - recordTimeMs(b);
  });
  if (!recs.length) return null;

  // 工作表 1:明細
  const detail = recs.map((r) => ({
    "日期": r.date,
    "時段": periodLabel(r.period),
    "池塘": pondName(r.pondId),
    "群組": ((options.pondTags || {})[r.pondId] || []).join("-"),
    "包數": Number(r.bags) || 0,
    "飼料編號": feedName(r.feedNoId),
    "拌料": mixName(r.mixId),
    "消毒劑": disinfectantName(r.disinfectantId),
    "現場溫度": siteTempValue(r) ?? "",
    "測站溫度": stationTempValue(r) ?? "",
    "備註": r.note || ""
  }));

  // 工作表 2:統計(各池塘 / 各飼料)— 用名稱當顯示 key
  const byPond = {}, byFeed = {};
  let total = 0;
  for (const r of recs) {
    const b = Number(r.bags) || 0; total += b;
    const pondNm = pondName(r.pondId);
    byPond[pondNm] = (byPond[pondNm] || 0) + b;
    const feedNm = feedName(r.feedNoId) || "(未填)";
    byFeed[feedNm] = (byFeed[feedNm] || 0) + b;
  }
  const summary = [];
  summary.push({ A: "各池塘總包數", B: "" });
  Object.entries(byPond).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => summary.push({ A: k, B: v }));
  summary.push({ A: "合計", B: total });
  summary.push({ A: "", B: "" });
  summary.push({ A: "各飼料編號包數", B: "" });
  Object.entries(byFeed).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => summary.push({ A: k, B: v }));
  summary.push({ A: "合計", B: total });

  // 各池塘飼料明細:每池列出各飼料包數 + 小計(與統計頁的明細卡同源)。
  // 獨立成「各池塘明細」工作表/分頁,不再塞進「統計」表(見 pondFeedSheet)。
  // key 用 pondId;label 用 pondLabel(含群組,如「民雄(南區)」),與統計頁卡片一致。
  const pondFeed = {};   // { pondId: { label, total, feeds:{飼料名:包數} } }
  for (const r of recs) {
    const b = Number(r.bags) || 0;
    const feedNm = feedName(r.feedNoId) || "(未填)";
    const e = (pondFeed[r.pondId] ||= { label: pondLabel(r.pondId), total: 0, feeds: {} });
    e.total += b;
    e.feeds[feedNm] = (e.feeds[feedNm] || 0) + b;
  }
  // Excel 用:每池一區塊(池名(群組)標題→各飼料逐行→小計),區塊間空一行,模擬卡片堆疊。
  const pondFeedSheet = [];
  Object.values(pondFeed).sort((a, b) => b.total - a.total).forEach((info, idx) => {
    if (idx > 0) pondFeedSheet.push({ A: "", B: "" });   // 區塊間空行
    pondFeedSheet.push({ A: info.label, B: "" });         // 池名(群組)(區塊標題)
    Object.entries(info.feeds).sort((a, b) => b[1] - a[1])
      .forEach(([f, v]) => pondFeedSheet.push({ A: `　${f}`, B: v }));   // 全形空格縮排
    pondFeedSheet.push({ A: "　小計", B: info.total });
  });
  if (!pondFeedSheet.length) pondFeedSheet.push({ A: "(無資料)", B: "" });

  // 工作表 3:分類統計(以標籤為視角;一筆記錄計入其池塘的每個標籤)
  const byTag = {};
  for (const r of recs) {
    const b = Number(r.bags) || 0;
    const tags = (options.pondTags || {})[r.pondId] || [];
    for (const t of tags) { byTag[t] = (byTag[t] || 0) + b; }
  }
  const tagSummary = [];
  // 依設定的標籤順序排列
  (options.tags || []).forEach((t) => { if (byTag[t] != null) tagSummary.push({ A: t, B: byTag[t] }); });
  if (!tagSummary.length) tagSummary.push({ A: "(尚無群組資料)", B: "" });

  // 月分總覽(區間匯出才有)
  let monthRows = null;
  if (byMonth) {
    const m = {};   // { 'YYYY-MM': { total, count } }
    for (const r of recs) {
      const ym = (r.date || "").slice(0, 7);
      if (!ym) continue;
      const e = (m[ym] ||= { total: 0, count: 0 });
      e.total += Number(r.bags) || 0;
      e.count += 1;
    }
    monthRows = Object.keys(m).sort().map((ym) => ({
      "月份": ym, "總包數": m[ym].total, "筆數": m[ym].count
    }));
    monthRows.push({ "月份": "合計", "總包數": total, "筆數": recs.length });
  }

  return { detail, summary, tagSummary, monthRows, pondFeed, pondFeedSheet };
}

// 各池塘飼料明細的卡片 HTML(與統計頁的明細卡同款樣式 .pf-card)。
// pondFeed:{ pondId: { label, total, feeds:{飼料名:包數} } }。label 含群組。供匯出預覽用。
function pondFeedCardsHtml(pondFeed) {
  const entries = Object.values(pondFeed || {}).sort((a, b) => b.total - a.total);
  if (!entries.length) return '<p class="hint">(無資料)</p>';
  const cards = entries.map((info) => {
    const feedLines = Object.entries(info.feeds).sort((a, b) => b[1] - a[1])
      .map(([f, v]) => `<div class="pf-feed"><span>${escapeHtml(f)}</span><span class="num">${fmt(v)}包</span></div>`).join("");
    return `
      <div class="pf-card">
        <div class="pf-pond">${escapeHtml(info.label)}</div>
        ${feedLines}
        <div class="pf-total"><span>總共</span><span class="num">${fmt(info.total)}包</span></div>
      </div>`;
  }).join("");
  return `<div class="pf-cards">${cards}</div>`;
}

// 通用匯出:records=要匯的紀錄,label=檔名標籤,byMonth=是否附「月分總覽」表
function exportToExcel(records, label, { byMonth = false } = {}) {
  if (typeof XLSX === "undefined") { showToast("Excel 函式庫尚未載入,請檢查網路後重試", true); return; }
  const data = buildExportData(records, { byMonth });
  if (!data) { showToast("這個範圍沒有資料可匯出", true); return; }
  const { detail, summary, tagSummary, monthRows, pondFeedSheet } = data;

  const wb = XLSX.utils.book_new();
  const wsDetail = XLSX.utils.json_to_sheet(detail);
  wsDetail["!cols"] = [{ wch: 12 }, { wch: 6 }, { wch: 12 }, { wch: 14 }, { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, wsDetail, "明細");

  const wsSum = XLSX.utils.json_to_sheet(summary, { skipHeader: true });
  wsSum["!cols"] = [{ wch: 18 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsSum, "統計");

  // 各池塘明細:每池一區塊、空行隔開(卡片式堆疊)
  const wsPondFeed = XLSX.utils.json_to_sheet(pondFeedSheet, { skipHeader: true });
  wsPondFeed["!cols"] = [{ wch: 18 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsPondFeed, "各池塘明細");

  const wsTag = XLSX.utils.json_to_sheet(tagSummary, { skipHeader: true });
  wsTag["!cols"] = [{ wch: 18 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsTag, "群組統計");

  if (monthRows) {
    const wsMonth = XLSX.utils.json_to_sheet(monthRows);
    wsMonth["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 8 }];
    XLSX.utils.book_append_sheet(wb, wsMonth, "月分總覽");
  }

  XLSX.writeFile(wb, `魚塭紀錄_${label}.xlsx`);
}

// ============================================================
//  匯出 PDF (html2pdf.js:html2canvas 轉圖 + jsPDF 出檔)
//  內容=統計頁的八張卡(與畫面同一份 buildStatsCardsHtml),
//  走轉圖路線是為了中文與 CSS 圖表不需另外嵌字型/重畫。
// ============================================================
async function exportToPdf(records, label, months = []) {
  if (typeof html2pdf === "undefined") { showToast("PDF 函式庫尚未載入,請檢查網路後重試", true); return; }
  if (!records.length) { showToast("這個範圍沒有資料可匯出", true); return; }

  // 報表容器:固定 A4 寬、強制淺色(樣式見 style.css 的 .pdf-root)。
  // offscreen 定位放外層 wrapper:html2pdf 只複製 host 子樹,
  // 若定位寫在 host 上會一起被複製進擷取視窗,產出整份空白。
  const host = document.createElement("div");
  host.className = "pdf-root";
  host.innerHTML = `
    <div class="pdf-head">
      <div class="pdf-title">魚塭紀錄統計</div>
      <div class="pdf-sub">${escapeHtml(label.replaceAll("_", "　"))}・共 ${records.length} 筆</div>
    </div>
    ${buildStatsCardsHtml(records, months, { pdf: true })}`;
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:absolute;left:-10000px;top:0;width:733px;";
  wrapper.appendChild(host);
  document.body.appendChild(wrapper);

  showToast("正在產生 PDF…");
  try {
    await html2pdf().set({
      margin: [10, 8, 12, 8],
      filename: `魚塭紀錄_${label}.pdf`,
      image: { type: "jpeg", quality: 0.95 },
      html2canvas: { scale: 2, backgroundColor: "#ffffff" },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"] },
    }).from(host).save();
    showToast("PDF 已下載");
  } catch (err) {
    console.error("exportToPdf failed", err);
    showToast("PDF 產生失敗,請重試", true);
  } finally {
    wrapper.remove();
  }
}

// 預覽:用與匯出相同的資料,在網頁 modal 以表格呈現(不下載)。
function previewExport(records, label, { byMonth = false } = {}) {
  const data = buildExportData(records, { byMonth });
  if (!data) { showToast("這個範圍沒有資料可預覽", true); return; }
  openExportPreview(data, records, label, { byMonth });
}

// 把一組 rows(物件陣列)轉成 HTML 表格。
// headerKeys=null 時用第一筆的 key 當表頭;否則視為無表頭(統計表那種 A/B 兩欄)。
function rowsToTable(rows, { headerless = false, rowClass = null } = {}) {
  if (!rows || !rows.length) return '<p class="hint">(無資料)</p>';
  const cols = Object.keys(rows[0]);
  const head = headerless ? "" :
    `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
  const body = rows.map((r) => {
    const cls = rowClass ? rowClass(r) : "";
    const tr = cls ? `<tr class="${cls}">` : "<tr>";
    return `${tr}${cols.map((c) => `<td>${escapeHtml(String(r[c] ?? ""))}</td>`).join("")}</tr>`;
  }).join("");
  return `<table class="preview-table">${head}<tbody>${body}</tbody></table>`;
}

// 統計表的列分類:分類標題(只有 A 有值、B 空) / 合計 / 一般
function summaryRowClass(r) {
  if (r.A === "合計") return "row-total";
  if (typeof r.A === "string" && r.A.endsWith(" 小計")) return "row-total";   // 各池塘飼料明細的每池小計
  if (r.A === "" && r.B === "") return "row-spacer";
  if (r.B === "" || r.B == null) return "row-section";   // 分類標題列
  return "";
}

// 明細篩選欄位定義:key=畫面群組名;getVals(r)=該筆記錄在此欄位的值(可多個,用於群組)
const PREVIEW_FILTERS = [
  { key: "feedNo",       label: "料號", getVals: (r) => [feedName(r.feedNoId)] },
  { key: "mix",          label: "拌料", getVals: (r) => [mixName(r.mixId)] },
  { key: "disinfectant", label: "消毒劑", getVals: (r) => [disinfectantName(r.disinfectantId)] },
  { key: "tag",          label: "群組", getVals: (r) => ((options.pondTags || {})[r.pondId] || []) },
  { key: "pond",         label: "池塘", getVals: (r) => [pondName(r.pondId)] },
  { key: "period",       label: "時段", getVals: (r) => [periodLabel(r.period)] },
];

// 依目前勾選的條件(sel: {key: Set(選中的值)})過濾原始紀錄。空集合=該欄位不限。
function applyPreviewFilters(records, sel) {
  return records.filter((r) =>
    PREVIEW_FILTERS.every((f) => {
      const chosen = sel[f.key];
      if (!chosen || chosen.size === 0) return true;          // 此欄位未篩選
      return f.getVals(r).some((v) => chosen.has(v));         // 任一值命中
    })
  );
}

// 開啟匯出預覽 modal,分頁顯示各工作表;可篩選明細並分別下載。
function openExportPreview(data, records, label, { byMonth = false } = {}) {
  const overlay = $("#previewOverlay");
  const tabsEl = $("#previewTabs");
  const bodyEl = $("#previewBody");
  const filtersEl = $("#previewFilters");

  // 每欄位收集出現過的值(空字串排除),供篩選下拉用
  const fieldValues = {};
  for (const f of PREVIEW_FILTERS) {
    const set = new Set();
    for (const r of records) for (const v of f.getVals(r)) if (v) set.add(v);
    fieldValues[f.key] = Array.from(set);
  }
  const sel = {};                       // { key: Set(選中值) }
  PREVIEW_FILTERS.forEach((f) => (sel[f.key] = new Set()));

  let activeSheet = 0;

  // 其他分頁固定用全部資料(只重算一次)
  const staticSheets = {
    "統計": rowsToTable(data.summary, { headerless: true, rowClass: summaryRowClass }),
    "各池塘明細": pondFeedCardsHtml(data.pondFeed),   // 卡片樣式,與統計頁同款
    "群組統計": rowsToTable(data.tagSummary, { headerless: true, rowClass: summaryRowClass }),
    "月分總覽": data.monthRows
      ? rowsToTable(data.monthRows, { rowClass: (r) => (r["月份"] === "合計" ? "row-total" : "") })
      : null,
  };
  const sheetNames = ["明細", "統計", "各池塘明細", "群組統計"].concat(data.monthRows ? ["月分總覽"] : []);

  // 取得篩選後的紀錄與明細表 HTML
  const filteredRecords = () => applyPreviewFilters(records, sel);
  const detailHtml = () => {
    const recs = filteredRecords();
    const d = buildExportData(recs, { byMonth });
    return d ? rowsToTable(d.detail) : '<p class="hint">(無符合篩選的資料)</p>';
  };

  const renderBody = () => {
    const name = sheetNames[activeSheet];
    const isDetail = name === "明細";
    bodyEl.innerHTML = isDetail ? detailHtml() : staticSheets[name];
    // 篩選器與「篩選結果」下載鈕只在明細分頁出現(篩選只影響明細)
    filtersEl.hidden = !isDetail;
    $("#previewDownloadFiltered").hidden = !isDetail;
    $("#previewPdfFiltered").hidden = !isDetail;
  };

  // 分頁
  tabsEl.innerHTML = sheetNames.map((n, i) =>
    `<button type="button" class="preview-tab ${i === 0 ? "active" : ""}" data-sheet="${i}">${escapeHtml(n)}</button>`
  ).join("");
  tabsEl.querySelectorAll(".preview-tab").forEach((b) =>
    b.addEventListener("click", () => {
      activeSheet = Number(b.dataset.sheet);
      tabsEl.querySelectorAll(".preview-tab").forEach((x, j) => x.classList.toggle("active", j === activeSheet));
      renderBody();
    }));

  // 篩選器:每欄位一組(可勾選的小籌碼);無值的欄位不顯示
  filtersEl.innerHTML = PREVIEW_FILTERS.filter((f) => fieldValues[f.key].length).map((f) => `
    <div class="pf-group" data-field="${f.key}">
      <span class="pf-label">${escapeHtml(f.label)}</span>
      <div class="pf-opts">
        ${fieldValues[f.key].map((v) =>
          `<button type="button" class="pf-opt" data-field="${f.key}" data-val="${escapeHtml(v)}">${escapeHtml(v)}</button>`
        ).join("")}
      </div>
    </div>`).join("");
  filtersEl.querySelectorAll(".pf-opt").forEach((b) =>
    b.addEventListener("click", () => {
      const set = sel[b.dataset.field];
      const v = b.dataset.val;
      if (set.has(v)) set.delete(v); else set.add(v);
      b.classList.toggle("on");
      if (activeSheet === 0) renderBody();   // 明細即時更新
    }));

  $("#previewTitle").textContent = `預覽:${label}`;
  renderBody();

  const close = () => {
    overlay.hidden = true;
    overlay.removeEventListener("click", onBackdrop);
    document.removeEventListener("keydown", onKey);
    $("#previewClose").removeEventListener("click", close);
    $("#previewDownloadAll").removeEventListener("click", onDownloadAll);
    $("#previewDownloadFiltered").removeEventListener("click", onDownloadFiltered);
    $("#previewPdfAll").removeEventListener("click", onPdfAll);
    $("#previewPdfFiltered").removeEventListener("click", onPdfFiltered);
  };
  const onBackdrop = (e) => { if (e.target === overlay) close(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  // 下載走完整的匯出路徑(Excel=SheetJS / PDF=html2pdf),與直接匯出一致;
  // 「篩選結果」用當下勾選條件過濾後的紀錄重算整份內容
  const onDownloadAll = () => { exportToExcel(records, label, { byMonth }); };
  const onDownloadFiltered = () => { exportToExcel(filteredRecords(), `${label}_篩選`, { byMonth }); };
  const onPdfAll = () => { exportToPdf(records, label, monthsOf(records)); };
  const onPdfFiltered = () => { const recs = filteredRecords(); exportToPdf(recs, `${label}_篩選`, monthsOf(recs)); };

  overlay.addEventListener("click", onBackdrop);
  document.addEventListener("keydown", onKey);
  $("#previewClose").addEventListener("click", close);
  $("#previewDownloadAll").addEventListener("click", onDownloadAll);
  $("#previewDownloadFiltered").addEventListener("click", onDownloadFiltered);
  $("#previewPdfAll").addEventListener("click", onPdfAll);
  $("#previewPdfFiltered").addEventListener("click", onPdfFiltered);
  overlay.hidden = false;
}

// ============================================================
//  設定頁(編輯四組固定選項)
// ============================================================
// 各組的區塊標題(預設用 OPTION_LABELS;tags 另給「管理群組」以和「池塘群組」區分)
const GROUP_HEADINGS = { tags: "管理群組" };

// 渲染單一組選項(chip 清單 + 新增列)
function renderOptionGroup(key) {
  const items = options[key] || [];
  const heading = GROUP_HEADINGS[key] || OPTION_LABELS[key];
  const chips = items.map((it, i) => `
    <span class="chip" data-key="${key}" data-idx="${i}">
      <span class="chip-grip" title="拖曳排序">⠿</span>
      <span class="chip-label">${escapeHtml(optName(it))}</span>
      <button class="chip-del" title="刪除" data-rmkey="${key}" data-rmidx="${i}">×</button>
    </span>`).join("") || '<span class="hint">尚無選項</span>';
  const hint = items.length ? ' <span class="reorder-hint">點字編輯・拖曳排序・✕ 刪除</span>' : "";
  return `
    <details class="card opt-group" open>
      <summary>${heading}(${items.length})${hint}</summary>
      <div class="chip-list" data-list="${key}">${chips}</div>
      <div class="add-row">
        <input type="text" placeholder="新增${OPTION_LABELS[key]}…" data-addkey="${key}" />
        <button class="btn-primary btn-sm" data-addbtn="${key}">新增</button>
      </div>
    </details>`;
}

function renderSettings() {
  const c = $("#settingsContainer");
  // 順序:池塘分類 → 分類標籤 → 其餘四組(分類相關放最上方)
  const restKeys = Object.keys(OPTION_LABELS).filter((k) => k !== "tags");
  c.innerHTML =
    renderPondTagsSection() +
    renderOptionGroup("tags") +
    restKeys.map(renderOptionGroup).join("");

  c.querySelectorAll("[data-rmkey]").forEach((b) =>
    b.addEventListener("click", () => removeOption(b.dataset.rmkey, Number(b.dataset.rmidx))));
  c.querySelectorAll("[data-list]").forEach((listEl) => setupChipDrag(listEl));
  c.querySelectorAll("[data-addbtn]").forEach((b) =>
    b.addEventListener("click", async () => {
      const key = b.dataset.addbtn;
      const input = c.querySelector(`[data-addkey="${key}"]`);
      const val = input.value.trim();
      // 成功才清空;撞名等失敗保留輸入,讓使用者改一下就好
      if (val && await addOption(key, val)) input.value = "";
    }));
  // Enter 也能新增
  c.querySelectorAll("[data-addkey]").forEach((inp) =>
    inp.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") { e.preventDefault();
        const val = inp.value.trim();
        if (val && await addOption(inp.dataset.addkey, val)) inp.value = "";
      }
    }));

  // 池塘分類:點標籤 chip 切換該池歸屬
  c.querySelectorAll("[data-tagpond]").forEach((b) =>
    b.addEventListener("click", () => togglePondTag(b.dataset.tagpond, b.dataset.tagname)));
}

// 池塘分類區:每池一列,列出所有標籤,亮起=該池已貼
function renderPondTagsSection() {
  const ponds = options.ponds || [];
  const tags = options.tags || [];
  let inner;
  if (!ponds.length) {
    inner = '<p class="hint">尚無池塘。請先到下方「池塘名稱」新增,或記錄時輸入。</p>';
  } else if (!tags.length) {
    inner = '<p class="hint">尚無群組。請先到下方「群組」新增(如:第一區、鱸魚)。</p>';
  } else {
    const pondTags = options.pondTags || {};
    inner = ponds.map((p) => {
      const mine = new Set(pondTags[p.id] || []);
      const chips = tags.map((t) => `
        <button class="tag-pick ${mine.has(t) ? "on" : ""}" data-tagpond="${escapeHtml(p.id)}" data-tagname="${escapeHtml(t)}">${escapeHtml(t)}</button>
      `).join("");
      return `
        <div class="pondtag-row">
          <div class="pondtag-name">${escapeHtml(p.name)}</div>
          <div class="pondtag-chips">${chips}</div>
        </div>`;
    }).join("");
  }
  return `
    <details class="card opt-group" open>
      <summary>池塘群組 <span class="reorder-hint">點群組切換歸屬</span></summary>
      ${inner}
    </details>`;
}

// 切換某池對某標籤的歸屬。pondId=池塘 id(pondTags 以 id 為 key)
async function togglePondTag(pondId, tag) {
  if (!db) return false;
  const pondTags = { ...(options.pondTags || {}) };
  const list = new Set(pondTags[pondId] || []);
  if (list.has(tag)) list.delete(tag); else list.add(tag);
  // 依 tags 的順序保存,維持一致
  pondTags[pondId] = (options.tags || []).filter((t) => list.has(t));
  const res = await busyWrite("儲存中…", () => updateDoc(doc(db, ...DB_ROOT, "settings", "options"), { pondTags }), { fail: "池塘群組沒有存到" });
  if (res === "ok") showToast(`✔ 已${list.has(tag) ? "加入" : "移出"}「${tag}」`);
  return !!res;
}

// 新增選項。四組帶 id 的選項存 {id,name};tags 維持純字串。
// presetId:給 onSaveRecord 手打新池塘時用(先在本地產 id,確保紀錄能立刻指到)。
// 回傳 true=已新增、false=未新增(撞名或被擋),讓呼叫端決定要不要清空輸入框。
async function addOption(key, value, presetId) {
  if (!db) return false;
  const list = options[key] || [];
  const isIdKey = ID_KEYS.includes(key);
  // 不重複(比名稱);撞名時提示使用者(presetId 來自 onSaveRecord 自動建池塘,不需提示)
  if (list.some((it) => optName(it) === value)) {
    if (!presetId) showToast(`「${value}」已存在`, true);
    return false;
  }
  const item = isIdKey ? { id: presetId || uid(), name: value } : value;
  const next = [...list, item];
  const write = () => updateDoc(doc(db, ...DB_ROOT, "settings", "options"), { [key]: next });
  // 新增紀錄時手打的新池塘(presetId):跟著紀錄一起走,不另外轉圈
  if (presetId) { await write(); return true; }
  const res = await busyWrite("儲存中…", write, { fail: `「${value}」沒有新增` });
  if (res === "ok") showToast(`✔ 已新增「${value}」`);
  return !!res;
}

// 把選項從 from 位置移到 to 位置,寫回 Firestore
async function reorderOption(key, from, to) {
  if (!db) return;
  const list = (options[key] || []).slice();
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  const res = await busyWrite("儲存中…", () => updateDoc(doc(db, ...DB_ROOT, "settings", "options"), { [key]: list }), { fail: "順序沒有存到" });
  if (res === "ok") showToast(`已調整順序:「${optName(moved)}」`);
  if (!res) renderSettings();   // 失敗:拖過去的位置還原
}

// 重新命名選項:單點 chip 觸發。
// 帶 id 的選項只改 name(id 不變,既有紀錄與 pondTags 自動跟著);tags 改名需連帶更新 pondTags 內的引用。
async function renameOption(key, idx) {
  if (!db) return;
  const list = (options[key] || []).slice();
  const item = list[idx];
  if (item == null) return;
  const isIdKey = ID_KEYS.includes(key);
  const old = optName(item);

  // 撞名在 modal 內就擋下(不關閉、保留輸入,讓使用者改);空白/沒改則放行後面判斷
  const next = await showPrompt(`編輯「${OPTION_LABELS[key]}」`, old, {
    validate: (v) => (v && v !== old && list.some((it) => optName(it) === v)) ? `「${v}」已存在` : "",
  });
  if (next == null) return;                 // 取消
  if (next === "" || next === old) return;  // 空白或沒改,不動作

  list[idx] = isIdKey ? { ...item, name: next } : next;
  const patch = { [key]: list };

  // tags(群組)改名:pondTags 內存的是標籤「名稱」,要一起改;
  // 帶 id 的選項(含池塘)改名不必動 pondTags —— pondTags 用 id 關聯,id 沒變。
  if (key === "tags") {
    const pondTags = {};
    for (const [p, ts] of Object.entries(options.pondTags || {})) {
      pondTags[p] = (ts || []).map((t) => (t === old ? next : t));
    }
    patch.pondTags = pondTags;
  }

  const res = await busyWrite("儲存中…", () => updateDoc(doc(db, ...DB_ROOT, "settings", "options"), patch), { fail: `「${old}」沒有改名` });
  if (res === "ok") showToast(`已改名:「${old}」→「${next}」`);
}

// ---------- chip 拖曳排序(Pointer Events,手機 / 桌面通用)----------
// 做法:被拖的 chip 改為 fixed 浮層、即時跟隨游標;原位留一個等高的佔位框;
// 其他 chip 依游標位置即時讓位(insertBefore 佔位框)。放開才寫回 Firestore。
function setupChipDrag(listEl) {
  const key = listEl.dataset.list;
  const THRESHOLD = 6;        // 移動超過幾 px 才算拖曳(否則視為單純點擊)
  let pending = null;         // 已按下、尚未確定是否拖曳的 chip
  let dragging = false;       // 是否已進入拖曳模式
  let dragEl = null;          // 被拖的 chip(浮層)
  let placeholder = null;     // 佔位框
  let startIdx = -1;
  let pointerId = null;
  let startX = 0, startY = 0; // 按下時的座標
  let offX = 0, offY = 0;     // 游標相對 chip 左上角的偏移
  let w = 0, h = 0;

  const onDown = (e) => {
    // 整個 chip 都可發起拖曳,但排除刪除鈕(× 仍是點擊刪除)
    if (e.target.closest(".chip-del")) return;
    const chip = e.target.closest(".chip");
    if (!chip || chip.parentElement !== listEl) return;
    pending = chip;
    dragging = false;
    pointerId = e.pointerId;
    startIdx = Number(chip.dataset.idx);
    startX = e.clientX; startY = e.clientY;

    const rect = chip.getBoundingClientRect();
    w = rect.width; h = rect.height;
    offX = e.clientX - rect.left;
    offY = e.clientY - rect.top;

    listEl.setPointerCapture(pointerId);
    listEl.addEventListener("pointermove", onMove);
    listEl.addEventListener("pointerup", onUp);
    listEl.addEventListener("pointercancel", onUp);
  };

  // 真正進入拖曳:生成佔位框 + 把 chip 變浮層
  const beginDrag = (x, y) => {
    dragging = true;
    dragEl = pending;

    placeholder = document.createElement("span");
    placeholder.className = "chip-placeholder";
    placeholder.style.width = w + "px";
    placeholder.style.height = h + "px";
    listEl.insertBefore(placeholder, dragEl);

    dragEl.classList.add("dragging");
    dragEl.style.width = w + "px";
    dragEl.style.height = h + "px";
    moveTo(x, y);
  };

  const moveTo = (x, y) => {
    dragEl.style.left = (x - offX) + "px";
    dragEl.style.top = (y - offY) + "px";
  };

  const onMove = (e) => {
    if (!pending) return;
    // 還沒進入拖曳:先看是否超過門檻
    if (!dragging) {
      if (Math.abs(e.clientX - startX) < THRESHOLD && Math.abs(e.clientY - startY) < THRESHOLD) return;
      beginDrag(e.clientX, e.clientY);
    }
    e.preventDefault();
    moveTo(e.clientX, e.clientY);
    // 找游標下方、同列表內、非浮層的 chip,決定佔位框插在它前或後
    const others = Array.from(listEl.querySelectorAll(".chip:not(.dragging)"));
    let target = null;
    for (const c of others) {
      const r = c.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        target = { el: c, after: e.clientX > r.left + r.width / 2 };
        break;
      }
    }
    if (target) {
      listEl.insertBefore(placeholder, target.after ? target.el.nextSibling : target.el);
    }
  };

  const onUp = () => {
    listEl.removeEventListener("pointermove", onMove);
    listEl.removeEventListener("pointerup", onUp);
    listEl.removeEventListener("pointercancel", onUp);
    if (pointerId != null && listEl.hasPointerCapture?.(pointerId)) listEl.releasePointerCapture(pointerId);

    if (!dragging) {                             // 沒超過門檻 = 單純點擊 → 編輯該項
      const idx = startIdx;
      pending = null;
      if (idx >= 0) renameOption(key, idx);
      return;
    }

    // 新位置 = 佔位框在「所有 chip + 佔位框」序列中的索引
    const seq = Array.from(listEl.children).filter(
      (n) => n.classList.contains("chip") || n === placeholder
    );
    const newIdx = seq.indexOf(placeholder);

    dragEl.classList.remove("dragging");
    dragEl.removeAttribute("style");
    placeholder.remove();
    dragEl = null; placeholder = null; pending = null; dragging = false;

    if (newIdx !== -1 && newIdx !== startIdx) {
      reorderOption(key, startIdx, newIdx);    // 寫回 Firestore(成功 toast);onSnapshot 重渲染
    } else {
      renderSettings();                        // 沒移動也重渲染,還原索引
    }
  };

  listEl.addEventListener("pointerdown", onDown);
}

// 各帶 id 選項對應到紀錄的哪個欄位(用來檢查是否仍被引用)
const KEY_TO_REC_FIELD = { ponds: "pondId", feedNos: "feedNoId", mixes: "mixId", disinfectants: "disinfectantId" };

async function removeOption(key, idx) {
  if (!db) return;
  const list = (options[key] || []).slice();
  const item = list[idx];
  if (item == null) return;
  const name = optName(item);
  const isIdKey = ID_KEYS.includes(key);

  // 帶 id 的選項:若仍有紀錄引用,擋下不刪(避免孤兒)
  if (isIdKey) {
    const field = KEY_TO_REC_FIELD[key];
    const used = allRecords.filter((r) => r[field] === item.id).length;
    if (used > 0) {
      showToast(`「${name}」還有 ${used} 筆紀錄在使用,無法刪除`, true);
      return;
    }
  }

  // 群組(tags):若有池塘貼著它,刪除會一併移除歸屬,先提示池數讓使用者確認
  let confirmMsg = `確定刪除「${name}」?`;
  if (key === "tags") {
    const usedPonds = Object.values(options.pondTags || {}).filter((ts) => (ts || []).includes(name)).length;
    if (usedPonds > 0) confirmMsg = `「${name}」目前有 ${usedPonds} 個池塘在使用。\n刪除會一併移除這些池塘的此群組歸屬,確定刪除?`;
  }

  const ok = await showConfirm(
    confirmMsg,
    { okText: "刪除", danger: true }
  );
  if (!ok) return;
  list.splice(idx, 1);
  const patch = { [key]: list };

  // 連帶清理 pondTags,避免殘留孤兒引用
  if (key === "tags") {
    // 刪標籤:從每池移除該標籤
    const pondTags = {};
    for (const [p, ts] of Object.entries(options.pondTags || {})) {
      pondTags[p] = (ts || []).filter((t) => t !== name);
    }
    patch.pondTags = pondTags;
  } else if (key === "ponds") {
    // 刪池塘(已確認無紀錄引用):移除該池 id 的分類項
    const pondTags = { ...(options.pondTags || {}) };
    delete pondTags[item.id];
    patch.pondTags = pondTags;
    // 綁在這個池塘的板子一併解除綁定
    const nodePonds = Object.fromEntries(Object.entries(options.nodePonds || {}).filter(([, pid]) => pid !== item.id));
    patch.nodePonds = nodePonds;
  }

  const res = await busyWrite("刪除中…", () => updateDoc(doc(db, ...DB_ROOT, "settings", "options"), patch), { fail: `「${name}」沒有刪掉` });
  if (res === "ok") showToast(`✔ 已刪除「${name}」`);
}

// ============================================================
//  分頁切換
// ============================================================
function switchPage(name) {
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.page === name));
  const onRecord = name === "record";
  $("#saveBar").hidden = !onRecord;            // 儲存列只在記錄頁顯示
  document.body.classList.toggle("on-record", onRecord);  // 控制底部留白
  document.body.classList.toggle("on-stats", name === "stats");  // 統計頁全寬
  document.body.classList.toggle("on-nodes", name === "nodes");  // 板子頁全寬(板子多時一排放得下更多)
  document.body.classList.toggle("on-settings", name === "settings");  // 設定頁全寬(寬螢幕分欄)
  // 進板子頁:先畫現有資料(不留白畫面),同時重抓一次即時狀態與溫度曲線
  if (name === "nodes") {
    renderNodesPage();
    refreshNodeStatus();
    loadNodeHistory().then(renderNodesPage);
  }
  window.scrollTo({ top: 0 });
}
function setupTabs() {
  $$(".tab").forEach((t) => t.addEventListener("click", () => switchPage(t.dataset.page)));
}

// ============================================================
//  啟動
// ============================================================
// header 顯示建置時間(月/日/時),確認線上非 cache。格式來源:BUILD_TIME = "YYYY-MM-DD HH:mm"
function renderBuildStamp() {
  const el = $("#buildStamp");
  if (!el) return;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2})/.exec(BUILD_TIME);
  el.textContent = m ? `${Number(m[2])}/${Number(m[3])} ${m[4]}時` : BUILD_TIME;
  el.title = `此版本建置:${BUILD_TIME}(用來確認非 cache)`;
}

function main() {
  renderBuildStamp();
  setupTheme();
  setupTabs();
  setupNodesPage();
  setupNodeChartHover();
  setupAlertControl();
  setupRecordForm();
  setupList();
  setupStats();
  switchPage("record");            // 設定初始分頁狀態(含儲存列顯示、底部留白)
  // 先以預設選項渲染一次(離線/未連線也有畫面)
  renderOptionSelects();
  renderSettings();

  initFirebase();
  startData();

  // ESP32 心跳:立刻抓一次,之後前景每分鐘更新(與 Firestore 無關)
  refreshNodeStatus();
  ensureNodeTimer();

  // 溫度機會式補:App 回到前景 / 視窗取得焦點時,補仍 pending 的紀錄。
  // 回前景時順手啟動前景定時器(離開前景則停掉,避免背景空轉)。
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { retryPendingSiteTemp(); refreshNodeStatus(); }
    ensureSiteTempTimer();
    ensureNodeTimer();
  });
  window.addEventListener("focus", retryPendingSiteTemp);

  // 註冊 service worker(PWA)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
}

main();
