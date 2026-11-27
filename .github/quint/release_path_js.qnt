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
// 事前の確認（npm_before の npm view）は遅れのある値を読むので、公開済みの版を「無い」と見落とし、公開を試みうる。npm は
// その再公開を断る。js・jsShortConfirm・jsReleaseNotGated は見落とさない前提（PRECHECK_SEES_DEPLOYMENTS = true）で
// safety を確かめ、見落とす経路は jsPrecheckMisses が確かめる（#1163 の Devin と CodeRabbit の指摘）。
// npm の latest は遅れのある値で（PRECHECK_ACCEPTED_LATEST = false）、final_tag_check が最新のタグを確かめる
// （PRECHECK_LATEST_TAG = true）。

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

// js で、確認のゲートを外し、github-release が confirm を待たない形（わざと外した負例）。releaseOnlyAfterConfirmed が
// 破れる見込み。直す前の needs: release の形ではない（直す前は、release の中の npm_after が時間切れになると release が
// 失敗し、github-release は動かなかった。直す前の待ちの上限は jsBefore1161 が表す）
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

// js で、事前の確認が遅れで公開済みの版を「無い」と見落とす形（PRECHECK_SEES_DEPLOYMENTS = false）。公開のあとでジョブが
// 落ち（failAfterSubmit）、再実行の事前の確認が見落とすと、公開を試みる。npm はその再公開を断る。モデルでは submit が、
// 処理中・公開済みの版を出さずに duplicateAttempts に数える形が、その拒否にあたる。
// - publishedMonotonic（同じ版は二度公開されない）に違反しない見込み
// - noDuplicatePublish（I4：公開先の拒否に頼らない）は破れる見込み。見落とす経路が検査に入っていることを示す
// safety の残りは、この形では確かめない。写しのモデルでは、断られた試みのあとジョブが成功のように終わり（失敗にならない）、
// publishedReleaseRecoverable が破れる。実物では npm が断ってジョブが失敗し、再実行は npm_before が止める。回復は手の手順
// （CONTRIBUTING の「release ジョブが publish かそのあとで失敗した」）。拒否でジョブが落ちる形を表すには、写しのモデルに
// 定数が要る（上流の rs で足してから写す）
module jsPrecheckMisses {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = false, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 10, MAX_DELAY = 9,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = true, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 4
  ).* from "./release_path"
}
