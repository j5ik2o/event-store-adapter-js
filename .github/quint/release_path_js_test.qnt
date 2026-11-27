// -*- mode: Bluespec; -*-
// js（#1161）の決まった手順の経路。release_path_test.qnt（rs の bde9f7f の写し）は変えず、js の分はこのファイルに置く。
// 実行: quint test release_path_js_test.qnt --main=jsPathsTest

// js：npm は受け付け＝公開。公開のあとの確認は別のジョブ（confirm）。GitHub のリリースは確認のあと（RELEASE_AFTER_CONFIRM）。
// 1刻みは60秒、確認の上限は10刻み（release_path_js.qnt の js と同じ）。遅れは publishJobAt の d で決める。
// 遅れが上限を超える経路（時間切れ）を作れるように、MAX_DELAY は jsShortConfirm と同じ 12 にする。事前の確認が公開済みの
// 版を見落とす経路（jsRepublishRefusedTest）を作れるように、PRECHECK_SEES_DEPLOYMENTS は jsPrecheckMisses と同じ false にする
module jsPathsTest {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = false, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 10, MAX_DELAY = 12,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = true, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).* from "./release_path"

  // 版上げの PR（PR 0）をマージして、コミット 2（版 2）にタグを打つ
  action taggedRelease: bool =
    init.then(openReleasePR(2)).then(mergePR(0, 0)).then(tagJob(2))

  // 遅れ 9 刻み（540秒）：9回目の確認で見え、上限（10回）の前に確かめ終わる → リリース
  run jsDelayWithinTheWaitTest =
    taggedRelease
      .then(publishJobAt(2, false, 0, 9))
      .then(8.reps(_ => confirmPoll(2)))
      .expect(s.published.contains(2) and s.confirm.get(2).status == Waiting)
      .then(confirmPoll(2))
      .expect(s.confirm.get(2).status == Confirmed and timeoutOnlyBeyondBudget)
      .then(githubRelease(2))
      .expect(s.releases.contains(2) and s.publishOrder == [2] and safety)

  // 公開のジョブが成功し（jobOk）、確認がまだ待ちのあいだは、リリースを作らない（I17）
  run jsReleaseBeforeConfirmRefusedTest =
    taggedRelease
      .then(publishJobAt(2, false, 0, 9))
      .then(8.reps(_ => confirmPoll(2)))
      .expect(s.jobOk.contains(2) and s.confirm.get(2).status == Waiting)
      .then(githubRelease(2).fail())

  // 遅れ 12 刻みが上限（10回）を超える → 時間切れ → 確認だけを再実行 → 見える → リリース。公開は1回だけ
  run jsTimeoutThenRerunConfirmTest =
    taggedRelease
      .then(publishJobAt(2, false, 0, 12))
      .then(10.reps(_ => confirmPoll(2)))
      .expect(s.confirm.get(2).status == TimedOut and s.published.contains(2) and timeoutOnlyBeyondBudget and safety)
      .then(rerunConfirm(2))
      .then(confirmPoll(2))
      .expect(s.confirm.get(2).status == Waiting)
      .then(confirmPoll(2))
      .expect(s.confirm.get(2).status == Confirmed)
      .then(githubRelease(2))
      .expect(s.releases.contains(2) and s.publishOrder == [2] and s.duplicateAttempts == 0 and safety)

  // jsTimeoutThenRerunConfirmTest の途中（時間切れ）で、リリースを作らない
  run jsTimeoutRefusedTest =
    taggedRelease
      .then(publishJobAt(2, false, 0, 12))
      .then(10.reps(_ => confirmPoll(2)))
      .expect(s.confirm.get(2).status == TimedOut)
      .then(githubRelease(2).fail())

  // 公開のあとでジョブが落ち（failAfterSubmit）、再実行の事前の確認が遅れで版を「無い」と読んで公開を試みる。npm が断るので
  // 二度目の公開は起きない（試みは duplicateAttempts に数え、公開は publishOrder に1回だけ）。断られたジョブは失敗で終わる
  run jsRepublishRefusedTest =
    taggedRelease
      .then(publishJobAt(2, true, 0, 9))
      .expect(s.published.contains(2) and s.publishFailed.contains(2) and not(s.jobOk.contains(2)))
      .then(rerunPublishJob(2))
      .then(publishJobAt(2, true, 0, 9))
      .expect(s.publishOrder == [2] and s.duplicateAttempts == 1 and s.publishFailed.contains(2) and publishedMonotonic)

  // 2つの版を続けて出す
  run jsTwoReleasesTest =
    taggedRelease
      .then(publishJobAt(2, false, 0, 0))
      .then(confirmPoll(2))
      .then(githubRelease(2))
      .then(openReleasePR(3))
      .then(mergePR(1, 0))
      .then(tagJob(3))
      .then(publishJobAt(3, false, 0, 0))
      .then(confirmPoll(3))
      .then(githubRelease(3))
      .expect(s.publishOrder == [2, 3] and s.releases.contains(3) and s.duplicateAttempts == 0 and safety)
}
