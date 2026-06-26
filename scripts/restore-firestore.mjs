// 一次性 Firestore 還原腳本(rollback 用)。透過 REST API,規則公開所以免金鑰。
// 用法:node scripts/restore-firestore.mjs backups/<timestamp>
//
// 會把該備份資料夾的 *.raw.json 寫回 Firestore:
//   - settings/options 整份覆蓋
//   - records 每筆以原 id PATCH 覆蓋(備份當下不存在的「新文件」不會被刪)
// 注意:這是「覆蓋還原」,不是「鏡像同步」。備份後新增的文件不會被移除。
import { firebaseConfig } from "../firebase-config.js";
import { readFileSync } from "node:fs";

const PROJECT = firebaseConfig.projectId;
const KEY = firebaseConfig.apiKey;
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const dir = process.argv[2];
if (!dir) {
  console.error("用法:node scripts/restore-firestore.mjs backups/<timestamp>");
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// PATCH 寫回一份文件。fields 為 Firestore REST 原始格式。
async function patchDoc(path, fields) {
  const url = `${BASE}/${path}?key=${KEY}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`${path} 寫回失敗:${res.status} ${await res.text()}`);
}

console.log(`還原來源:${dir}`);
console.log(`目標專案:${PROJECT}\n`);

// 1) settings/options
const opt = readJson(`${dir}/settings.options.raw.json`);
await patchDoc("settings/options", opt.fields);
console.log("  settings/options 已還原");

// 2) records(逐筆;量小,序列寫入即可)
const records = readJson(`${dir}/records.raw.json`);
let ok = 0;
for (const r of records) {
  await patchDoc(`records/${r.id}`, r.fields);
  ok++;
}
console.log(`  records:        ${ok}/${records.length} 筆已還原`);

console.log(`\n✔ 還原完成`);
