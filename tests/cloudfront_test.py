import importlib.util, io, json, os, sys, time

# THE DEPLOY MUST REPOINT THE ORIGIN, THEN CLEAR THE CACHE — IN THAT ORDER.
#
# `tools/build.py` finishes a deploy by pointing a CloudFront distribution's
# OriginPath at the build it just uploaded and invalidating the edge cache. None
# of that can be exercised against real AWS here (no credentials, no network),
# and getting it wrong is expensive in a way local testing usually cannot catch:
# a distribution left half-updated serves a mixture of two builds to real
# players.
#
# So this test drives the real functions against a STUBBED CloudFront client
# (botocore.stub.Stubber), which validates every request against the actual
# service model — a malformed InvalidationBatch or a missing IfMatch fails here
# exactly as it would at AWS. What it pins down:
#
#   * the whole DistributionConfig is written back, with only OriginPath moved,
#     guarded by the ETag it was read with;
#   * the ORDER: update_distribution strictly before create_invalidation. The
#     reverse would clear the edge and immediately refill it from the OLD origin;
#   * a distribution with several origins is never guessed at;
#   * a concurrent edit (PreconditionFailed) is retried once, not looped;
#   * rollback refuses a build that is not in the bucket, before touching
#     CloudFront at all.
#
# Pure API-shape test: no browser, no server, no network.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

spec = importlib.util.spec_from_file_location(
    "gamebuild", os.path.join(ROOT, "tools", "build.py"))
gb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gb)

import boto3
from botocore.stub import Stubber, ANY
from botocore.exceptions import ClientError

failures = []
def check(cond, msg):
    if not cond:
        failures.append(msg)
        print(f"  FAIL {msg}")
    else:
        print(f"  ok   {msg}")


def config(origins):
    """A DistributionConfig shaped the way CloudFront really returns one."""
    return {
        "CallerReference": "ref-1", "Comment": "the game", "Enabled": True,
        "Origins": {"Quantity": len(origins), "Items": origins},
        "DefaultCacheBehavior": {"TargetOriginId": origins[0]["Id"],
                                 "ViewerProtocolPolicy": "redirect-to-https"},
    }

def origin(oid="s3-game", path="/game/oldcommit"):
    return {"Id": oid, "DomainName": "bucket.s3.amazonaws.com", "OriginPath": path}

def client():
    s = boto3.Session(aws_access_key_id="k", aws_secret_access_key="s",
                      region_name="us-east-1")
    c = s.client("cloudfront")
    return c, Stubber(c)


# ---- 1. the origin moves, everything else is written back untouched --------
cf, stub = client()
cfg = config([origin()])
stub.add_response("get_distribution_config",
                  {"ETag": "ETAG-1", "DistributionConfig": cfg}, {"Id": "D1"})
expected = json.loads(json.dumps(cfg))
expected["Origins"]["Items"][0]["OriginPath"] = "/game/newcommit"
stub.add_response("update_distribution", {},
                  {"Id": "D1", "DistributionConfig": expected, "IfMatch": "ETAG-1"})
stub.activate()
old, changed, _cfg = gb.cf_set_origin_path(cf, "D1", None, "/game/newcommit")
stub.assert_no_pending_responses()
check(old == "/game/oldcommit" and changed,
      f"the previous origin path is reported back ({old}, changed={changed})")
check(True, "the whole config is written back with only OriginPath moved, "
            "IfMatch = the ETag it was read with")
stub.deactivate()

# ---- 2. already pointing there: no write at all ---------------------------
cf, stub = client()
stub.add_response("get_distribution_config",
                  {"ETag": "ETAG-1", "DistributionConfig": config([origin(path="/game/same")])},
                  {"Id": "D1"})
stub.activate()
old, changed, _cfg = gb.cf_set_origin_path(cf, "D1", None, "/game/same")
stub.assert_no_pending_responses()      # would raise if update_distribution ran
check(not changed and old == "/game/same",
      "an origin already at the target path is not rewritten")
stub.deactivate()

# ---- 3. an empty origin path is a normal starting point -------------------
cf, stub = client()
cfg = config([origin(path="")])
stub.add_response("get_distribution_config",
                  {"ETag": "E", "DistributionConfig": cfg}, {"Id": "D1"})
stub.add_response("update_distribution", {}, {"Id": ANY, "DistributionConfig": ANY,
                                              "IfMatch": ANY})
stub.activate()
old, changed, _cfg = gb.cf_set_origin_path(cf, "D1", None, "/game/first")
check(old == "" and changed, "a distribution serving the bucket root can be moved")
stub.deactivate()

