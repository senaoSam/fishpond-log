// ============================================================
//  魚塭紀錄 — 主程式
// ============================================================
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDoc, onSnapshot, query, orderBy, serverTimestamp,
  enableIndexedDbPersistence
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
  pondTags: {}               // { 池塘id: [標籤...] } — 每池貼哪些標籤
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
let allRecords = [];        // 由 Firestore 即時同步的全部紀錄(含 id)
let options = { ...DEFAULT_OPTIONS };
let editingId = null;       // 目前正在編輯的紀錄 id(null = 新增模式)
let currentPeriod = "morning";

// ---------- 假資料模式 ----------
const DEMO_KEY = "yutun-demo-mode";          // localStorage:'1' = 假資料模式
let demoMode = false;
let unsubscribers = [];                       // Firestore 訂閱取消函式(切換時要解除)

// 產生一組示範資料(純前端,不碰 Firestore)。城市=群組,池子各屬其城市,魚種隨機。
function buildDemoData() {
  const cities = {
    "高雄": ["左營", "楠梓", "岡山"],
    "台南": ["永康", "安平", "新營"],
    "嘉義": ["太保", "朴子", "民雄"]
  };
  const fishTags = ["鱸魚", "鮪魚", "吳郭魚", "鮭魚"];
  // 帶 id 的選項(假資料用固定 id,方便重現)
  const feedNos = DEFAULT_OPTIONS.feedNos.map((it, i) => ({ id: `demo-feed-${i}`, name: it.name }));
  const mixes = DEFAULT_OPTIONS.mixes.map((it, i) => ({ id: `demo-mix-${i}`, name: it.name }));
  const disinfectants = DEFAULT_OPTIONS.disinfectants.map((it, i) => ({ id: `demo-dis-${i}`, name: it.name }));

  // 用固定種子的偽隨機,讓每次產生的假資料一致(可重現)
  let seed = 20260501;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  const ponds = [];          // [{id, name}]
  const pondTags = {};       // { 池塘id: [標籤...] }
  let pn = 0;
  for (const [city, areas] of Object.entries(cities)) {
    for (const area of areas) {
      const id = `demo-pond-${pn++}`;
      ponds.push({ id, name: area });
      pondTags[id] = [city, pick(fishTags)];   // 自己城市 + 隨機魚種
    }
  }

  const demoOptions = {
    ponds,
    feedNos,
    mixes,
    disinfectants,
    tags: ["高雄", "台南", "嘉義", ...fishTags],
    pondTags
  };

  // 5、6 兩個月,每個池子每月隨機記幾筆
  const records = [];
  let idn = 1;
  const z = (n) => String(n).padStart(2, "0");
  for (const month of [5, 6]) {
    const daysInMonth = month === 5 ? 31 : 30;
    for (const pond of ponds) {
      const count = 3 + Math.floor(rnd() * 4);   // 每池每月 3~6 筆
      for (let k = 0; k < count; k++) {
        const day = 1 + Math.floor(rnd() * daysInMonth);
        records.push({
          id: `demo-${idn++}`,
          pondId: pond.id,
          date: `2026-${z(month)}-${z(day)}`,
          period: rnd() < 0.5 ? "morning" : "afternoon",
          bags: Math.round(1 + rnd() * 5),   // 1~6 整數
          feedNoId: pick(feedNos).id,
          mixId: rnd() < 0.5 ? pick(mixes).id : "",
          disinfectantId: rnd() < 0.4 ? pick(disinfectants).id : "",
          note: ""
        });
      }
    }
  }
  // 依日期新→舊排序(與真實訂閱一致)
  records.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { demoOptions, records };
}

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
function showConfirm(message, { okText = "確定", danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = $("#modalOverlay");
    const okBtn = $("#modalOk");
    const cancelBtn = $("#modalCancel");
    $("#modalText").textContent = message;
    okBtn.textContent = okText;
    okBtn.classList.toggle("btn-danger", danger);

    const close = (result) => {
      overlay.hidden = true;
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
function showToast(message, isErr = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast" + (isErr ? " err" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ============================================================
//  Firebase 初始化
// ============================================================
function initFirebase() {
  if (firebaseConfig.apiKey.startsWith("請填入")) {
    setSync("err", "未設定 Firebase");
    showConfigHint();
    return false;
  }
  try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    // 啟用離線快取(失敗不影響主功能,例如多分頁開啟時)
    enableIndexedDbPersistence(db).catch(() => {});
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
  const optRef = doc(db, "settings", "options");
  unsubscribers.push(onSnapshot(optRef, async (snap) => {
    if (!snap.exists()) {
      // 首次:寫入預設值
      await setDoc(optRef, DEFAULT_OPTIONS);
      options = { ...DEFAULT_OPTIONS };
    } else {
      const data = snap.data();
      // 補齊可能缺少的 key
      options = { ...DEFAULT_OPTIONS, ...data };
    }
    renderOptionSelects();
    renderSettings();
    renderPondFilter();
    renderRecordTags();
  }, (err) => { console.error(err); setSync("err", "讀取設定失敗"); }));

  // 2) 紀錄
  const q = query(collection(db, "records"), orderBy("date", "desc"));
  unsubscribers.push(onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    allRecords = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // fromCache=true 代表尚未與雲端同步(離線或同步中);hasPendingWrites=有本地未上傳的寫入
    cloudSynced = !snap.metadata.fromCache;
    if (cloudSynced) setSync("ok", "已同步DB");
    else setSync("pending", "離線(資料暫存本機)");
    renderList();
    renderStatsView();
    renderPondFilter();
    renderTodayList();
  }, (err) => { console.error(err); cloudSynced = false; setSync("err", "讀取紀錄失敗"); }));
}

// 解除所有 Firestore 訂閱
function unsubscribeData() {
  unsubscribers.forEach((fn) => { try { fn(); } catch (e) {} });
  unsubscribers = [];
}

// ---------- 模式切換:DB / 假資料 ----------
function applyMode(demo) {
  demoMode = demo;
  localStorage.setItem(DEMO_KEY, demo ? "1" : "0");
  document.body.classList.toggle("demo-mode", demo);
  updateModeToggle();

  if (demo) {
    unsubscribeData();                 // 停掉真實訂閱,避免覆蓋畫面
    const { demoOptions, records } = buildDemoData();
    options = demoOptions;
    allRecords = records;
    setSync("demo", "假資料模式");
    // 全面重渲染
    renderOptionSelects(); renderSettings(); renderPondFilter();
    renderRecordTags(); renderList(); renderStatsView(); renderTodayList();
  } else {
    // 回 DB 模式:重新訂閱(會覆蓋掉假資料)
    if (db) { setSync("", "連線中…"); subscribeData(); }
  }
}

function updateModeToggle() {
  $$("#modeSwitch .mode-opt").forEach((b) =>
    b.classList.toggle("active", (b.dataset.mode === "demo") === demoMode));
}

function setupModeToggle() {
  applyMode(localStorage.getItem(DEMO_KEY) === "1");   // 還原上次模式
  $$("#modeSwitch .mode-opt").forEach((b) =>
    b.addEventListener("click", () => applyMode(b.dataset.mode === "demo")));
}

// 假資料模式為唯讀:攔截所有寫入,回 true 表示「已攔截,不要繼續」
function blockIfDemo() {
  if (demoMode) { showToast("假資料模式為唯讀,切回 DB 模式才能編輯", true); return true; }
  return false;
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
  // 手打池塘名也即時更新標籤區
  $("#pondInput").addEventListener("input", renderRecordTags);

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
  $("#cancelEditBtn").addEventListener("click", resetForm);
}

// 依下拉狀態決定輸入框顯示與否:選了既有池塘就隱藏+清空輸入框
function syncPondInputVisibility() {
  const picked = $("#pondSelect").value;
  const input = $("#pondInput");
  if (picked) { input.value = ""; input.hidden = true; }
  else { input.hidden = false; }
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
      await togglePondTag(pondId, b.dataset.rectag);
      // togglePondTag 會寫回 Firestore;onSnapshot 回來會更新 options,但本地先即時切換顯示
      b.classList.toggle("on");
    }));
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

