#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""可复用的 Netlify 部署器（Python 3.8 兼容）
用法:
  python tools/deploy.py                 # 部署 public/ + netlify/functions/（esbuild 打包 snapshot）
  python tools/deploy.py --probe NAME    # 只部署一个探针函数（内容在 tools/probes/NAME.js）
  python tools/deploy.py --zisi          # 用 Netlify 官方 zip-it-and-ship-it 打包

账户切换：
  默认使用内置 SITE/TOKEN（旧账户）。换账户时用环境变量覆盖，无需改代码：
    NETLIFY_SITE_ID=<site_id> NETLIFY_TOKEN=<token> python tools/deploy.py
  纯命令行（Git Bash / Windows）也可：
    set NETLIFY_TOKEN=xxx && set NETLIFY_SITE_ID=yyy && python tools/deploy.py
  Netlify API 只认 Personal Access Token（nfp_ 开头）或 OAuth token，
  不接受邮箱+密码；在 app.netlify.com → User settings → Applications →
  Personal access tokens 生成。
"""
import hashlib, json, time, urllib.request, zipfile, os, io, subprocess, datetime, re, sys

SITE = os.environ.get("NETLIFY_SITE_ID") or "9417d3e3-33c7-4b65-9b4c-b86ab4eb9438"
TOKEN = os.environ.get("NETLIFY_TOKEN") or "nfc_VFhRuT8773JQsRAiGWJbMcJ9gYjyTKP227fd"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, "public")
FNS = os.path.join(ROOT, "netlify", "functions")
BUILD_DIR = os.path.join(ROOT, ".build")
API = "https://api.netlify.com/api/v1"

# cron 按 UTC 解释："45 9 * * 1-5" = 09:45 UTC = 17:45 Asia/Shanghai（工作日）
# 只能挂在 snapcron（纯写入）上：Netlify scheduled function 没有公共 HTTP URL，
# 挂在 snapshot（前端要读）上会导致直连 403。
SCHEDULE_NAME = "snapcron"
SCHEDULES = [{"name": SCHEDULE_NAME, "cron": "45 9 * * 1-5"}]


def req(method, path, data=None, headers=None):
    h = {"Authorization": "Bearer " + TOKEN}
    if headers:
        h.update(headers)
    r = urllib.request.Request(API + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r) as resp:
            body = resp.read()
            return resp.status, json.loads(body) if body else None
    except urllib.error.HTTPError as e:
        raise RuntimeError("%s %s -> %s %s" % (method, path, e.code, e.read().decode()[:300]))


def sha(data, algo):
    return hashlib.new(algo, data).hexdigest()


def esbuild(entry, out):
    exe = os.path.join(ROOT, "node_modules", "@esbuild", "win32-x64", "esbuild.exe")
    if not os.path.exists(exe):
        exe = os.path.join(ROOT, "node_modules", ".bin", "esbuild")
    cmd = [exe, entry, "--bundle", "--platform=node", "--target=node18",
           "--format=cjs", "--outfile=" + out]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        print("esbuild failed:", p.stdout, p.stderr)
        sys.exit(1)
    print("bundled %s -> %d bytes" % (os.path.basename(entry), os.path.getsize(out)))
    return out


def zisi_build():
    """用 Netlify 官方 zip-it-and-ship-it 打包，返回 {name: zipbytes}"""
    outdir = os.path.join(BUILD_DIR, "zisi")
    if os.path.isdir(outdir):
        import shutil
        shutil.rmtree(outdir)
    os.makedirs(outdir, exist_ok=True)
    exe = os.path.join(ROOT, "node_modules", ".bin", "zip-it-and-ship-it")
    p = subprocess.run([exe, FNS, outdir], capture_output=True, text=True)
    if p.returncode != 0:
        print("zisi failed:", p.stdout[-2000:], p.stderr[-2000:])
        sys.exit(1)
    manifest = json.load(open(os.path.join(outdir, "manifest.json"), encoding="utf-8"))
    out = {}
    for f in manifest.get("functions", []):
        zp = os.path.join(outdir, f["name"] + ".zip")
        if os.path.exists(zp):
            out[f["name"]] = open(zp, "rb").read()
    return out


def main():
    args = sys.argv[1:]
    BUILD = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    os.makedirs(BUILD_DIR, exist_ok=True)

    fn_zips = {}

    if "--probe" in args:
        name = args[args.index("--probe") + 1]
        src = open(os.path.join(ROOT, "tools", "probes", name + ".js"), encoding="utf-8").read()
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(name + ".js", src.encode("utf-8"))
        fn_zips[name] = buf.getvalue()
        print("probe:", name)

    elif "--zisi" in args:
        fn_zips = zisi_build()
        print("zisi functions:", {k: len(v) for k, v in fn_zips.items()})

    else:
        # 默认：esbuild 打包 snapshot，其余函数原样上传
        for f in sorted(os.listdir(FNS)):
            if not f.endswith(".js"):
                continue
            name = f[:-3]
            if name.startswith("_"):
                continue  # 下划线开头 = 共享模块，不作为独立函数
            path = os.path.join(FNS, f)
            # 任何 require 了 @netlify/* 或 ../../lib/* 的函数都需要 bundle
            # （Deploy API 绕过 Netlify 构建，不会自动打包 node_modules）
            src_raw = open(path, encoding="utf-8").read()
            needs_bundle = ("require('@netlify/" in src_raw) or ('require("@netlify/' in src_raw) \
                or ("../../lib/" in src_raw) or ("@netlify/blobs" in src_raw)
            if needs_bundle:
                out = esbuild(path, os.path.join(BUILD_DIR, name + ".js"))
                src = open(out, encoding="utf-8").read()
            else:
                src = src_raw
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
    print("functions:", {k: len(v) for k, v in fn_zips.items()})
    print("schedules:", SCHEDULES)

    payload = {"files": files, "functions": funcs, "async": True}
    # schedule 必须与本次上传的函数名匹配，否则 API 返回 422
    uploaded = set(funcs.keys())
    # --sched NAME 可指定把 schedule 挂到别的函数上（做对照实验）
    sched_name = None
    if "--sched" in args:
        sched_name = args[args.index("--sched") + 1]
    else:
        sched_name = SCHEDULE_NAME
    sched = [{"name": sched_name, "cron": "45 9 * * 1-5"}] if sched_name in uploaded else []
    if sched:
        payload["function_schedules"] = sched
        print("schedules:", sched)
    else:
        print("WARN: 无函数匹配 schedule，本次不带 function_schedules")
    st, dep = req("POST", "/sites/%s/deploys" % SITE,
                  json.dumps(payload).encode(), {"Content-Type": "application/json"})
    did = dep["id"]
    print("deploy:", did, dep.get("state"))

    required = set(dep.get("required") or [])
    req_fns = set(dep.get("required_functions") or [])
    for _ in range(10):
        if dep.get("state") != "preparing":
            break
        time.sleep(2)
        st, dep = req("GET", "/sites/%s/deploys/%s" % (SITE, did))
        required = set(dep.get("required") or [])
        req_fns = set(dep.get("required_functions") or [])

    for site_path, s1 in files.items():
        if required and s1 in required:
            req("PUT", "/deploys/%s/files%s" % (did, site_path),
                open(os.path.join(PUB, site_path.lstrip("/").replace("/", os.sep)), "rb").read(),
                {"Content-Type": "application/octet-stream"})
            print("uploaded file:", site_path)

    for name, z in fn_zips.items():
        if req_fns and funcs[name] not in req_fns:
            print("skip fn (not required):", name)
            continue
        for attempt in range(4):
            try:
                req("PUT", "/deploys/%s/functions/%s?runtime=js" % (did, name), z,
                    {"Content-Type": "application/zip"})
                print("uploaded function:", name, len(z), "bytes")
                break
            except RuntimeError as e:
                if attempt == 3:
                    raise
                print("retry %s (attempt %d): %s" % (name, attempt + 1, str(e)[:120]))
                time.sleep(6)

    for i in range(40):
        st, dep = req("GET", "/sites/%s/deploys/%s" % (SITE, did))
        if dep.get("state") in ("ready", "error"):
            break
        time.sleep(3)
    print("FINAL:", dep.get("state"), did)

    try:
        st, site = req("GET", "/sites/%s" % SITE)
        st2, fdefs = req("GET", "/sites/%s/functions" % SITE)
        for f in fdefs.get("functions", []):
            print("  fn %-10s schedule=%s" % (f.get("n"), f.get("schedule")))
        st3, dl = req("GET", "/sites/%s/deploys?per_page=1" % SITE)
        print("  function_schedules:", json.dumps(dl[0].get("function_schedules"), ensure_ascii=False))
    except Exception as e:
        print("verify failed:", e)


if __name__ == "__main__":
    main()