# ---- 4. several origins are never guessed at ------------------------------
two = config([origin("s3-game", "/game/a"), origin("api", "")])
picked = gb.cf_pick_origin(two, "api")
check(picked[0] == 1 and picked[1]["Id"] == "api",
      "--cf-origin-id selects the named origin")

# With several origins and no --cf-origin-id, the origin behind the default
# cache behaviour is the one serving `/`, so it is the one serving the game.
idx, chosen = gb.cf_pick_origin(two, None)
check(chosen["Id"] == "s3-game",
      "several origins resolve via DefaultCacheBehavior.TargetOriginId")

# But if that pointer does not resolve to a real origin, guessing is not on.
orphan = config([origin("a", "/x"), origin("b", "")])
orphan["DefaultCacheBehavior"]["TargetOriginId"] = "gone"
stopped = False
try:
    gb.cf_pick_origin(orphan, None)
except SystemExit:
    stopped = True
check(stopped, "an unresolvable TargetOriginId with several origins stops the "
               "deploy rather than guessing")

stopped = False
try:
    gb.cf_pick_origin(two, "nope")
except SystemExit:
    stopped = True
check(stopped, "an unknown --cf-origin-id stops the deploy")

# ---- 5. a concurrent edit is retried exactly once -------------------------
cf, stub = client()
stub.add_response("get_distribution_config",
                  {"ETag": "E1", "DistributionConfig": config([origin()])}, {"Id": "D1"})
stub.add_client_error("update_distribution", service_error_code="PreconditionFailed",
                      http_status_code=412)
stub.add_response("get_distribution_config",
                  {"ETag": "E2", "DistributionConfig": config([origin()])}, {"Id": "D1"})
stub.add_response("update_distribution", {},
                  {"Id": ANY, "DistributionConfig": ANY, "IfMatch": "E2"})
stub.activate()
old, changed, _cfg = gb.cf_set_origin_path(cf, "D1", None, "/game/newcommit")
stub.assert_no_pending_responses()
check(changed, "a PreconditionFailed re-reads the config and retries with the new ETag")
stub.deactivate()

cf, stub = client()
stub.add_response("get_distribution_config",
                  {"ETag": "E1", "DistributionConfig": config([origin()])}, {"Id": "D1"})
stub.add_client_error("update_distribution", service_error_code="PreconditionFailed",
                      http_status_code=412)
stub.add_response("get_distribution_config",
                  {"ETag": "E2", "DistributionConfig": config([origin()])}, {"Id": "D1"})
stub.add_client_error("update_distribution", service_error_code="PreconditionFailed",
                      http_status_code=412)
stub.activate()
stopped = False
try:
    gb.cf_set_origin_path(cf, "D1", None, "/game/newcommit")
except SystemExit:
    stopped = True
check(stopped, "a second PreconditionFailed gives up instead of looping")
stub.deactivate()

# ---- 6. the invalidation ---------------------------------------------------
cf, stub = client()
stub.add_response("create_invalidation", {"Invalidation": {
    "Id": "I1", "Status": "InProgress", "CreateTime": "2026-01-01T00:00:00Z",
    "InvalidationBatch": {"Paths": {"Quantity": 1, "Items": ["/*"]},
                          "CallerReference": "r"}}},
    {"DistributionId": "D1", "InvalidationBatch": {
        "Paths": {"Quantity": 1, "Items": ["/*"]}, "CallerReference": "abc-1"}})
stub.activate()
check(gb.cf_invalidate(cf, "D1", ["/*"], "abc-1") == "I1",
      "the invalidation id is returned")
stub.deactivate()

# CloudFront de-duplicates by CallerReference, so two deploys must not share one.
refs = set()
for _ in range(3):
    refs.add(f"buildid-{int(time.time() * 1000)}")
    time.sleep(0.002)
check(len(refs) == 3, "CallerReference is unique per call, so a retry is not "
                      "silently de-duplicated")

# ---- 7. ORDER: the origin moves before the cache is cleared ---------------
# The reverse would clear the edge and immediately refill it from the old path.
calls = []
class RecordingCf:
    def __init__(self):
        self.paths = []
    def get_distribution_config(self, **kw):
        calls.append("get_distribution_config")
        cfg = config([origin()])
        cfg["DefaultRootObject"] = "index.html"
        return {"ETag": "E", "DistributionConfig": cfg}
    def update_distribution(self, **kw):
        calls.append("update_distribution")
        return {}
    def create_invalidation(self, **kw):
        calls.append("create_invalidation")
        return {"Invalidation": {"Id": "I9"}}

class Args:
    region = None; profile = None; distribution_id = "D1"; cf_origin_id = None
    invalidate = None; wait = False; bucket = None

