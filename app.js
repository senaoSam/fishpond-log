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

// ---------- 預設固定選項(首次使用會寫進 Firestore) ----------
const DEFAULT_OPTIONS = {
  ponds: [],
  feedNos: ["0.8號", "000號", "00號", "0號", "1號", "2號", "3號", "4號", "5號", "6號", "7號"],
  mixes: ["安蒙20%", "安蒙50%", "弗洛得", "OTC"],
  disinfectants: ["二氧化氯10%", "二氧化氯50%", "三氯20G", "三氯90%"]
};

// 各選項欄位的中文標題(設定頁用)
const OPTION_LABELS = {
  ponds: "池塘名稱",
  feedNos: "飼料編號",
  mixes: "拌料",
  disinfectants: "消毒劑"
};

// ---------- 全域狀態 ----------
let db = null;
let allRecords = [];        // 由 Firestore 即時同步的全部紀錄(含 id)
let options = { ...DEFAULT_OPTIONS };
let editingId = null;       // 目前正在編輯的紀錄 id(null = 新增模式)
let currentPeriod = "morning";

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
  onSnapshot(optRef, async (snap) => {
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
  }, (err) => { console.error(err); setSync("err", "讀取設定失敗"); });

  // 2) 紀錄
  const q = query(collection(db, "records"), orderBy("date", "desc"));
  onSnapshot(q, (snap) => {
    allRecords = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    setSync("ok", "已同步");
    renderList();
    renderStats();
    renderPondFilter();
  }, (err) => { console.error(err); setSync("err", "讀取紀錄失敗"); });
}