// 記錄頁上方:列出「日期欄」當天已記錄的清單,點可編輯
function renderTodayList() {
  const box = $("#todayList");
  const date = $("#dateInput").value;
  if (!date) { box.innerHTML = ""; return; }
  const recs = allRecords
    .filter((r) => r.date === date)
    .sort((a, b) => (a.period === "morning" ? 0 : 1) - (b.period === "morning" ? 0 : 1));

  if (!recs.length) {
    box.innerHTML = `<div class="today-head">${escapeHtml(date)}</div><p class="today-empty">這天還沒有紀錄</p>`;
    return;
  }
  box.innerHTML = `
    <div class="today-head">${escapeHtml(date)} 已記錄 ${recs.length} 筆 <span class="today-hint">(點擊可編輯)</span></div>
    ${recs.map((r) => `
      <button type="button" class="today-item" data-edit="${r.id}">${recordSummaryLine(r)}</button>
    `).join("")}`;
  box.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => startEdit(b.dataset.edit)));
}

async function onSaveRecord(e) {
  e.preventDefault();
  if (blockIfDemo()) return;
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
      addOption("ponds", typedName, pondId).catch(() => {});
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

  const saveBtn = $("#saveBtn");
  saveBtn.disabled = true;

  // 注意:離線時 Firestore 的寫入 promise 要等連線才 resolve,不能 await(會卡住)。
  // 改為發出寫入後立即依「目前是否已同步雲端」給提示;真正失敗(如權限)用 catch 補報。
  const action = editingId ? "更新" : "儲存";
  const writePromise = editingId
    ? updateDoc(doc(db, "records", editingId), rec)
    : addDoc(collection(db, "records"), { ...rec, createdAt: serverTimestamp() });
  writePromise.catch((err) => { console.error(err); showToast(`${action}失敗:` + err.message, true); });

  if (cloudSynced) {
    showToast(`已${action} ✔ ${pondLabel(rec.pondId)} ${fmt(rec.bags)}包`);
  } else {
    showToast(`已存到本機 ⏳ 連線後自動上傳`, false);
  }
  flashSaveOk(cloudSynced);
  resetForm({ keepContext: true });
  saveBtn.disabled = false;
}

