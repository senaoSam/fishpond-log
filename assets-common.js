// 每日資產 / 當沖記帳 兩頁共用的小工具:格式化、toast、確認對話框、深色模式。
// 頁面需有 #toast、#modalOverlay(#modalText/#modalOk/#modalCancel)、#themeToggle 這些元素。

export const $ = (s) => document.querySelector(s);
export const THEME_KEY = "yutun-theme";      // 與魚塭頁共用深色設定

export const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
// 千分位;負數帶減號
export const fmt = (n) => round2(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
export const fmtSigned = (n) => (n > 0 ? "+" : "") + fmt(n);
export const fmtPct = (r) => (r > 0 ? "+" : "") + (r * 100).toFixed(2) + "%";
export const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
// 軸標籤用的精簡格式:百萬→M、千→K,避免 Y 軸文字過長被切到
export const fmtAxis = (n) => {
  const v = Number(n) || 0, a = Math.abs(v), s = v < 0 ? "-" : "";
  const trim = (x) => (Math.round(x * 100) / 100).toString();
  if (a >= 1e6) return s + trim(a / 1e6) + "M";
  if (a >= 1e3) return s + trim(a / 1e3) + "K";
  return trim(a) === "0" ? "0" : s + trim(a);
};
export const todayStr = () => {
  const d = new Date(); const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};

export function toast(msg, err = false) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.className = "toast", 2200);
}

// 自訂確認對話框(取代原生 confirm),回傳 Promise<boolean>
export function showConfirm(message, { okText = "確定", danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = $("#modalOverlay"), okBtn = $("#modalOk"), cancelBtn = $("#modalCancel");
    $("#modalText").textContent = message;
    okBtn.textContent = okText;
    okBtn.classList.toggle("btn-danger", danger);
    okBtn.classList.toggle("btn-primary", !danger);
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
    const onKey = (e) => { if (e.key === "Escape") close(false); if (e.key === "Enter") close(true); };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    overlay.hidden = false;
    okBtn.focus();
  });
}

// ---------- 深色模式 ----------
// onChange:切換後呼叫(重畫圖以套用新色)
const THEME_COLOR = { light: "#0b7285", dark: "#1a222b" }; // 對應 header 色,給手機狀態列
export function initTheme(onChange) {
  function applyTheme(dark) {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    $("#themeToggle").textContent = dark ? "☀️" : "🌙";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? THEME_COLOR.dark : THEME_COLOR.light);
  }
  // 優先用使用者上次的選擇;沒有的話跟隨系統偏好(與魚塭頁一致)
  const savedTheme = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(savedTheme ? savedTheme === "dark" : prefersDark);
  $("#themeToggle").addEventListener("click", () => {
    const dark = document.documentElement.getAttribute("data-theme") !== "dark";
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
    applyTheme(dark);
    onChange();
  });
  // 使用者沒手動選過時,跟著系統設定即時變化
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!localStorage.getItem(THEME_KEY)) { applyTheme(e.matches); onChange(); }
  });
}
