// 一次性搬遷:把根目錄的 records / settings / meta / assets 複製到秘密路徑 /p/{秘密}/ 底下。
// 透過 REST API,用 Firestore 原始格式整份 PATCH(型別、時間戳原樣保留,文件 id 不變)。
//
// 用法:
//   node scripts/copy-to-secret-path.mjs            # 乾跑:只列出會複製哪些文件,不寫入
//   node scripts/copy-to-secret-path.mjs --commit   # 真的寫入
//
// 可重複執行(切換期間舊版手機仍可能寫舊路徑,上線後要再跑一次補過去):
//   - 第一次 --commit 會把舊路徑原始資料備份到 backups/<timestamp>-pre-secret/,
//     並把複製時間記在 scripts/_copy-state.json(不進 repo)。
//   - 之後只複製「新路徑還沒有、且在第一次複製之後才建立」或「舊路徑比新路徑更新」的文件,
//     不會蓋掉新版 App 已改過的資料,也不會把新版刪掉的紀錄復活。
//   - 舊路徑被刪的文件不會同步刪除(只複製、不刪除)。
import { firebaseConfig, DB_ROOT } from "../firebase-config.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";

const PROJECT = firebaseConfig.projectId;
const KEY = firebaseConfig.apiKey;
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
if (!DB_ROOT[1]) throw new Error("讀不到資料庫秘密路徑:請確認 secret.local.js 存在");
const NEW = `${ROOT}/${DB_ROOT.join("/")}`;
const COMMIT = process.argv.includes("--commit");
const STATE = "scripts/_copy-state.json";

const COLLECTIONS = ["records", "settings", "meta", "assets"];

// 撈整個 collection(分頁),回 Map<id, {fields, createTime, updateTime}>
async function list(base, col) {
  const out = new Map();
  let tok = "";
  do {
    const res = await fetch(`${base}/${col}?key=${KEY}&pageSize=300${tok ? `&pageToken=${tok}` : ""}`);
    if (!res.ok) throw new Error(`${col} 讀取失敗:${res.status} ${await res.text()}`);
    const j = await res.json();
    for (const d of j.documents || [])
      out.set(d.name.split("/").pop(), { fields: d.fields || {}, createTime: d.createTime, updateTime: d.updateTime });
    tok = j.nextPageToken || "";
  } while (tok);
  return out;
}

async function put(col, id, fields) {
  const res = await fetch(`${NEW}/${col}/${encodeURIComponent(id)}?key=${KEY}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`${col}/${id} 寫入失敗:${res.status} ${await res.text()}`);
}

// 欄位比對用:key 排序後序列化,避免 key 順序不同被判成不一樣
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
const firstRun = !state;
console.log(`專案:${PROJECT}`);
console.log(`模式:${COMMIT ? "寫入" : "乾跑(加 --commit 才會寫入)"}`);
console.log(firstRun ? "第一次複製:全部複製" : `增量補複製(第一次複製於 ${state.copiedAt})`);
console.log("");

const startedAt = new Date().toISOString();
const old = {}, cur = {};
for (const c of COLLECTIONS) {
  old[c] = await list(ROOT, c);
  cur[c] = await list(NEW, c);
}

// 第一次寫入前,先把舊路徑原始資料留一份本機備份
if (COMMIT && firstRun) {
  const z = (n) => String(n).padStart(2, "0");
  const d = new Date();
  const dir = `backups/${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}-pre-secret`;
  mkdirSync(dir, { recursive: true });
  for (const c of COLLECTIONS)
    writeFileSync(`${dir}/${c}.raw.json`, JSON.stringify([...old[c]].map(([id, d]) => ({ id, ...d })), null, 1));
  console.log(`舊路徑原始資料已備份 → ${dir}/\n`);
}

let total = 0;
for (const c of COLLECTIONS) {
  const todo = [];
  for (const [id, d] of old[c]) {
    const n = cur[c].get(id);
    let why = "";
    if (firstRun) why = n ? (same(d.fields, n.fields) ? "" : "覆蓋") : "新增";
    else if (!n) why = d.createTime > state.copiedAt ? "切換期間新增" : "";   // 舊文件不見 = 新版刪的,不復活
    else if (d.updateTime > n.updateTime && !same(d.fields, n.fields)) why = "舊路徑較新";
    if (why) todo.push([id, why]);
  }
  console.log(`${c}: 舊路徑 ${old[c].size} 筆 / 新路徑 ${cur[c].size} 筆 → 要複製 ${todo.length} 筆`);
  for (const [id, why] of todo) {
    if (!firstRun) console.log(`  ${why}  ${id}`);
    if (COMMIT) await put(c, id, old[c].get(id).fields);
  }
  total += todo.length;
}

if (!COMMIT) {
  console.log(`\n乾跑結束,共 ${total} 筆待複製`);
  process.exit(0);
}
if (firstRun) writeFileSync(STATE, JSON.stringify({ copiedAt: startedAt }, null, 2));

// 核對:舊路徑每份文件在新路徑都要存在(第一次複製時內容也要完全一致)
let bad = 0;
for (const c of COLLECTIONS) {
  const after = await list(NEW, c);
  for (const [id, d] of old[c]) {
    const n = after.get(id);
    if (firstRun ? !n || !same(d.fields, n.fields) : false) { bad++; console.log(`  ✘ ${c}/${id} 不一致`); }
  }
  console.log(`核對 ${c}: 新路徑現有 ${after.size} 筆`);
}
console.log(bad ? `\n✘ 有 ${bad} 筆不一致,請檢查` : `\n✔ 完成,共複製 ${total} 筆`);
