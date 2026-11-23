# Netlify full deploy: files (sha1) + functions (sha256 of zip)
# 关键点：
#   1) snapshot.js / snapcron.js 依赖 @netlify/blobs 与 ../../lib/* → 用 esbuild 打成单文件再 zip
#   2) 站点无 Git 集成 → netlify.toml 的 [functions.x] schedule 不会被解析，
#      必须通过 Deploy API 请求体的 function_schedules 字段注册定时任务
#   3) schedule 只能挂在 snapcron（纯写入）上：
#      Netlify scheduled function 没有公共 HTTP URL，带 schedule 的函数直连必 403，
#      而前端要通过 /.netlify/functions/snapshot 读取快照。
import hashlib, json, time, urllib.request, zipfile, os, io, subprocess, datetime, re, sys

SITE = "9417d3e3-33c7-4b65-9b4c-b86ab4eb9438"
TOKEN = "nfc_VFhRuT8773JQsRAiGWJbMcJ9gYjyTKP227fd"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, "public")
FNS = os.path.join(ROOT, "netlify", "functions")
BUILD_DIR = os.path.join(ROOT, ".build")
API = f"https://api.netlify.com/api/v1"

# 定时任务：cron 按 UTC 解释。"45 9 * * 1-5" = 09:45 UTC = 17:45 Asia/Shanghai（工作日）
SCHEDULES = [{"name": "snapcron", "cron": "45 9 * * 1-5"}]

def req(method, path, data=None, headers=None):
    h = {"Authorization": "Bearer " + TOKEN}
    if headers: h.update(headers)
    r = urllib.request.Request(API + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r) as resp:
            body = resp.read()
            return resp.status, json.loads(body) if body else None
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} -> {e.code} {e.read().decode()[:300]}")

def sha(data, algo):
    return hashlib.new(algo, data).hexdigest()

BUILD = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
os.makedirs(BUILD_DIR, exist_ok=True)

# ---------- 1) 需要 bundle 的函数（esbuild 单文件打包） ----------
BUNDLE_FNS = {
    "snapshot": os.path.join(FNS, "snapshot.js"),
    "snapcron": os.path.join(FNS, "snapcron.js"),
}

def bundle(name, entry):
    out = os.path.join(BUILD_DIR, f"{name}.js")
    exe = os.path.join(ROOT, "node_modules", "@esbuild", "win32-x64", "esbuild.exe")
    if not os.path.exists(exe):
        exe = os.path.join(ROOT, "node_modules", ".bin", "esbuild")
    cmd = [exe, entry, "--bundle", "--platform=node", "--target=node18",
           "--format=cjs", "--outfile=" + out]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        print("esbuild failed:", p.stdout, p.stderr)
        sys.exit(1)
    print(f"bundled {name}: {os.path.getsize(out)} bytes")
    return open(out, "rb").read()

# ---------- 2) 组装各函数的 zip（js 位于 zip 根目录） ----------
fn_zips = {}
for f in os.listdir(FNS):
    if not f.endswith(".js"): continue
    name = f[:-3]
    if name in BUNDLE_FNS:
        data = bundle(name, BUNDLE_FNS[name])
        src = data.decode("utf-8", "replace")
    else:
        src = open(os.path.join(FNS, f), "r", encoding="utf-8").read()
    # 注入 build stamp，让 hash 每次都是新的（Netlify 靠 hash 判断是否需要重传）
    if "//build:" in src:
        src = re.sub(r"//build:\S+", "//build:" + BUILD, src)
    else:
        src = src.rstrip() + "\n//build:" + BUILD + "\n"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f, src.encode("utf-8"))
    fn_zips[name] = buf.getvalue()

files = {}
for dirpath, _, names in os.walk(PUB):
    for n in names:
        p = os.path.join(dirpath, n)
        site_path = "/" + os.path.relpath(p, PUB).replace("\\", "/")
        files[site_path] = sha(open(p, "rb").read(), "sha1")

funcs = {name: sha(z, "sha256") for name, z in fn_zips.items()}
print("files:", list(files))
print("functions:", {k: v[:16] for k, v in funcs.items()})
print("schedules:", SCHEDULES)

payload = {
    "files": files,
    "functions": funcs,
    "function_schedules": SCHEDULES,
    "async": True,
}
st, dep = req("POST", f"/sites/{SITE}/deploys", json.dumps(payload).encode(), {"Content-Type": "application/json"})
did = dep["id"]
print("deploy:", did, dep.get("state"), "required:", dep.get("required"), "req_fns:", dep.get("required_functions"))

required = set(dep.get("required") or [])
req_fns = set(dep.get("required_functions") or [])
for _ in range(10):
    if dep.get("state") != "preparing": break
    time.sleep(2)
    st, dep = req("GET", f"/sites/{SITE}/deploys/{did}")
    required = set(dep.get("required") or []); req_fns = set(dep.get("required_functions") or [])
print("state:", dep.get("state"), "required:", required, "req_fns:", req_fns)

# upload missing site files
for dirpath, _, names in os.walk(PUB):
    for n in names:
        p = os.path.join(dirpath, n)
        site_path = "/" + os.path.relpath(p, PUB).replace("\\", "/")
        s1 = sha(open(p, "rb").read(), "sha1")
        if required and s1 in required:
            req("PUT", f"/deploys/{did}/files/{site_path}", open(p, "rb").read(), {"Content-Type": "application/octet-stream"})
            print("uploaded file:", site_path)

# upload functions (with retry on transient 429/5xx)
for name, z in fn_zips.items():
    if req_fns and funcs[name] not in req_fns:
        print("skip fn (not required):", name); continue
    for attempt in range(4):
        try:
            req("PUT", f"/deploys/{did}/functions/{name}?runtime=js", z, {"Content-Type": "application/zip"})
            print("uploaded function:", name, len(z), "bytes")
            break
        except RuntimeError as e:
            if attempt == 3: raise
            print(f"retry {name} (attempt {attempt+1}): {str(e)[:120]}")
            time.sleep(6)

# poll ready
state = dep.get("state")
for i in range(40):
    st, dep = req("GET", f"/sites/{SITE}/deploys/{did}")
    state = dep.get("state")
    if state in ("ready", "error"): break
    time.sleep(3)
print("FINAL:", state, did)

# ---------- 3) 校验定时任务是否注册成功 ----------
try:
    st, site = req("GET", f"/sites/{SITE}")
    print("available_functions:", site.get("available_functions"))
    print("function_schedules:", site.get("function_schedules"))
except Exception as e:
    print("verify schedules failed:", e)
