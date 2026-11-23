#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""换账户部署前的自检：验证 token 属于哪个账户、额度是否可用、站点是否存在。

用法:
  NETLIFY_TOKEN=<token> python tools/check_account.py
  NETLIFY_TOKEN=<token> NETLIFY_SITE_ID=<site_id> python tools/check_account.py
"""
import urllib.request, urllib.error, json, os, sys

TOKEN = os.environ.get("NETLIFY_TOKEN", "")
SITE = os.environ.get("NETLIFY_SITE_ID", "")
API = "https://api.netlify.com/api/v1"


def req(m, p, d=None, h=None):
    hh = {"Authorization": "Bearer " + TOKEN}
    if h:
        hh.update(h)
    r = urllib.request.Request(API + p, data=d, method=m, headers=hh)
    try:
        with urllib.request.urlopen(r) as resp:
            b = resp.read()
            return resp.status, json.loads(b) if b else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw[:200]


def main():
    if not TOKEN:
        print("ERROR: 请设置 NETLIFY_TOKEN")
        sys.exit(1)
    s, u = req("GET", "/user")
    if s != 200:
        print("token 无效:", s, u)
        sys.exit(2)
    print("账户:", u.get("email"), "| id:", u.get("id"))

    s, accs = req("GET", "/accounts")
    if s == 200 and isinstance(accs, list):
        for a in accs:
            print("团队:", a.get("name"), "| slug:", a.get("slug"),
                  "| credits:", a.get("plan_credits"),
                  "| 周期:", a.get("current_usage_period_start"), "->", a.get("next_usage_period_start"))
            print("   usages_exceeded:", a.get("usages_exceeded"),
                  "| sites_with_usage_exceeded:", a.get("sites_with_usage_exceeded"))

    s, sites = req("GET", "/sites?per_page=100")
    if s == 200:
        print("站点数:", len(sites))
        for x in sites:
            print("  -", x.get("name"), "|", x.get("id"), "|", x.get("url"))
    else:
        print("列站点失败:", s, sites)

    if SITE:
        s, d = req("GET", "/sites/" + SITE)
        print("目标站点:", s, (d or {}).get("name") if isinstance(d, dict) else d)
        # 关键探测：该账户能否创建带清单的 deploy（额度是否阻断）
        s2, d2 = req("POST", "/sites/%s/deploys" % SITE,
                     json.dumps({"files": {"/index.html": "da39a3ee5e6b4b0d3255bfef95601890afd80709"},
                                 "async": True}).encode(),
                     {"Content-Type": "application/json"})
        print("部署能力探测:", s2, str(d2)[:200])
        if s2 == 403:
            print("  -> 额度仍被阻断，需等周期重置或充值")
        elif s2 == 200:
            print("  -> 可以发布（探测用空 deploy 已创建，不影响线上）")
    else:
        print("(未设置 NETLIFY_SITE_ID，跳过站点与部署能力探测)")


if __name__ == "__main__":
    main()