// 儲存成功時:按鈕短暫變色 + 文字回饋。synced=false 時用不同字樣(已存本機)
function flashSaveOk(synced = true) {
  const btn = $("#saveBtn");
  btn.classList.add("btn-ok-flash");
  btn.textContent = synced ? "✔ 已儲存" : "⏳ 已存本機";
  setTimeout(() => {
    btn.classList.remove("btn-ok-flash");
    btn.textContent = "儲存紀錄";   // 存檔後一律回新增模式
  }, 1200);
}

function showMsg(text, isErr) {
  const el = $("#recordMsg");
  el.textContent = text;
  el.className = "msg " + (isErr ? "err" : "ok");
  if (!isErr) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 2500);
}

// 重設表單。
// keepContext=true(存檔後):保留池塘/日期/時段/飼料/包數,只清空備註、拌料、消毒。
// keepContext=false(取消編輯):整張表清回預設。
function resetForm(opts = {}) {
  const keep = opts.keepContext === true;
  editingId = null;
  $("#saveBtn").textContent = "儲存紀錄";
  $("#cancelEditBtn").hidden = true;
  // 這三項每筆通常不同,存檔後一律清空
  $("#mixSelect").value = "";
  $("#disinfectantSelect").value = "";
  $("#noteInput").value = "";
  if (!keep) {
    $("#bagsInt").value = "2";       // 預設 2 包
    $("#feedNoSelect").selectedIndex = 0;
    $("#dateInput").value = todayStr();
    $("#pondSelect").value = "";
    $("#pondInput").value = "";
    currentPeriod = "morning";
    $$("#periodSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.period === "morning"));
  }
  syncPondInputVisibility();   // 同步池塘輸入框顯隱
  renderRecordTags();          // 池塘可能變動或清空,更新標籤區
  renderTodayList();           // 日期可能重設,更新當日清單
}

function startEdit(id) {
  const r = allRecords.find((x) => x.id === id);
  if (!r) return;
  editingId = id;
  $("#dateInput").value = r.date;
  currentPeriod = r.period || "morning";
  $$("#periodSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.period === currentPeriod));
  // 池塘:id 仍在清單中用下拉;否則(已被刪)把名稱填回輸入框讓使用者重選
  if (options.ponds.some((p) => p.id === r.pondId)) { $("#pondSelect").value = r.pondId; $("#pondInput").value = ""; }
  else { $("#pondSelect").value = ""; $("#pondInput").value = pondName(r.pondId); }
  syncPondInputVisibility();
  renderRecordTags();
  renderTodayList();           // 日期可能改變,更新當日清單
  $("#bagsInt").value = Math.round(Number(r.bags) || 0);
  $("#feedNoSelect").value = r.feedNoId || "";
  $("#mixSelect").value = r.mixId || "";
  $("#disinfectantSelect").value = r.disinfectantId || "";
  $("#noteInput").value = r.note || "";
  $("#saveBtn").textContent = "更新紀錄";
  $("#cancelEditBtn").hidden = false;
  switchPage("record");
  window.scrollTo({ top: 0, behavior: "smooth" });
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
  // 排序:日期新→舊,同日早上在前
  recs.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    const pa = a.period === "morning" ? 0 : 1;
    const pb = b.period === "morning" ? 0 : 1;
    return pa - pb;
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
    const note = r.note ? `<div class="rec-body"><span class="k">備註</span> ${escapeHtml(r.note)}</div>` : "";
    return `
      <div class="rec">
        <div class="rec-top">
          <span class="rec-pond">${escapeHtml(pondLabel(r.pondId))}
            <span class="badge ${r.period}">${periodLabel(r.period)}</span>
          </span>
          <span class="rec-date">${escapeHtml(r.date)}</span>
        </div>
        <div class="rec-body">${parts.join(" ・ ")}</div>
        ${note}
        <div class="rec-actions">
          <button class="btn-sm" data-edit="${r.id}">編輯</button>
          <button class="btn-sm btn-danger" data-del="${r.id}">刪除</button>
        </div>
      </div>`;
  }).join("");

  c.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => startEdit(b.dataset.edit)));
  c.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => onDelete(b.dataset.del)));
}

