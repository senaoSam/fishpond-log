// 一次性遷移:把「字串值」選項/紀錄轉成「id 關聯」架構。透過 REST API(規則公開)。
//
//   選項 ponds/feedNos/mixes/disinfectants:["A","B"] → [{id,name}]
//   紀錄 r.pond/feedNo/mix/disinfectant(名稱字串)→ r.pondId/feedNoId/mixId/disinfectantId(id)
//   pondTags 的 key:池塘名 → 池塘 id
//   tags(群組)維持純字串不動
//
// 用法:
//   node scripts/migrate-to-uuid.mjs            # 乾跑:只把轉換結果寫到 scripts/_migration-preview.json,不碰 Firestore
//   node scripts/migrate-to-uuid.mjs --commit   # 真的寫回 Firestore
//
// 安全性:乾跑會印出每筆紀錄的對應,確認無誤再 --commit。執行前請先 backup-firestore.mjs。
import { firebaseConfig } from "../firebase-config.js";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const PROJECT = firebaseConfig.projectId;
const KEY = firebaseConfig.apiKey;
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const COMMIT = process.argv.includes("--commit");

const ID_KEYS = ["ponds", "feedNos", "mixes", "disinfectants"];

// ---------- REST 解碼 / 編碼 ----------
function decode(v) {
  if (v == null || "nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return { __ts: v.timestampValue };
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  return null;
}
function decodeFields(fields) {
  const out = {};
  for (const [k, val] of Object.entries(fields)) out[k] = decode(val);
  return out;
}
function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (v && typeof v === "object" && "__ts" in v) return { timestampValue: v.__ts };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === "object") return { mapValue: { fields: encodeFields(v) } };
  return { nullValue: null };
}
function encodeFields(obj) {
  const out = {};
  for (const [k, val] of Object.entries(obj)) out[k] = encode(val);
  return out;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}
async function patchDoc(path, fields) {
  const res = await fetch(`${BASE}/${path}?key=${KEY}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: encodeFields(fields) }),
  });
  if (!res.ok) throw new Error(`${path} 寫入失敗:${res.status} ${await res.text()}`);
}

// ---------- 主流程 ----------
console.log(`遷移專案:${PROJECT}  模式:${COMMIT ? "★ 真的寫入" : "乾跑(不寫入)"}\n`);

// 1) 讀 options
const optRaw = await getJson(`${BASE}/settings/options?key=${KEY}`);
const opt = decodeFields(optRaw.fields || {});

// 2) 各選項:字串陣列 → [{id,name}],並建 name→id 對照
const nameToId = {};   // { key: { name: id } }
const newOptions = { ...opt };
for (const key of ID_KEYS) {
  const arr = opt[key] || [];
  nameToId[key] = {};
  newOptions[key] = arr.map((entry) => {
    // 已是 {id,name} 就沿用(可重跑);否則是字串
    if (entry && typeof entry === "object" && entry.id) {
      nameToId[key][entry.name] = entry.id;
      return { id: entry.id, name: entry.name };
    }
    const id = randomUUID();
    nameToId[key][entry] = id;
    return { id, name: entry };
  });
}

// 3) pondTags:key 從池塘名 → 池塘 id
const oldPondTags = opt.pondTags || {};
const newPondTags = {};
for (const [pondName, tags] of Object.entries(oldPondTags)) {
  const pid = nameToId.ponds[pondName];
  if (pid) newPondTags[pid] = tags;
  else console.warn(`  ⚠ pondTags 有未知池塘「${pondName}」,略過`);
}
newOptions.pondTags = newPondTags;

// 4) 讀 records 並轉換
const recRaw = await getJson(`${BASE}/records?key=${KEY}&pageSize=500`);
const recs = (recRaw.documents || []).map((d) => ({ id: d.name.split("/").pop(), data: decodeFields(d.fields || {}) }));

const recPatches = [];
const FIELD_MAP = [["pond", "pondId", "ponds"], ["feedNo", "feedNoId", "feedNos"], ["mix", "mixId", "mixes"], ["disinfectant", "disinfectantId", "disinfectants"]];
for (const { id, data } of recs) {
  const next = { ...data };
  for (const [oldF, newF, key] of FIELD_MAP) {
    if (oldF in next) {
      const nm = next[oldF];
      next[newF] = nm ? (nameToId[key][nm] || "") : "";
      if (nm && !nameToId[key][nm]) console.warn(`  ⚠ 紀錄 ${id} 的 ${oldF}=「${nm}」在選項中找不到,${newF} 設空`);
      delete next[oldF];
    }
  }
  recPatches.push({ id, data: next });
}

// 5) 預覽 / 寫入
const preview = {
  options: newOptions,
  records: recPatches.map((r) => ({ id: r.id, pondId: r.data.pondId, feedNoId: r.data.feedNoId, mixId: r.data.mixId, disinfectantId: r.data.disinfectantId, date: r.data.date })),
};
writeFileSync("scripts/_migration-preview.json", JSON.stringify(preview, null, 2));
console.log(`選項轉換:ponds ${newOptions.ponds.length}、feedNos ${newOptions.feedNos.length}、mixes ${newOptions.mixes.length}、disinfectants ${newOptions.disinfectants.length}`);
console.log(`pondTags key 數:${Object.keys(newPondTags).length}`);
console.log(`紀錄轉換:${recPatches.length} 筆`);
console.log(`\n預覽已寫到 scripts/_migration-preview.json`);

if (!COMMIT) {
  console.log("\n乾跑結束。確認預覽無誤後,加 --commit 真的寫入。");
  process.exit(0);
}

console.log("\n開始寫入 Firestore…");
await patchDoc("settings/options", newOptions);
console.log("  settings/options 已更新");
let n = 0;
for (const r of recPatches) {
  await patchDoc(`records/${r.id}`, r.data);
  n++;
}
console.log(`  records:${n}/${recPatches.length} 筆已更新`);
console.log("\n✔ 遷移完成");