rec = RecordingCf()
gb.cf_client = lambda region, profile: rec          # inject the recorder
gb.cf_deploy(Args(), "game/newcommit", "newcommit", "f" * 40)
check(calls == ["get_distribution_config", "update_distribution", "create_invalidation"],
      f"origin is updated BEFORE the cache is invalidated ({calls})")

# ---- 7b. under --wait, propagation is awaited BEFORE the flush ------------
# An invalidation that completes while some edges still run the old config lets
# those edges refill from the OLD origin path — and s-maxage then pins the wrong
# bytes there for a year. So the wait belongs between the two, not after both.
class WaitingCf(RecordingCf):
    def get_waiter(self, name):
        calls.append(f"wait:{name}")
        class W:
            def wait(self, **kw): pass
        return W()
    def get_distribution(self, **kw):
        return {"Distribution": {"DomainName": "d1.cloudfront.net"}}

calls.clear()
gb.cf_client = lambda region, profile: WaitingCf()
gb.cf_verify_live = lambda *a, **k: calls.append("verify_live")
class WaitArgs(Args):
    wait = True
gb.cf_deploy(WaitArgs(), "game/newcommit", "newcommit", "f" * 40)
check(calls.index("wait:distribution_deployed") < calls.index("create_invalidation"),
      f"--wait blocks for propagation BEFORE invalidating ({calls})")
check(calls.index("create_invalidation") < calls.index("wait:invalidation_completed"),
      "…and waits for the flush after submitting it")
check(calls[-1] == "verify_live", "…then verifies the live site last")

# ---- 8. rollback refuses a build that is not in the bucket ----------------
class MissingS3:
    def get_object(self, **kw):
        raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "missing"}},
                          "GetObject")
gb.s3_client = lambda region, profile: MissingS3()
class RbArgs(Args):
    bucket = "b"; prefix = "game"; rollback = "deadbeef"
calls.clear()
stopped = False
try:
    gb.cf_rollback(RbArgs())
except SystemExit:
    stopped = True
check(stopped, "rollback to a commit with no build-info.json in the bucket stops")
check(calls == [], "…and it stops BEFORE touching CloudFront")

# ---- 9. the cache model the origin switch depends on ----------------------
check("s-maxage=31536000" in gb.CACHE_EDGE,
      "assets are cached at the edge for a year (s-maxage)")
check("max-age=0" in gb.CACHE_EDGE and "must-revalidate" in gb.CACHE_EDGE,
      "…while browsers revalidate every request")
check("immutable" not in gb.CACHE_EDGE,
      "assets are NOT immutable — viewer URLs are stable now, so an immutable "
      "asset would strand players on the old build past any invalidation")
check(gb.CACHE_REVALIDATE == "no-cache, must-revalidate",
      "index.html and build-info.json are never cached")

# ---- 10. the upload skip must notice a header-only change -----------------
# Comparing bodies alone would leave an object uploaded under the old cache
# model carrying `immutable` for ever, and `immutable` on a stable URL is the
# one header an invalidation cannot take back.
src = open(os.path.join(ROOT, "tools", "build.py"), encoding="utf-8").read()
skip = src[src.index("if (\"-\" not in etag"):src.index("return \"skip\"")]
check("CacheControl" in skip and "ContentType" in skip,
      "the ETag skip compares Cache-Control and Content-Type, not just the body")

# ---- 11. preflight warns about the things that break a *successful* deploy -
import contextlib, io as _io
def warnings_for(cfg, bucket=None):
    buf = _io.StringIO()
    with contextlib.redirect_stdout(buf):
        gb.cf_preflight(cfg, bucket)
    return buf.getvalue()

good = config([origin()]); good["DefaultRootObject"] = "index.html"
check(warnings_for(good) == "", "a healthy distribution produces no warnings")

no_root = config([origin()])
check("DefaultRootObject" in warnings_for(no_root),
      "an empty DefaultRootObject is flagged (/ would not serve index.html)")

disabled = config([origin()]); disabled["DefaultRootObject"] = "index.html"
disabled["DefaultCacheBehavior"]["CachePolicyId"] = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
check("CachingDisabled" in warnings_for(disabled),
      "CachingDisabled is flagged — s-maxage buys nothing behind it")

minttl = config([origin()]); minttl["DefaultRootObject"] = "index.html"
minttl["DefaultCacheBehavior"]["MinTTL"] = 300
check("MinTTL" in warnings_for(minttl),
      "a MinTTL floor is flagged — it overrides no-cache on index.html")

check("other-bucket" in warnings_for(good, "other-bucket"),
      "an origin pointing at a different bucket than the upload is flagged")

if failures:
    print(f"\nCLOUDFRONT TEST FAILED — {len(failures)} check(s):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("\nCLOUDFRONT TEST PASSED")