async function onDelete(id) {
  if (blockIfDemo()) return;
  const r = allRecords.find((x) => x.id === id);
  const ok = await showConfirm(
    `確定刪除這筆紀錄?\n${r?.date} ${periodLabel(r?.period)} ${r ? pondLabel(r.pondId) : ""}`,
    { okText: "刪除", danger: true }
  );
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "records", id));
    showToast("已刪除 ✔");
  } catch (err) { showToast("刪除失敗:" + err.message, true); }
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

  const rows = months.map((m) => {
    const e = byMonth[m];
    const pct = Math.max(2, Math.round((e.total / maxTotal) * 100));
    // 各飼料:依包數大→小,做成小標籤
    const feedTags = Object.entries(e.feeds).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<span class="feed-tag">${escapeHtml(k)} <b>${fmt(v)}</b></span>`).join("");
    return `
      <div class="ov-row" data-month="${m}" role="button" tabindex="0" title="點此查看 ${m} 詳細">
        <div class="ov-head">
          <span class="ov-month">${m}</span>
          <span class="ov-total">${fmt(e.total)} <small>包</small></span>
        </div>
        <div class="ov-bar"><span style="width:${pct}%"></span></div>
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

// 跟隨滑鼠的圖表 tooltip(委派在統計容器上,hover [data-tip] 顯示)
function setupChartTooltip() {
  const tip = $("#chartTip");
  const containers = ["#statsOverview", "#statsContainer"].map($);

  const show = (text, x, y) => {
    tip.innerHTML = text.split("|").map((line, i) =>
      i === 0 ? `<b>${escapeHtml(line)}</b>` : escapeHtml(line)).join("<br>");
    tip.hidden = false;
    move(x, y);
  };
  const move = (x, y) => {
    // 預設在滑鼠右下,靠近右/下邊界時翻向左/上,避免超出視窗
    const pad = 14;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x + pad, top = y + pad;
    if (left + w > window.innerWidth - 8) left = x - w - pad;
    if (top + h > window.innerHeight - 8) top = y - h - pad;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  };
  const hide = () => { tip.hidden = true; };

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

  // 各池塘 × 飼料明細:每池做成一張小卡(卡內直式條列各飼料 + 總共),多張卡自動換行並排
  const pondFeedRows = pondEntries.map(([pondId, info]) => {
    const feedLines = Object.entries(info.feeds).sort((a, b) => b[1] - a[1])
      .map(([f, v]) => `<div class="pf-feed"><span>${escapeHtml(f)}</span><span class="num">${fmt(v)}包</span></div>`).join("");
    return `
      <div class="pf-card">
        <div class="pf-pond">${escapeHtml(pondLabel(pondId))}</div>
        ${feedLines}
        <div class="pf-total"><span>總共</span><span class="num">${fmt(info.total)}包</span></div>
      </div>`;
  }).join("");
  const pondFeedCard = pondEntries.length ? `
    <div class="card">
      <div class="stats-title">🐟 各池塘飼料明細</div>
      <div class="pf-cards">${pondFeedRows}</div>
    </div>` : "";

  // 當月日曆熱力圖
  const heatCard = `
    <div class="card">
      <div class="stats-title">🗓️ 當月每日包數</div>
      ${calendarHeatmap(recs, $("#statsMonth").value)}
    </div>`;

  c.innerHTML = `
    ${barCard}
    ${pondFeedCard}
    ${feedBarCard}
    ${groupBarCard}
    ${heatCard}
    ${tagCard}
    <div class="card">
      <div class="stats-title">🏊 各池塘總包數</div>
      <table>
        <thead><tr><th>池塘</th><th class="num">總包數</th></tr></thead>
        <tbody>
          ${pondRows}
          <tr class="total"><td>合計</td><td class="num">${fmt(totalBags)}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="card">
      <div class="stats-title">🥡 各飼料編號包數</div>
      <table>
        <thead><tr><th>飼料編號</th><th class="num">包數</th></tr></thead>
        <tbody>
          ${feedRows}
          <tr class="total"><td>合計</td><td class="num">${fmt(totalBags)}</td></tr>
        </tbody>
      </table>
    </div>
    <p class="hint">本月共 ${recs.length} 筆紀錄。</p>
  `;
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

// 組出各工作表的資料(明細 / 統計 / 群組統計 / 月分總覽),供匯出與預覽共用。
// 回傳 null 代表沒有資料。
function buildExportData(records, { byMonth = false } = {}) {
  const recs = records.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const pa = a.period === "morning" ? 0 : 1, pb = b.period === "morning" ? 0 : 1;
    return pa - pb;
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

  // 各池塘飼料明細:每池列出各飼料包數,再附該池小計(與統計頁的明細卡同源)
  const pondFeed = {};   // { 池名: { total, feeds:{飼料名:包數} } }
  for (const r of recs) {
    const b = Number(r.bags) || 0;
    const pondNm = pondName(r.pondId);
    const feedNm = feedName(r.feedNoId) || "(未填)";
    const e = (pondFeed[pondNm] ||= { total: 0, feeds: {} });
    e.total += b;
    e.feeds[feedNm] = (e.feeds[feedNm] || 0) + b;
  }
  summary.push({ A: "", B: "" });
  summary.push({ A: "各池塘飼料明細", B: "" });
  Object.entries(pondFeed).sort((a, b) => b[1].total - a[1].total).forEach(([pondNm, info]) => {
    Object.entries(info.feeds).sort((a, b) => b[1] - a[1])
      .forEach(([f, v]) => summary.push({ A: `${pondNm} - ${f}`, B: v }));
    summary.push({ A: `${pondNm} 小計`, B: info.total });
  });

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

  return { detail, summary, tagSummary, monthRows };
}

// 通用匯出:records=要匯的紀錄,label=檔名標籤,byMonth=是否附「月分總覽」表
function exportToExcel(records, label, { byMonth = false } = {}) {
  if (typeof XLSX === "undefined") { showToast("Excel 函式庫尚未載入,請檢查網路後重試", true); return; }
  const data = buildExportData(records, { byMonth });
  if (!data) { showToast("這個範圍沒有資料可匯出", true); return; }
  const { detail, summary, tagSummary, monthRows } = data;

  const wb = XLSX.utils.book_new();
  const wsDetail = XLSX.utils.json_to_sheet(detail);
  wsDetail["!cols"] = [{ wch: 12 }, { wch: 6 }, { wch: 12 }, { wch: 14 }, { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, wsDetail, "明細");

  const wsSum = XLSX.utils.json_to_sheet(summary, { skipHeader: true });
  wsSum["!cols"] = [{ wch: 18 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsSum, "統計");

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
    "群組統計": rowsToTable(data.tagSummary, { headerless: true, rowClass: summaryRowClass }),
    "月分總覽": data.monthRows
      ? rowsToTable(data.monthRows, { rowClass: (r) => (r["月份"] === "合計" ? "row-total" : "") })
      : null,
  };
  const sheetNames = ["明細", "統計", "群組統計"].concat(data.monthRows ? ["月分總覽"] : []);

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
    // 篩選器與「下載篩選結果」只在明細分頁出現(篩選只影響明細)
    filtersEl.hidden = !isDetail;
    $("#previewDownloadFiltered").hidden = !isDetail;
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
  };
  const onBackdrop = (e) => { if (e.target === overlay) close(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  // 下載走完整的 SheetJS 路徑,與直接匯出一致
  const onDownloadAll = () => { exportToExcel(records, label, { byMonth }); };
  const onDownloadFiltered = () => { exportToExcel(filteredRecords(), `${label}_篩選`, { byMonth }); };

  overlay.addEventListener("click", onBackdrop);
  document.addEventListener("keydown", onKey);
  $("#previewClose").addEventListener("click", close);
  $("#previewDownloadAll").addEventListener("click", onDownloadAll);
  $("#previewDownloadFiltered").addEventListener("click", onDownloadFiltered);
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
  if (blockIfDemo()) return;
  if (!db) return;
  const pondTags = { ...(options.pondTags || {}) };
  const list = new Set(pondTags[pondId] || []);
  if (list.has(tag)) list.delete(tag); else list.add(tag);
  // 依 tags 的順序保存,維持一致
  pondTags[pondId] = (options.tags || []).filter((t) => list.has(t));
  try {
    await updateDoc(doc(db, "settings", "options"), { pondTags });
  } catch (err) { showToast("儲存群組失敗:" + err.message, true); }
}

// 新增選項。四組帶 id 的選項存 {id,name};tags 維持純字串。
// presetId:給 onSaveRecord 手打新池塘時用(先在本地產 id,確保紀錄能立刻指到)。
// 回傳 true=已新增、false=未新增(撞名或被擋),讓呼叫端決定要不要清空輸入框。
async function addOption(key, value, presetId) {
  if (blockIfDemo()) return false;
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
  await updateDoc(doc(db, "settings", "options"), { [key]: next });
  return true;
}

// 把選項從 from 位置移到 to 位置,寫回 Firestore
async function reorderOption(key, from, to) {
  if (blockIfDemo()) return;
  if (!db) return;
  const list = (options[key] || []).slice();
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  try {
    await updateDoc(doc(db, "settings", "options"), { [key]: list });
    showToast(`已調整順序:「${optName(moved)}」`);
  } catch (err) { showToast("排序失敗:" + err.message, true); }
}

// 重新命名選項:單點 chip 觸發。
// 帶 id 的選項只改 name(id 不變,既有紀錄與 pondTags 自動跟著);tags 改名需連帶更新 pondTags 內的引用。
async function renameOption(key, idx) {
  if (blockIfDemo()) return;
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

  try {
    await updateDoc(doc(db, "settings", "options"), patch);
    showToast(`已改名:「${old}」→「${next}」`);
  } catch (err) { showToast("改名失敗:" + err.message, true); }
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
  if (blockIfDemo()) return;
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
  }

  await updateDoc(doc(db, "settings", "options"), patch);
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
  setupRecordForm();
  setupList();
  setupStats();
  switchPage("record");            // 設定初始分頁狀態(含儲存列顯示、底部留白)
  // 先以預設選項渲染一次(離線/未連線也有畫面)
  renderOptionSelects();
  renderSettings();

  initFirebase();
  // 還原上次模式:applyMode 內部會處理(假資料→灌假資料;DB→訂閱 Firestore)
  setupModeToggle();

  // 註冊 service worker(PWA)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
}

main();
