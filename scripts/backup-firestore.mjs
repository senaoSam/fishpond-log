// 一次性 Firestore 備份腳本(透過 REST API,規則公開所以免金鑰)。
// 用法:node scripts/backup-firestore.mjs
// 會把 records 集合 + settings/options 文件原始 JSON 存到 backups/<timestamp>/。
//
// 存兩種格式:
//   *.raw.json    Firestore REST 原始格式(含型別包裝,完整可還原)
//   *.plain.json  攤平成一般 JS 值(方便人看 / 之後遷移腳本直接吃)
import { firebaseConfig } from "../firebase-config.js";
import { writeFileSync, mkdirSync } from "node:fs";

const PROJECT = firebaseConfig.projectId;
const KEY = firebaseConfig.apiKey;
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// 把 Firestore REST 的型別包裝值還原成一般 JS 值
function decode(v) {
  if (v == null) return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  return v; // 未知型別原樣保留
}
function decodeFields(fields) {
  const out = {};
  for (const [k, val] of Object.entries(fields)) out[k] = decode(val);
  return out;
}

async function fetchCollection(name) {
  const docs = [];
  let pageToken = "";
  do {
    const url = `${BASE}/${name}?key=${KEY}&pageSize=300${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${name} 讀取失敗:${res.status} ${await res.text()}`);
    const data = await res.json();
    for (const d of data.documents || []) {
      docs.push({ id: d.name.split("/").pop(), raw: d.fields || {}, plain: decodeFields(d.fields || {}) });
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return docs;
}

async function fetchDoc(path) {
  const url = `${BASE}/${path}?key=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} 讀取失敗:${res.status} ${await res.text()}`);
  const d = await res.json();
  return { id: d.name.split("/").pop(), raw: d.fields || {}, plain: decodeFields(d.fields || {}) };
}

// 時間戳記:用本地時間,避免動到全域 Date 限制(這是獨立 node 腳本,沒問題)
function stamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

const dir = `backups/${stamp()}`;
mkdirSync(dir, { recursive: true });

console.log(`備份專案:${PROJECT}`);

const records = await fetchCollection("records");
writeFileSync(`${dir}/records.raw.json`, JSON.stringify(records.map((r) => ({ id: r.id, fields: r.raw })), null, 2));
writeFileSync(`${dir}/records.plain.json`, JSON.stringify(records.map((r) => ({ id: r.id, ...r.plain })), null, 2));
console.log(`  records:        ${records.length} 筆`);

const options = await fetchDoc("settings/options");
writeFileSync(`${dir}/settings.options.raw.json`, JSON.stringify({ id: options.id, fields: options.raw }, null, 2));
writeFileSync(`${dir}/settings.options.plain.json`, JSON.stringify({ id: options.id, ...options.plain }, null, 2));
console.log(`  settings/options 已備份`);

console.log(`\n✔ 備份完成 → ${dir}/`);