// ============================================================
//  下拉選單渲染
// ============================================================
function fillSelect(sel, items, { allowEmpty = false, emptyLabel = "(不選)" } = {}) {
  const prev = sel.value;
  sel.innerHTML = "";
  if (allowEmpty) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = emptyLabel;
    sel.appendChild(o);
  }
  for (const it of items) {
    const o = document.createElement("option");
    o.value = it; o.textContent = it;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function renderOptionSelects() {
  // 池塘:下拉(可空,搭配手動輸入框)
  fillSelect($("#pondSelect"), options.ponds, { allowEmpty: true, emptyLabel: "— 選擇或在下方輸入 —" });
  fillSelect($("#feedNoSelect"), options.feedNos);
  fillSelect($("#mixSelect"), options.mixes, { allowEmpty: true });
  fillSelect($("#disinfectantSelect"), options.disinfectants, { allowEmpty: true });
}

function renderPondFilter() {
  const sel = $("#listPondFilter");
  const prev = sel.value;
  // 池塘清單 = 設定的池塘 ∪ 紀錄中出現過的池塘
  const set = new Set(options.ponds);
  allRecords.forEach((r) => r.pond && set.add(r.pond));
  const ponds = [...set].sort();
  sel.innerHTML = '<option value="">全部</option>';
  for (const p of ponds) {
    const o = document.createElement("option");
    o.value = p; o.textContent = p;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

// ============================================================
//  記錄頁
// ============================================================
function setupRecordForm() {
  $("#dateInput").value = todayStr();

  // 時段切換
  $("#periodSeg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    currentPeriod = btn.dataset.period;
    $$("#periodSeg .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  });

  // 選了下拉池塘 → 清掉手動輸入(以下拉為準)
  $("#pondSelect").addEventListener("change", () => {
    if ($("#pondSelect").value) $("#pondInput").value = "";
  });
  // 在 opt-select 選 "+ 新增" 不需要,因為新增在設定頁。

  $("#recordForm").addEventListener("submit", onSaveRecord);
  $("#cancelEditBtn").addEventListener("click", resetForm);
}

function getPondValue() {
  const typed = $("#pondInput").value.trim();
  return typed || $("#pondSelect").value || "";
}

async function onSaveRecord(e) {
  e.preventDefault();
  if (!db) { showMsg("尚未設定 Firebase,無法儲存", true); return; }

  const pond = getPondValue();
  const bags = parseFloat($("#bagsInput").value);
  if (!pond) { showMsg("請選擇或輸入池塘名稱", true); return; }
  if (isNaN(bags)) { showMsg("請輸入包數", true); return; }

  const rec = {
    pond,
    date: $("#dateInput").value,
    period: currentPeriod,
    bags,
    feedNo: $("#feedNoSelect").value || "",
    mix: $("#mixSelect").value || "",
    disinfectant: $("#disinfectantSelect").value || "",
    note: $("#noteInput").value.trim()
  };

  const saveBtn = $("#saveBtn");
  saveBtn.disabled = true;
  try {
    // 若輸入了新池塘名稱,自動加入池塘清單
    if (pond && !options.ponds.includes(pond)) {
      await addOption("ponds", pond);
    }

    if (editingId) {
      await updateDoc(doc(db, "records", editingId), rec);
      showMsg("已更新 ✔");
    } else {
      rec.createdAt = serverTimestamp();
      await addDoc(collection(db, "records"), rec);
      showMsg("已儲存 ✔");
    }
    resetForm({ keepContext: true });
  } catch (err) {
    console.error(err);
    showMsg("儲存失敗:" + err.message, true);
  } finally {
    saveBtn.disabled = false;
  }
}

function showMsg(text, isErr) {
  const el = $("#recordMsg");
  el.textContent = text;
  el.className = "msg " + (isErr ? "err" : "ok");
  if (!isErr) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 2500);
}

// 重設表單。keepContext=true 時保留日期/池塘,方便連續記下一池
function resetForm(opts = {}) {
  const keep = opts.keepContext === true;
  editingId = null;
  $("#saveBtn").textContent = "儲存紀錄";
  $("#cancelEditBtn").hidden = true;
  $("#bagsInput").value = "";
  $("#feedNoSelect").selectedIndex = 0;
  $("#mixSelect").value = "";
  $("#disinfectantSelect").value = "";
  $("#noteInput").value = "";
  if (!keep) {
    $("#dateInput").value = todayStr();
    $("#pondSelect").value = "";
    $("#pondInput").value = "";
    currentPeriod = "morning";
    $$("#periodSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.period === "morning"));
  }
}

function startEdit(id) {
  const r = allRecords.find((x) => x.id === id);
  if (!r) return;
  editingId = id;
  $("#dateInput").value = r.date;
  currentPeriod = r.period || "morning";
  $$("#periodSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.period === currentPeriod));
  // 池塘:若在清單中用下拉,否則填到輸入框
  if (options.ponds.includes(r.pond)) { $("#pondSelect").value = r.pond; $("#pondInput").value = ""; }
  else { $("#pondSelect").value = ""; $("#pondInput").value = r.pond; }
  $("#bagsInput").value = r.bags;
  $("#feedNoSelect").value = r.feedNo || "";
  $("#mixSelect").value = r.mix || "";
  $("#disinfectantSelect").value = r.disinfectant || "";
  $("#noteInput").value = r.note || "";
  $("#saveBtn").textContent = "更新紀錄";
  $("#cancelEditBtn").hidden = false;
  switchPage("record");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ============================================================
//  列表 / 查詢頁
// ============================================================
function setupList() {
  $("#listMonth").value = thisMonthStr();
  $("#listMonth").addEventListener("change", renderList);
  $("#listPondFilter").addEventListener("change", renderList);
}

function filteredRecords() {
  const month = $("#listMonth").value;       // YYYY-MM 或 ""
  const pond = $("#listPondFilter").value;
  let recs = allRecords.slice();
  if (month) recs = recs.filter((r) => (r.date || "").startsWith(month));
  if (pond) recs = recs.filter((r) => r.pond === pond);
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
    parts.push(`<span class="k">包數</span> <b>${escapeHtml(r.bags)}</b>`);
    if (r.feedNo) parts.push(`<span class="k">飼料</span> ${escapeHtml(r.feedNo)}`);
    if (r.mix) parts.push(`<span class="k">拌料</span> ${escapeHtml(r.mix)}`);
    if (r.disinfectant) parts.push(`<span class="k">消毒</span> ${escapeHtml(r.disinfectant)}`);
    const note = r.note ? `<div class="rec-body"><span class="k">備註</span> ${escapeHtml(r.note)}</div>` : "";
    return `
      <div class="rec">
        <div class="rec-top">
          <span class="rec-pond">${escapeHtml(r.pond)}
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
  const r = allRecords.find((x) => x.id === id);
  const ok = await showConfirm(
    `確定刪除這筆紀錄?\n${r?.date} ${periodLabel(r?.period)} ${r?.pond}`,
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
function setupStats() {
  $("#statsMonth").value = thisMonthStr();
  $("#statsMonth").addEventListener("change", renderStats);
  $("#exportBtn").addEventListener("click", exportExcel);
}

function statsRecords() {
  const month = $("#statsMonth").value;
  return allRecords.filter((r) => month && (r.date || "").startsWith(month));
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
    byPond[r.pond] = (byPond[r.pond] || 0) + b;
    const fk = r.feedNo || "(未填)";
    byFeed[fk] = (byFeed[fk] || 0) + b;
  }

  const pondRows = Object.entries(byPond).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td class="num">${fmt(v)}</td></tr>`).join("");
  const feedRows = Object.entries(byFeed)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td class="num">${fmt(v)}</td></tr>`).join("");

  c.innerHTML = `
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
//  匯出 Excel (SheetJS)
// ============================================================
function exportExcel() {
  const month = $("#statsMonth").value || "全部";
  const recs = statsRecords().slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const pa = a.period === "morning" ? 0 : 1, pb = b.period === "morning" ? 0 : 1;
    return pa - pb;
  });
  if (!recs.length) { showToast("這個月沒有資料可匯出", true); return; }
  if (typeof XLSX === "undefined") { showToast("Excel 函式庫尚未載入,請檢查網路後重試", true); return; }

  // 工作表 1:明細
  const detail = recs.map((r) => ({
    "日期": r.date,
    "時段": periodLabel(r.period),
    "池塘": r.pond,
    "包數": Number(r.bags) || 0,
    "飼料編號": r.feedNo || "",
    "拌料": r.mix || "",
    "消毒劑": r.disinfectant || "",
    "備註": r.note || ""
  }));

  // 工作表 2:統計(各池塘 / 各飼料)
  const byPond = {}, byFeed = {};
  let total = 0;
  for (const r of recs) {
    const b = Number(r.bags) || 0; total += b;
    byPond[r.pond] = (byPond[r.pond] || 0) + b;
    byFeed[r.feedNo || "(未填)"] = (byFeed[r.feedNo || "(未填)"] || 0) + b;
  }
  const summary = [];
  summary.push({ A: "各池塘總包數", B: "" });
  Object.entries(byPond).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => summary.push({ A: k, B: v }));
  summary.push({ A: "合計", B: total });
  summary.push({ A: "", B: "" });
  summary.push({ A: "各飼料編號包數", B: "" });
  Object.entries(byFeed).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => summary.push({ A: k, B: v }));
  summary.push({ A: "合計", B: total });

  const wb = XLSX.utils.book_new();
  const wsDetail = XLSX.utils.json_to_sheet(detail);
  wsDetail["!cols"] = [{ wch: 12 }, { wch: 6 }, { wch: 12 }, { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, wsDetail, "明細");

  const wsSum = XLSX.utils.json_to_sheet(summary, { skipHeader: true });
  wsSum["!cols"] = [{ wch: 18 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsSum, "統計");

  XLSX.writeFile(wb, `魚塭紀錄_${month}.xlsx`);
}

// ============================================================
//  設定頁(編輯四組固定選項)
// ============================================================
function renderSettings() {
  const c = $("#settingsContainer");
  c.innerHTML = Object.keys(OPTION_LABELS).map((key) => {
    const items = options[key] || [];
    const chips = items.map((it, i) => `
      <span class="chip">${escapeHtml(it)}
        <button title="刪除" data-rmkey="${key}" data-rmidx="${i}">×</button>
      </span>`).join("") || '<span class="hint">尚無選項</span>';
    return `
      <details class="card opt-group" open>
        <summary>${OPTION_LABELS[key]}(${items.length})</summary>
        <div class="chip-list">${chips}</div>
        <div class="add-row">
          <input type="text" placeholder="新增${OPTION_LABELS[key]}…" data-addkey="${key}" />
          <button class="btn-primary btn-sm" data-addbtn="${key}">新增</button>
        </div>
      </details>`;
  }).join("");

  c.querySelectorAll("[data-rmkey]").forEach((b) =>
    b.addEventListener("click", () => removeOption(b.dataset.rmkey, Number(b.dataset.rmidx))));
  c.querySelectorAll("[data-addbtn]").forEach((b) =>
    b.addEventListener("click", () => {
      const key = b.dataset.addbtn;
      const input = c.querySelector(`[data-addkey="${key}"]`);
      const val = input.value.trim();
      if (val) { addOption(key, val); input.value = ""; }
    }));
  // Enter 也能新增
  c.querySelectorAll("[data-addkey]").forEach((inp) =>
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault();
        const val = inp.value.trim();
        if (val) { addOption(inp.dataset.addkey, val); inp.value = ""; }
      }
    }));
}

async function addOption(key, value) {
  if (!db) return;
  const list = options[key] || [];
  if (list.includes(value)) return;           // 不重複
  const next = [...list, value];
  await updateDoc(doc(db, "settings", "options"), { [key]: next });
}

async function removeOption(key, idx) {
  if (!db) return;
  const list = (options[key] || []).slice();
  const removed = list[idx];
  const ok = await showConfirm(
    `確定刪除「${removed}」?\n(已存在的舊紀錄不受影響)`,
    { okText: "刪除", danger: true }
  );
  if (!ok) return;
  list.splice(idx, 1);
  await updateDoc(doc(db, "settings", "options"), { [key]: list });
}

// ============================================================
//  分頁切換
// ============================================================
function switchPage(name) {
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.page === name));
  window.scrollTo({ top: 0 });
}
function setupTabs() {
  $$(".tab").forEach((t) => t.addEventListener("click", () => switchPage(t.dataset.page)));
}

// ============================================================
//  啟動
// ============================================================
function main() {
  setupTheme();
  setupTabs();
  setupRecordForm();
  setupList();
  setupStats();
  // 先以預設選項渲染一次(離線/未連線也有畫面)
  renderOptionSelects();
  renderSettings();

  if (initFirebase()) {
    setSync("", "連線中…");
    subscribeData();
  }

  // 註冊 service worker(PWA)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
}

main();
