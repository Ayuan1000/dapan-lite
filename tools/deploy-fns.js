// Full digest deploy: all public files + functions (exactly what netlify-cli does)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SITE = "9417d3e3-33c7-4b65-9b4c-b86ab4eb9438";
const TOKEN = "nfc_VFhRuT8773JQsRAiGWJbMcJ9gYjyTKP227fd";
const ROOT = path.resolve(__dirname, "..");
const API = "https://api.netlify.com/api/v1";
const PUB = path.join(ROOT, "public");
const FNS = path.join(ROOT, "netlify", "functions");

function sha1(buf) { return crypto.createHash("sha1").update(buf).digest("hex"); }
function walk(dir, base, out) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) walk(full, base, out);
    else out.push({ sitePath: "/" + path.relative(base, full).replace(/\\/g, "/"), full });
  }
  return out;
}

async function api(method, url, body, isRaw) {
  const headers = { Authorization: "Bearer " + TOKEN };
  let payload;
  if (isRaw) { headers["Content-Type"] = "application/octet-stream"; payload = body; }
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  const fileMap = {};
  const uploads = [];
  for (const f of walk(PUB, PUB, [])) {
    fileMap[f.sitePath] = sha1(fs.readFileSync(f.full));
    uploads.push(f);
  }
  for (const f of fs.readdirSync(FNS)) {
    if (!f.endsWith(".js")) continue;
    const sitePath = "/.netlify/functions/" + f;
    fileMap[sitePath] = sha1(fs.readFileSync(path.join(FNS, f)));
    uploads.push({ sitePath, full: path.join(FNS, f) });
  }
  console.log("files:", Object.keys(fileMap).length, JSON.stringify(Object.keys(fileMap)));

  const dep = await api("POST", `${API}/sites/${SITE}/deploys`, { files: fileMap, async: true });
  console.log("deploy:", dep.id, dep.state);

  const needed = new Set(dep.required || []);
  for (const f of uploads) {
    if (needed.size && !needed.has(f.sitePath)) continue;
    await api("PUT", `${API}/deploys/${dep.id}/files/${f.sitePath}`, fs.readFileSync(f.full), true);
    console.log("uploaded:", f.sitePath);
  }

  let state = dep.state, tries = 0;
  while (state !== "ready" && state !== "error" && tries < 40) {
    await new Promise(r => setTimeout(r, 3000));
    const d = await api("GET", `${API}/sites/${SITE}/deploys/${dep.id}`);
    state = d.state; tries++;
    if (tries % 5 === 0) console.log("state:", state);
  }
  console.log("FINAL_STATE:", state, "DEPLOY_ID:", dep.id);
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
