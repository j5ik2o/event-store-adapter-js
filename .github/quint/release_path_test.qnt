// -*- mode: Bluespec; -*-
// release_path.qnt の、決まった手順の経路（設計レビュー D1）。
// 反映の遅れを 0 にして、手順の結果が1つに決まるインスタンスで流す。
// 実行: quint test release_path_test.qnt --main=javaPathsTest   と   --main=kotlinPathsTest

// java：Central は2段（受け付け → PUBLISHED／FAILED）。確認の上限は 2 回
module javaPathsTest {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 6, CONFIRM_ATTEMPTS = 2, MAX_DELAY = 0,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).* from "./release_path"

  // 版上げの PR（PR 0）をマージすると、コミット 2 ができる
  action mergedRelease(delay: int): bool =
    init.then(openReleasePR(2)).then(mergePR(0, delay))

  // 正常の経路：PR → マージ → タグ → 公開 → PUBLISHED → 確認 → リリース
  run happyPathTest =
    mergedRelease(0)
      .then(tagJob(2))
      .expect(s.tags.get(2) == 2 and s.publishPending.contains(2))
      .then(publishJob(2, false))
      .expect(deployOf(s, 2) == Processing)
      .expect(deployOf(s, 2) != Published)    // githubRelease の条件（PUBLISHED）を満たさない＝リリースを作らない
      .then(portalResolve(2, true))
      .then(confirmPoll(2))
      .expect(s.confirm.get(2).status == Confirmed)
      .then(githubRelease(2))
      .expect(s.releases.contains(2) and safety)

  // 照会の空振り → 使い切って失敗 → 再実行 → タグ
  run lookupRetryTest =
    mergedRelease(6)
      .then(5.reps(_ => tagJob(2)))
      .expect(s.tagFailed.contains(2) and not(s.tags.keys().contains(2)))
      .then(rerunTagJob(2))
      .then(tagJob(2))
      .expect(s.tags.get(2) == 2 and safety)

  // 待ちの手順が処理中のまま時間切れ → 公開のジョブが失敗（確認だけの再実行は無い）→ PUBLISHED → 公開のジョブを再実行 →
  // precheck が published と読んで上げずに成功 → 確認とリリース（#934 の CodeRabbit の指摘）
  run timeoutThenConfirmTest =
    mergedRelease(0)
      .then(tagJob(2))
      .then(publishJob(2, false))
      .then(confirmPoll(2))
      .then(confirmPoll(2))
      .expect(s.publishFailed.contains(2) and not(s.confirm.keys().contains(2)) and deployOf(s, 2) == Processing)
      .then(portalResolve(2, true))
      .then(rerunPublishJob(2))
      .then(resumePublishJob(2))
      .then(confirmPoll(2))
      .expect(s.confirm.get(2).status == Confirmed and s.jobOk.contains(2))
      .then(githubRelease(2))
      .expect(s.releases.contains(2) and s.duplicateAttempts == 0 and safety)

  // timeoutThenConfirmTest の途中で、rerunConfirm が動かないこと
  run timeoutThenConfirmRefused1Test =
    mergedRelease(0)
      .then(tagJob(2))
      .then(publishJob(2, false))
      .then(confirmPoll(2))
      .then(confirmPoll(2))
      .expect(s.publishFailed.contains(2) and not(s.confirm.keys().contains(2)) and deployOf(s, 2) == Processing)
      .then(rerunConfirm(2).fail())

  // timeoutThenConfirmTest の途中で、githubRelease が動かないこと
  run timeoutThenConfirmRefused2Test =
    mergedRelease(0)
      .then(tagJob(2))
      .then(publishJob(2, false))
      .then(confirmPoll(2))
      .then(confirmPoll(2))
      .expect(s.publishFailed.contains(2) and not(s.confirm.keys().contains(2)) and deployOf(s, 2) == Processing)
      .then(portalResolve(2, true))
      .then(githubRelease(2).fail())

  // FAILED → リリースを作らない → 確認はすぐ失敗 → 公開のジョブを再実行 → PUBLISHED
  run failedThenRepublishTest =
    mergedRelease(0)
      .then(tagJob(2))
      .then(publishJob(2, false))
      .then(portalResolve(2, false))
      .expect(s.publishFailed.contains(2) and deployOf(s, 2) == Failed)
      .expect(deployOf(s, 2) != Published)
      .then(confirmPoll(2))
      .expect(s.confirm.get(2).status == Rejected)
      .then(rerunPublishJob(2))
      .then(publishJob(2, false))
      .expect(deployOf(s, 2) == Processing)
      .then(portalResolve(2, true))
      // 待ちの手順が PUBLISHED を読んで、公開のジョブが成功してから、リリースのジョブが動く
      .then(confirmPoll(2))
      .then(githubRelease(2))
      .expect(s.published.contains(2) and s.releases.contains(2) and s.duplicateAttempts == 0 and safety)

  // failedThenRepublishTest の途中で、githubRelease が動かないこと
  run failedThenRepublishRefused1Test =
    mergedRelease(0)
      .then(tagJob(2))
      .then(publishJob(2, false))
      .then(portalResolve(2, false))
      .expect(s.publishFailed.contains(2) and deployOf(s, 2) == Failed)
      .expect(deployOf(s, 2) != Published)
      .then(confirmPoll(2))
      .expect(s.confirm.get(2).status == Rejected)
      .then(rerunPublishJob(2))
      .then(publishJob(2, false))
      .expect(deployOf(s, 2) == Processing)
      .then(portalResolve(2, true))
      // 待ちの手順が PUBLISHED を読んで、公開のジョブが成功してから、リリースのジョブが動く
      .then(githubRelease(2).fail())

  // 公開の操作のあとでジョブが失敗 → 再実行しても、処理中の deployment があるので二度目は出さない → PUBLISHED
  run jobFailsAfterSubmitTest =
    mergedRelease(0)
      .then(tagJob(2))
      .then(publishJob(2, true))
      .expect(s.publishFailed.contains(2) and deployOf(s, 2) == Processing)
      .then(rerunPublishJob(2))
      .then(publishJob(2, false))
      .expect(s.publishFailed.contains(2) and s.duplicateAttempts == 0)
      .then(portalResolve(2, true))
      .expect(s.published.contains(2) and s.duplicateAttempts == 0 and safety)
      // ジョブは失敗のままなので、リリースはまだ作れない。再実行の precheck が published と読んでから
      .then(rerunPublishJob(2))
      .then(resumePublishJob(2))
      .then(githubRelease(2))
      .expect(s.releases.contains(2) and s.duplicateAttempts == 0 and safety)

  // jobFailsAfterSubmitTest の途中で、githubRelease が動かないこと
  run jobFailsAfterSubmitRefused1Test =
    mergedRelease(0)
      .then(tagJob(2))
      .then(publishJob(2, true))
      .expect(s.publishFailed.contains(2) and deployOf(s, 2) == Processing)
      .then(rerunPublishJob(2))
      .then(publishJob(2, false))
      .expect(s.publishFailed.contains(2) and s.duplicateAttempts == 0)
      .then(portalResolve(2, true))
      .expect(s.published.contains(2) and s.duplicateAttempts == 0 and safety)
      // ジョブは失敗のままなので、リリースはまだ作れない。再実行の precheck が published と読んでから
      .then(githubRelease(2).fail())

  // 2つの版を続けて出す
  run twoReleasesTest =
    mergedRelease(0)
      .then(tagJob(2))
      .then(publishJob(2, false))
      .then(portalResolve(2, true))
      .then(openReleasePR(3))
      .then(mergePR(1, 0))
      .then(tagJob(3))
      .then(publishJob(3, false))
      .then(portalResolve(3, true))
      .expect(s.publishOrder == [2, 3] and safety)

  // 新しい版の公開は、前の版の deployment が処理中のあいだ待つ（追い越さない）
  run noOvertakeWhileProcessingTest =
    mergedRelease(0)
      .then(tagJob(2))
      .then(publishJob(2, false))
      .then(openReleasePR(3))
      .then(mergePR(1, 0))
      .then(tagJob(3))
      .then(publishJob(3, false))
      .expect(s.publishFailed.contains(3) and deployOf(s, 3) == NoDeploy)
      .then(portalResolve(2, true))
      .then(rerunPublishJob(3))
      .then(publishJob(3, false))
      .expect(deployOf(s, 3) == Processing and safety)

  // #863：版 2 のタグのジョブの再実行が、あとから着いて、待っている版 3（main の先頭）のタグのジョブを置き換える
  // → 版 3 はタグが無いまま → 取り消された run を再実行する → 版 2、版 3 の順に出る
  run rerunReplacesHeadTagTest =
    mergedRelease(6)
      .then(5.reps(_ => tagJob(2)))
      .expect(s.tagFailed.contains(2))
      .then(openReleasePR(3))
      .then(mergePR(1, 0))
      .then(rerunTagJob(2))
      .then(cancelPendingTag(3))
      .expect(s.tagSkipped.contains(3) and s.head == 3 and wHeadTagSkipped and safety)
      .then(tagJob(2))
      .then(publishJob(2, false))
      .then(portalResolve(2, true))
      .expect(not(s.tags.keys().contains(3)) and safety)
      .then(rerunCancelledTag(3))
      .then(tagJob(3))
      .then(publishJob(3, false))
      .then(portalResolve(3, true))
      .expect(s.publishOrder == [2, 3] and s.duplicateAttempts == 0 and safety)
}

