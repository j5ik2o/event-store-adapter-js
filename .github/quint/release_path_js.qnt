// -*- mode: Bluespec; -*-
// js（#1161）の instance。release_path.qnt は j5ik2o/event-store-adapter-rs の bde9f7f のものを一字一句そのまま写し、
// js の分はこのファイルに置く（写したファイルは sha256 で照合できる。README）。
//
// 時間の1刻みは60秒（確認の1回を60秒と数える）。jsBefore1161（release_path.qnt）は10秒刻みで、刻みが違う。
// - CONFIRM_ATTEMPTS = 10：確認の待ちの上限（600秒）。実物の上限 900 秒より短い。待ちが長いほど時間切れは減るので、
//   この上限で時間切れにならなければ、実物でもならない
// - MAX_DELAY = 9：反映の遅れの上限（540秒）。v5.3.0 の実測の元のサーバーの遅れ約190秒に、npm の CDN のキャッシュ
//   （max-age=300）を足した約490秒を覆う
// release.yml との対応：release ジョブ＝publishJob（公開まで）、confirm ジョブ＝confirmPoll と rerunConfirm、
// github-release ジョブ＝githubRelease（confirm の成功のあとだけ：RELEASE_AFTER_CONFIRM）。
// 事前の確認（npm_before）は、npm が同じ版の再公開を断るので、遅れて「無い」と読んでも二度目は出ない
// （PRECHECK_SEES_DEPLOYMENTS = true）。npm の latest は遅れのある値で（PRECHECK_ACCEPTED_LATEST = false）、
// final_tag_check が最新のタグを確かめる（PRECHECK_LATEST_TAG = true）。

// 直したあとの js の形。safety と neverTimesOutAfterPublished に違反しない見込み
module js {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 10, MAX_DELAY = 9,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = true, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 4
  ).* from "./release_path"
}

// js で、遅れ（12刻み＝720秒）が待ちの上限（10刻み）を超える場合。neverTimesOutAfterPublished が破れる見込み。
// js の検査が空振りでない（時間切れに届く手順の数で流している）ことを示す
module jsShortConfirm {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 10, MAX_DELAY = 12,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = true, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 4
  ).* from "./release_path"
}

// js で、github-release が確認を待たない場合（直す前の needs: release の形）。releaseOnlyAfterConfirmed が破れる見込み
module jsReleaseNotGated {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 10, MAX_DELAY = 9,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 4
  ).* from "./release_path"
}