// kotlin：v5.2.0（版 1）は Central に無い。関門の設定「公開先に必要な版：5.2.0」
module kotlinPathsTest {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(1), REQUIRED_PUBLISHED = Set(1),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 2, MAX_DELAY = 0,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).* from "./release_path"

  // 5.2.0 が出るまで、新しい版のタグは関門で止まる。5.2.0 が出たあと、タグのジョブの再実行で続ける
  run legacyFirstTest =
    init
      .then(openReleasePR(2))
      .then(mergePR(0, 0))
      .then(tagJob(2))
      .expect(s.tagFailed.contains(2) and not(s.tags.keys().contains(2)))
      .then(publishLegacy(1))
      .then(portalResolve(1, true))
      .then(rerunTagJob(2))
      .then(tagJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .then(portalResolve(2, true))
      .expect(s.publishOrder == [1, 2] and safety)

  // 5.2.0 の再実行が FAILED（上限など）→ もう一度再実行できる。処理中のあいだは再実行しない
  run legacyFailedTest =
    init
      .then(publishLegacy(1))
      .expect(inFlightOrDone(s, 1))
      .then(portalResolve(1, false))
      .then(publishLegacy(1))
      .then(portalResolve(1, true))
      .expect(s.published.contains(1) and s.duplicateAttempts == 0 and safety)

  // legacyFailedTest の途中で、publishLegacy が動かないこと（処理中なので、もう一度は出せない（#934 の CodeRabbit の指摘））
  run legacyFailedRefused1Test =
    init
      .then(publishLegacy(1))
      .expect(inFlightOrDone(s, 1))
      .then(publishLegacy(1).fail())

  // 5.2.0 が PUBLISHED になっても、repo1 に見えるまでは関門が拒否する。見えたあとの再実行で通る（設計レビュー L1）
  run legacyVisibleLaterTest =
    init
      .then(openReleasePR(2))
      .then(mergePR(0, 0))
      .then(tagJob(2))
      .then(publishLegacy(1))
      .then(portalResolveAt(1, true, 1))
      .expect(s.published.contains(1) and not(isVisible(s, 1)))
      .then(rerunTagJob(2))
      .then(tagJob(2))
      .expect(s.tagFailed.contains(2) and not(s.tags.keys().contains(2)))
      .then(confirmPoll(1))
      .expect(isVisible(s, 1))
      .then(rerunTagJob(2))
      .then(tagJob(2))
      .expect(s.tags.keys().contains(2) and safety)

  // 5.2.0 のあとに、新しい版を2つ続けて出す
  run legacyThenTwoReleasesTest =
    init
      .then(publishLegacy(1))
      .then(portalResolve(1, true))
      .then(openReleasePR(2))
      .then(mergePR(0, 0))
      .then(tagJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .then(portalResolve(2, true))
      .then(openReleasePR(3))
      .then(mergePR(1, 0))
      .then(tagJob(3))
      .then(publishJobAt(3, false, 0, 0))
      .then(portalResolve(3, true))
      .expect(s.publishOrder == [1, 2, 3] and s.duplicateAttempts == 0 and safety)
}

// scala（R5）：main の `version` は 5.2.0（プレリリースを経ない）。ほかは kotlinPathsTest と同じ手順。
// 5.2.0 は古い publish.yml の run（42967443751）の「すべてのジョブを再実行」で出す（publishLegacy）
module scalaPathsTest {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(1), REQUIRED_PUBLISHED = Set(1),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 2, MAX_DELAY = 0,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).* from "./release_path"

  // 5.2.0 が出るまで、新しい版のタグは関門で止まる。5.2.0 が出たあと、タグのジョブの再実行で続ける
  run legacyFirstTest =
    init
      .then(openReleasePR(2))
      .then(mergePR(0, 0))
      .then(tagJob(2))
      .expect(s.tagFailed.contains(2) and not(s.tags.keys().contains(2)))
      .then(publishLegacy(1))
      .then(portalResolve(1, true))
      .then(rerunTagJob(2))
      .then(tagJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .then(portalResolve(2, true))
      .expect(s.publishOrder == [1, 2] and safety)

  // 5.2.0 の再実行が FAILED（上限など）→ もう一度再実行できる。処理中のあいだは再実行しない
  run legacyFailedTest =
    init
      .then(publishLegacy(1))
      .expect(inFlightOrDone(s, 1))
      .then(portalResolve(1, false))
      .then(publishLegacy(1))
      .then(portalResolve(1, true))
      .expect(s.published.contains(1) and s.duplicateAttempts == 0 and safety)

  // legacyFailedTest の途中で、publishLegacy が動かないこと（処理中なので、もう一度は出せない（#934 の CodeRabbit の指摘））
  run legacyFailedRefused1Test =
    init
      .then(publishLegacy(1))
      .expect(inFlightOrDone(s, 1))
      .then(publishLegacy(1).fail())

  // 5.2.0 が PUBLISHED になっても、repo1 に見えるまでは関門が拒否する。見えたあとの再実行で通る（設計レビュー L1）
  run legacyVisibleLaterTest =
    init
      .then(openReleasePR(2))
      .then(mergePR(0, 0))
      .then(tagJob(2))
      .then(publishLegacy(1))
      .then(portalResolveAt(1, true, 1))
      .expect(s.published.contains(1) and not(isVisible(s, 1)))
      .then(rerunTagJob(2))
      .then(tagJob(2))
      .expect(s.tagFailed.contains(2) and not(s.tags.keys().contains(2)))
      .then(confirmPoll(1))
      .expect(isVisible(s, 1))
      .then(rerunTagJob(2))
      .then(tagJob(2))
      .expect(s.tags.keys().contains(2) and safety)

  // 5.2.0 のあとに、新しい版を2つ続けて出す
  run legacyThenTwoReleasesTest =
    init
      .then(publishLegacy(1))
      .then(portalResolve(1, true))
      .then(openReleasePR(2))
      .then(mergePR(0, 0))
      .then(tagJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .then(portalResolve(2, true))
      .then(openReleasePR(3))
      .then(mergePR(1, 0))
      .then(tagJob(3))
      .then(publishJobAt(3, false, 0, 0))
      .then(portalResolve(3, true))
      .expect(s.publishOrder == [1, 2, 3] and s.duplicateAttempts == 0 and safety)
}

// java で R2a だけが main にある間（N1）：版上げの PR をマージしても、タグは付かず、古い release.yml は動かない
module javaR2aOnlyTest {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 2, MAX_DELAY = 0,
    NEW_PATH = true, TAG_PUSH_ENABLED = false, OLD_PUBLISH = true, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).* from "./release_path"

  run dryRunTagTest =
    init
      .then(openReleasePR(2))
      .then(mergePR(0, 0))
      .then(tagJob(2))
      .expect(s.wouldTag.contains(2) and not(s.tags.keys().contains(2))
              and s.publishPending.size() == 0 and s.deploy.keys() == Set(1) and safety)
}

// java の R2b（design-r2b.md §5）：ID を残す前に落ちた試み、Portal に届く前に落ちた試み、ほかの版の止まり、drop
module javaR2bPathsTest {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 2, MAX_DELAY = 0,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).* from "./release_path"

  action tagged2: bool = init.then(openReleasePR(2)).then(mergePR(0, 0)).then(tagJob(2))

  // ID を残す前に落ちる → 再実行は止まる → 人が ID を入れる → 処理中を待つ → PUBLISHED → 確認とリリース。二度目の公開なし
  run crashBeforeIdTest =
    tagged2
      .then(publishJobAt(2, false, 2, 0))
      .expect(s.unknown.get(2) and deployOf(s, 2) == Processing and not(s.recorded.contains(2)))
      .then(rerunPublishJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .expect(s.publishFailed.contains(2) and s.duplicateAttempts == 0)
      .then(supplyId(2))
      .expect(s.recorded.contains(2) and s.unknown.keys().size() == 0)
      .then(rerunPublishJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .expect(s.publishFailed.contains(2) and s.duplicateAttempts == 0)
      .then(portalResolve(2, true))
      // ID を補っても、確認とリリースは公開のジョブの再実行が published と読んでから（#934 の CodeRabbit の指摘）
      .then(rerunPublishJob(2))
      .then(resumePublishJob(2))
      .then(confirmPoll(2))
      .then(githubRelease(2))
      .expect(s.releases.contains(2) and s.duplicateAttempts == 0 and s.uploadsWhileUnknown == 0 and safety)

  // crashBeforeIdTest の途中で、confirmPoll が動かないこと
  run crashBeforeIdRefused1Test =
    tagged2
      .then(publishJobAt(2, false, 2, 0))
      .expect(s.unknown.get(2) and deployOf(s, 2) == Processing and not(s.recorded.contains(2)))
      .then(rerunPublishJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .expect(s.publishFailed.contains(2) and s.duplicateAttempts == 0)
      .then(supplyId(2))
      .expect(s.recorded.contains(2) and s.unknown.keys().size() == 0)
      .then(rerunPublishJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .expect(s.publishFailed.contains(2) and s.duplicateAttempts == 0)
      .then(portalResolve(2, true))
      // ID を補っても、確認とリリースは公開のジョブの再実行が published と読んでから（#934 の CodeRabbit の指摘）
      .then(confirmPoll(2).fail())

  // crashBeforeIdTest の途中で、githubRelease が動かないこと
  run crashBeforeIdRefused2Test =
    tagged2
      .then(publishJobAt(2, false, 2, 0))
      .expect(s.unknown.get(2) and deployOf(s, 2) == Processing and not(s.recorded.contains(2)))
      .then(rerunPublishJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .expect(s.publishFailed.contains(2) and s.duplicateAttempts == 0)
      .then(supplyId(2))
      .expect(s.recorded.contains(2) and s.unknown.keys().size() == 0)
      .then(rerunPublishJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .expect(s.publishFailed.contains(2) and s.duplicateAttempts == 0)
      .then(portalResolve(2, true))
      // ID を補っても、確認とリリースは公開のジョブの再実行が published と読んでから（#934 の CodeRabbit の指摘）
      .then(githubRelease(2).fail())

  // Portal に届く前に落ちる → 人が none を入れる → 公開し直す
  run crashBeforeSubmitTest =
    tagged2
      .then(publishJobAt(2, false, 1, 0))
      .expect(s.unknown.keys() == Set(2) and not(s.unknown.get(2)) and deployOf(s, 2) == NoDeploy)
      .then(rerunPublishJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .expect(deployOf(s, 2) == NoDeploy and s.publishFailed.contains(2))
      .then(supplyId(2))
      .then(rerunPublishJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .then(portalResolve(2, true))
      .expect(s.published.contains(2) and s.duplicateAttempts == 0 and safety)

  // 版 2 の試みが ID を残す前に落ちたまま、版 3 のタグの公開は止まる（追い越さない）。人が ID を入れたあとに順に出る
  run otherRunUnknownTest =
    tagged2
      .then(publishJobAt(2, false, 2, 0))
      .then(openReleasePR(3))
      .then(mergePR(1, 0))
      .then(tagJob(3))
      .then(publishJobAt(3, false, 0, 0))
      .expect(s.publishFailed.contains(3) and deployOf(s, 3) == NoDeploy and s.uploadsWhileUnknown == 0)
      .then(supplyId(2))
      .then(portalResolve(2, true))
      .then(rerunPublishJob(3))
      .then(publishJobAt(3, false, 0, 0))
      .then(portalResolve(3, true))
      .expect(s.publishOrder == [2, 3] and s.duplicateAttempts == 0 and safety)

  // 処理中の試みに取り違えて =none を書く → 照会は状態を返すので止まる → 行を消す → 待って PUBLISHED。二度目の公開なし
  run wrongNoneTest =
    tagged2
      .then(publishJobAt(2, true, 0, 0))
      .then(wrongNone(2))
      .expect(s.noneConflict == Set(2) and s.recorded.contains(2))
      .then(rerunPublishJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .expect(s.publishFailed.contains(2) and s.duplicateAttempts == 0)
      .then(fixNone(2))
      .then(portalResolve(2, true))
      .then(rerunPublishJob(2))
      .then(resumePublishJob(2))
      .then(githubRelease(2))
      .expect(s.releases.contains(2) and s.duplicateAttempts == 0 and safety)

  // wrongNoneTest の途中で、githubRelease が動かないこと
  run wrongNoneRefused1Test =
    tagged2
      .then(publishJobAt(2, true, 0, 0))
      .then(wrongNone(2))
      .expect(s.noneConflict == Set(2) and s.recorded.contains(2))
      .then(rerunPublishJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .expect(s.publishFailed.contains(2) and s.duplicateAttempts == 0)
      .then(fixNone(2))
      .then(portalResolve(2, true))
      .then(githubRelease(2).fail())

  // =none の食い違いだけで、ほかの版のアップロードも止まる（版 2 は PUBLISHED。止めるのは食い違いのガードだけ）。
  // 行を消したあとは版 3 を出せる（#924 の CodeRabbit の指摘）
  run wrongNoneBlocksOtherVersionsTest =
    tagged2
      .then(publishJobAt(2, false, 0, 0))
      .then(portalResolve(2, true))
      .then(wrongNone(2))
      .then(openReleasePR(3))
      .then(mergePR(1, 0))
      .then(tagJob(3))
      .then(publishJobAt(3, false, 0, 0))
      .expect(s.publishFailed.contains(3) and deployOf(s, 3) == NoDeploy)
      .then(fixNone(2))
      .then(rerunPublishJob(3))
      .then(publishJobAt(3, false, 0, 0))
      .expect(deployOf(s, 3) == Processing)
      .then(portalResolve(3, true))
      .expect(s.publishOrder == [2, 3] and s.duplicateAttempts == 0 and safety)

  // FAILED → Portal で drop → 照会が失敗して止まる → 人が none を入れる → 公開し直す
  run droppedFailedTest =
    tagged2
      .then(publishJobAt(2, false, 0, 0))
      .then(portalResolve(2, false))
      .then(dropDeployment(2))
      .then(rerunPublishJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .expect(s.publishFailed.contains(2) and deployOf(s, 2) == Failed)
      .then(markNone(2))
      .then(rerunPublishJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .then(portalResolve(2, true))
      .expect(s.published.contains(2) and s.duplicateAttempts == 0 and safety)

  // #863：版 2 が FAILED → 版 3 のタグの公開のジョブが待っているところに、版 2 の再実行があとから着いて置き換える
  // → 版 2 の再実行は「最新のタグでない」で止まる（公開しない）→ 版 3 の取り消された run を再実行する → 版 3 が出る
  run rerunReplacesLatestTest =
    tagged2
      .then(publishJobAt(2, false, 0, 0))
      .then(portalResolve(2, false))
      .then(openReleasePR(3))
      .then(mergePR(1, 0))
      .then(tagJob(3))
      .then(rerunPublishJob(2))
      .then(cancelPendingPublish(3))
      .expect(s.publishSkipped.contains(3) and s.publishPending == Set(2) and wNewerSkipped and safety)
      .then(publishJobAt(2, false, 0, 0))
      .expect(s.publishFailed.contains(2) and deployOf(s, 2) == Failed and safety)
      .then(rerunCancelledPublish(3))
      .then(publishJobAt(3, false, 0, 0))
      .then(portalResolve(3, true))
      .expect(s.publishOrder == [3] and s.duplicateAttempts == 0 and safety)
}

// 反映の確認の境界（#862 の CodeRabbit の指摘）：受け付け＝公開の構成で、反映の遅れを決めて流す。確認の上限は 2 回
module confirmBoundaryTest {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 2, MAX_DELAY = 3,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).* from "./release_path"

  action published2(delay: int): bool =
    init.then(openReleasePR(2)).then(mergePR(0, 0)).then(tagJob(2)).then(publishJobAt(2, false, 0, delay))

  // 最後（2 回目）の確認と同時に返し始める：確認できる（時間切れにしない）
  run visibleAtTheLastPollTest =
    published2(2)
      .then(confirmPoll(2))
      .then(confirmPoll(2))
      .expect(s.confirm.get(2).status == Confirmed and timeoutOnlyBeyondBudget and safety)

  // 最後の確認のあとで返し始める：時間切れ。確認だけを再実行すれば確認できる（公開はしない）
  run visibleAfterTheLastPollTest =
    published2(3)
      .then(confirmPoll(2))
      .then(confirmPoll(2))
      .expect(s.confirm.get(2).status == TimedOut and timeoutOnlyBeyondBudget and safety)
      .then(rerunConfirm(2))
      .then(confirmPoll(2))
      .expect(s.confirm.get(2).status == Confirmed and s.duplicateAttempts == 0 and safety)
}

// #863（設計の部分レビュー F2）：タグのジョブが置き換えられたあと、版を変えない PR がマージされても（先頭でなくなっても）、
// 取り消された run を再実行すればタグが付く。関門は main の先頭であることを求めない
module tagRecoveryTest {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = true,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 6, CONFIRM_ATTEMPTS = 2, MAX_DELAY = 0,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true,
    RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false, RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 7
  ).* from "./release_path"

  // 版 2 のタグのジョブが空振りで失敗 → 版 3 をマージ → 版 2 の再実行が版 3 のタグのジョブを置き換える →
  // 版を変えない PR（Renovate など）をマージ（版 3 のコミットは先頭でなくなる）→ 版 2 が出る →
  // 版 3 の取り消された run を再実行 → タグが付き、版 3 が出る
  run skippedBelowHeadTest =
    init
      .then(openReleasePR(2))
      .then(mergePR(0, 6))
      .then(5.reps(_ => tagJob(2)))
      .then(openReleasePR(3))
      .then(mergePR(1, 0))
      .then(rerunTagJob(2))
      .then(cancelPendingTag(3))
      .then(openOtherPR(3, false, false, true, false))
      .then(mergePR(2, 0))
      .expect(s.head == 4 and s.tagSkipped.contains(3) and wSkippedBelowHead and s.tagPending == Set(2) and safety)
      .then(tagJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .then(portalResolve(2, true))
      .then(rerunCancelledTag(3))
      .then(tagJob(3))
      .expect(s.tags.get(3) == 3 and safety)
      .then(publishJobAt(3, false, 0, 0))
      .then(portalResolve(3, true))
      .expect(s.publishOrder == [2, 3] and s.duplicateAttempts == 0 and safety)
}

// rs（R6）：crates.io は受け付け＝公開。事後の確認は sparse index（遅れは publishJobAt の d で決める）。
// GitHub のリリースは、事後の確認が版を返してから（RELEASE_AFTER_CONFIRM）。確認の上限は 2 回
module rsPathsTest {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 2, MAX_DELAY = 3,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = true, PRECHECK_ACCEPTED_LATEST = true,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).* from "./release_path"

  // 版上げの PR（PR 0）をマージして、コミット 2（版 2 = 5.2.1）にタグを打つ
  action taggedRelease: bool =
    init.then(openReleasePR(2)).then(mergePR(0, 0)).then(tagJob(2))

  // 正常の経路：PR → マージ → タグ → cargo publish（受け付け＝公開）→ index に見える → リリース
  run rsHappyPathTest =
    taggedRelease
      .expect(s.tags.get(2) == 2 and s.publishPending.contains(2))
      .then(publishJobAt(2, false, 0, 0))
      .expect(s.published.contains(2))
      .then(confirmPoll(2))
      .expect(s.confirm.get(2).status == Confirmed)
      .then(githubRelease(2))
      .expect(s.releases.contains(2) and s.publishOrder == [2] and safety)

  // 公開のジョブが成功し（jobOk）、事後の確認がまだ待ち（index の遅れ 2）のあいだは、リリースを作らない。
  // jobOk があるので、拒否は I17 の条件（Confirmed）による（R6 の設計レビュー M2）
  run rsReleaseBeforeConfirmRefusedTest =
    taggedRelease
      .then(publishJobAt(2, false, 0, 2))
      .then(confirmPoll(2))
      .expect(s.published.contains(2) and s.jobOk.contains(2) and s.confirm.get(2).status == Waiting)
      .then(githubRelease(2).fail())

  // index の遅れ（3）が確認の上限（2）を超える → 時間切れ → 確認だけを再実行 → 見える → リリース。公開は1回だけ
  run rsIndexTimeoutThenRerunConfirmTest =
    taggedRelease
      .then(publishJobAt(2, false, 0, 3))
      .then(confirmPoll(2))
      .then(confirmPoll(2))
      .expect(s.confirm.get(2).status == TimedOut and s.published.contains(2) and safety)
      .then(rerunConfirm(2))
      .then(confirmPoll(2))
      .expect(s.confirm.get(2).status == Confirmed)
      .then(githubRelease(2))
      .expect(s.releases.contains(2) and s.publishOrder == [2] and s.duplicateAttempts == 0 and safety)

  // rsIndexTimeoutThenRerunConfirmTest の途中（時間切れ）で、リリースを作らない
  run rsIndexTimeoutRefused1Test =
    taggedRelease
      .then(publishJobAt(2, false, 0, 3))
      .then(confirmPoll(2))
      .then(confirmPoll(2))
      .expect(s.confirm.get(2).status == TimedOut)
      .then(githubRelease(2).fail())

  // cargo publish が受け付けられたあとでジョブが落ちる → 再実行の事前の確認が crates.io の版を読み、二度目は出さない
  // （関門を通らない publishJob は拒否で終わる）→ 再実行で published と読む → 確認 → リリース
  run rsJobFailsAfterPublishTest =
    taggedRelease
      .then(publishJobAt(2, true, 0, 0))
      .expect(s.publishFailed.contains(2) and s.published.contains(2) and not(s.confirm.keys().contains(2)))
      .then(rerunPublishJob(2))
      .then(publishJobAt(2, false, 0, 0))
      .expect(s.publishFailed.contains(2) and s.duplicateAttempts == 0)
      .then(rerunPublishJob(2))
      .then(resumePublishJob(2))
      .then(confirmPoll(2))
      .then(githubRelease(2))
      .expect(s.releases.contains(2) and s.publishOrder == [2] and s.duplicateAttempts == 0 and safety)

  // rsJobFailsAfterPublishTest の途中（再実行が published と読み jobOk が立ったが、確認はまだ待ち）で、リリースを作らない
  run rsJobFailsAfterPublishRefused1Test =
    taggedRelease
      .then(publishJobAt(2, true, 0, 2))
      .then(rerunPublishJob(2))
      .then(resumePublishJob(2))
      .expect(s.jobOk.contains(2) and s.confirm.get(2).status == Waiting)
      .then(githubRelease(2).fail())

  // 2つの版を続けて出す
  run rsTwoReleasesTest =
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
