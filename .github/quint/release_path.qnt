// -*- mode: Bluespec; -*-
//
// 公開の経路（版上げの PR → 人のマージ → 関門 → タグ → 公開 → 公開後の確認 → GitHub のリリース）のモデル。
// js の形（j5ik2o/event-store-adapter-js#1158）を、java・kotlin・scala・rs・go に当てはめたときの設計を確かめる。
//
// 扱うもの
//   - main（strict な保護。マージは squash だけ。直接の push はない）
//   - PR：版上げのワークフローが開く PR と、ほかの PR（版を変える、降版、revert、プレリリース、フォーク、版と一緒にコードも変える）
//   - タグの関門（tag のモード）。PR の照会の再試行（マージ直後は関連付けが返らない）
//   - 公開の関門（publish のモード）。公開先の事前の確認（公開済みの版と、処理中・公開済みの deployment）、公開の直前の最新タグの確認
//   - 公開先が先に要る版（kotlin・scala の 5.2.0）：公開先に出るまで、新しい版のタグと公開を拒否する（設計レビュー A1）
//   - 公開先の2段（Central）：受け付け（deployment が処理中）→ PUBLISHED か FAILED（設計レビュー A2）
//   - 公開の操作のあとでジョブが失敗する（設計レビュー A3）
//   - 公開先の反映の遅れ。公開後の確認の待ちの上限（js#1161）と、確認だけの再実行
//   - 並行：concurrency の group で、待っているタグのジョブ・公開のジョブが、あとから着いたジョブに置き換えられる（D2、#863）
//   - 移行前からあるタグ（kotlin・scala の v5.2.0）を、古い実行の再実行で出す
//   - Go：タグの push そのものが公開
//
// 版は整数で抽象化する（X.Y.Z の順序だけが効く）。プレリリース（-SNAPSHOT など）は、同じ番号の正式版より小さい。
// 時間は「確認の1回」を1刻みとする整数の時計で表す。
// concurrency の待ちの置き換え（cancelPendingTag・cancelPendingPublish）は、group に着いた順（tagArrival・publishArrival）で決める。
// 初めての実行も、失敗したジョブや取り消された run の再実行も、どれも1つの到着として数え、あとから着いたジョブが
// 待っているジョブを置き換える。版やコミットの大小は見ない。古い版の再実行が、待っている新しい版を置き換えることもある
// （https://github.com/j5ik2o/event-store-adapter-java/issues/863）。モデルのジョブは1つの動作で動き切るので、
// 「待っている」と「動いている」を分けず、待ちの集合の中で最後に着いたもの以外は、どれも置き換えられうる（実物より広い）。
module release_path {

  // ---------------------------------------------------------------- 定数（言語ごとのインスタンスで決める）
  const VERSIONS: Set[int]            // 起こりうる版の番号
  const INIT_VER: int                 // main の先頭の版
  const INIT_PRE: bool                // main の先頭がプレリリース（java・kotlin の 5.2.1-SNAPSHOT）か
  const INIT_TAG: int                 // 移行の時点で最新のタグ
  const LEGACY: Set[int]              // タグはあるが公開先に無い、移行前の版（kotlin・scala の 5.2.0）
  const REQUIRED_PUBLISHED: Set[int]  // 関門の設定「公開先に必要な版」。公開先に出るまで新しい版を拒否する
  const TAG_IS_PUBLISH: bool          // Go：タグの push が公開
  const ASYNC_PORTAL: bool            // Central：受け付けのあとで PUBLISHED か FAILED になる。crates.io・Go は受け付け＝公開
  const PRECHECK_SEES_DEPLOYMENTS: bool // 事前の確認が、処理中・公開済みの deployment を見る（見ないと二度目の公開を試みうる）
  const MANUAL_TAGS: bool             // 人がタグを手で push できる（タグの rulesets が無い）
  const OTHER_PRS: bool               // ほかの PR を開ける（決まった手順の検査では外す）
  const LOOKUP_ATTEMPTS: int          // PR の照会の回数（js は 5 回）
  const MAX_ASSOC_DELAY: int          // 関連付けが返るまでに空振りする回数の上限
  const CONFIRM_ATTEMPTS: int         // 公開後の確認の回数
  const MAX_DELAY: int                // 公開先の反映の遅れ（確認の間隔で数えた上限）
  const RERUN_WHOLE_PUBLISH: bool     // 誤った回復：確認の時間切れで、公開のジョブを丸ごと再実行する
  const MAX_COMMITS: int              // 状態空間の上限
  // 移行の途中の構成（再レビュー N1・N2・N3）
  const NEW_PATH: bool                // 新しい版上げ（PR とタグのジョブ）がある
  const TAG_PUSH_ENABLED: bool        // タグのジョブがタグを push する（R2a だけの間は false：打つはずのタグを出して終わる）
  const OLD_PUBLISH: bool             // 公開のジョブが古い形（関門・事前の確認なし。リリースのジョブもない）
  const OLD_BUMP: bool                // 古い版上げ（scala の Bump Version：PR を通らずに API で main の先頭にタグを打ち、公開の前にリリースを作る）が動く
  const PRECHECK_SEES_OTHER_DEPLOYMENTS: bool // 事前の確認が、ほかの版（ほかの run）の処理中の deployment も見る
  // R2b（design-r2b.md §5）
  const RECORD_VIEW: bool             // 事前の確認は deployment を記録（ID の artifact か、人が入れた変数の行）を通してだけ見る。
                                      // アップロードの手順が始まったあと、ID を残す前に落ちうる（Portal に届く前、届いたあと）
  const UNKNOWN_DETECTED: bool        // 落ちた試みを、手順の記録（jobs API）と境の規則で「始まった」と必ず見分ける（A1 の直し）。
                                      // false は、手順の一覧が途中で切れた job を数えない規則（直す前の追記）
  const UNKNOWN_STOPS: bool           // 始まったのに ID の無い試みがあれば、事前の確認が止まる（§1.4 の 2）
  const NONE_SKIPS_QUERY: bool        // v2 の規則：変数の =none があれば、artifact の ID を照会しない（N1。false が v3 の規則）
  const PRECHECK_LATEST_TAG: bool     // 事前の確認は、決めるときのリモートのタグで「最新のタグか」を確かめる（待ちのあとも読み直す。#862 の指摘）
  // #863
  const RERUN_CANCELLED: bool         // 置き換えられて取り消された run を、人が再実行する（CONTRIBUTING の表）。
                                      // false は直す前の §6 の行「置き換え → そのまま（飛んだ版）」
  const RELEASE_AFTER_CONFIRM: bool   // rs（R6）：GitHub のリリースは、公開後の確認（sparse index が版を返す）が通ってから作る。
  const PRECHECK_ACCEPTED_LATEST: bool // rs（R6）：事前の確認の「最大の版」は、受理済みの版のすべてから（crates.io の API）。false は公開先に見える版だけ（遅れがある。Maven Central）
                                      // false は Central の形（PUBLISHED を読んで公開のジョブが成功すれば作る。反映の時間切れでは止めない）

  // ---------------------------------------------------------------- 型
  type Commit = {
    parent: int,
    ver: int,
    pre: bool,
    // 関門が見る事実（release-gate.py の merged_from と approved_release）
    squashOfReleasePR: bool,  // 同じリポジトリの release/v<ver> から main への squash で、変えたのは版のファイルの版だけ
  }

  type PR = {
    target: int,           // マージしたときの版
    pre: bool,
    changesVersion: bool,
    releaseBranch: bool,   // head が release/v<target>
    sameRepo: bool,        // フォークでない
    onlyVersion: bool,     // 版のファイルの版だけを変える
  }

  // 公開先の deployment の状態。NoDeploy は「まだ出していない」
  type Deploy = NoDeploy | Processing | Published | Failed

  // 事後の確認。Rejected は FAILED を読んだ（すぐに失敗し、リリースを作らない）
  type ConfirmStatus = Waiting | Confirmed | TimedOut | Rejected

  type Repo = {
    commits: int -> Commit,
    head: int,
    nextId: int,
    prs: int -> PR,             // 開いている PR
    nextPr: int,
    tags: int -> int,           // 版 → コミット
    tagOrder: List[int],        // 関門がタグを作った順
    manualTags: Set[int],       // 人が手で作ったタグ
    tagPending: Set[int],       // タグのジョブを待つコミット
    lookup: int -> int,         // コミット → 照会の回数
    assocAfter: int -> int,     // コミット → 関連付けが返り始める回数
    tagFailed: Set[int],        // 失敗したタグのジョブ（再実行できる）
    tagSkipped: Set[int],       // 待ちのジョブが置き換えられ、タグが付かなかったコミット（取り消された run）
    tagArrival: int -> int,     // コミット → タグのジョブが group に着いた順（#863）
    wouldTag: Set[int],         // タグを push しない構成で、関門を通った（打つはずだった）版
    oldTags: Set[int],          // 古い版上げが打ったタグ
    publishPending: Set[int],   // 公開のジョブを待つ版
    publishFailed: Set[int],    // 失敗した公開のジョブ（関門で止まった、公開の操作のあとで失敗した、FAILED を読んだ）
    publishSkipped: Set[int],   // 待ちの公開のジョブが置き換えられた版（取り消された run）
    publishArrival: int -> int, // 版 → 公開のジョブが group に着いた順（#863）
    arrivals: int,              // 着いたジョブの数（次の到着の番号）
    deploy: int -> Deploy,      // 版 → 最後の deployment の状態
    published: Set[int],        // 公開先が PUBLISHED にした版
    publishOrder: List[int],    // PUBLISHED になった順
    failedOnce: Set[int],       // 一度でも FAILED になった版
    jobFailedAfterSubmit: Set[int], // 公開の操作のあとでジョブが失敗した版
    visibleAt: int -> int,      // 版 → 公開先（repo1 など）が返し始める時刻
    delayOf: int -> int,        // 版 → PUBLISHED から公開先が返し始めるまでの遅れ（I9 で使う）
    duplicateAttempts: int,     // 処理中・公開済みの版を、もう一度出そうとした回数
    confirm: int -> { status: ConfirmStatus, attempts: int, statusAttempts: int, whileProcessing: bool, lastPoll: int },
    // attempts：PUBLISHED のあとの反映の確認の回数。statusAttempts：deployment の状態の確認の回数（別の上限）
    releases: Set[int],         // GitHub のリリース
    jobOk: Set[int],            // 公開のジョブ（release ジョブ）が成功で終わった版（precheck が published、か待ちが PUBLISHED を出した。#934）
    clock: int,
    // R2b
    unknown: int -> bool,       // 版 → 始まったのに ID の記録が無い試み（true：Portal に届いていた）
    everUnknown: Set[int],      // 一度でも unknown になった版（到達の確認）
    recorded: Set[int],         // 最後の deployment の ID が記録されている版
    stale: Set[int],            // 記録された FAILED の deployment を Portal で drop した版（照会が失敗し続ける）
    everStale: Set[int],        // 一度でも stale になった版（到達の確認）
    noneConflict: Set[int],     // =none を書いたのに、照会が状態を返した版（v3 の規則では止まる）
    uploadsWhileUnknown: int,   // unknown が空でないのにアップロードした回数（I11）
  }

  var s: Repo

  // ---------------------------------------------------------------- 純粋な関数
  // 版の大小。プレリリースは同じ番号の正式版より小さい
  pure def key(ver: int, pre: bool): int = 2 * ver + (if (pre) 0 else 1)

  pure def maxOf(xs: Set[int]): int = xs.fold(-1, (a, x) => if (x > a) x else a)

  pure def latestTag(r: Repo): int = maxOf(r.tags.keys())

  pure def headCommit(r: Repo): Commit = r.commits.get(r.head)

  pure def deployOf(r: Repo, v: int): Deploy =
    if (r.deploy.keys().contains(v)) r.deploy.get(v) else NoDeploy

  // 公開先が返す（事前の確認と、必要な版の確認に使う）
  pure def isVisible(r: Repo, v: int): bool =
    r.published.contains(v) and r.visibleAt.get(v) <= r.clock

  pure def visibleLatest(r: Repo): int = maxOf(r.published.filter(v => isVisible(r, v)))

  // deployment が処理中か公開済み（これがあれば、同じ版をもう一度出してはいけない）
  pure def inFlightOrDone(r: Repo, v: int): bool =
    val d = deployOf(r, v)
    d == Processing or d == Published

  pure def anyProcessing(r: Repo): bool =
    r.deploy.keys().exists(v => r.deploy.get(v) == Processing)

  // R2b：事前の確認から見える deployment。RECORD_VIEW のときは、ID の記録がある版だけが見える
  pure def seenInFlightOrDone(r: Repo, v: int): bool =
    inFlightOrDone(r, v) and (not(RECORD_VIEW) or r.recorded.contains(v))

  pure def seenAnyProcessing(r: Repo): bool =
    r.deploy.keys().exists(v => r.deploy.get(v) == Processing and (not(RECORD_VIEW) or r.recorded.contains(v)))

  pure def unknownWithout(m: int -> bool, k: int): int -> bool =
    m.keys().exclude(Set(k)).mapBy(x => m.get(x))

  // 関門の設定「公開先に必要な版」（A1）：どれも公開先に出ている
  pure def requiredPublished(r: Repo): bool =
    REQUIRED_PUBLISHED.forall(v => isVisible(r, v))

  pure def strictlyIncreasing(xs: List[int]): bool =
    xs.indices().forall(i => i == 0 or xs[i - 1] < xs[i])

  // 版上げのワークフロー：指定の版の検証と、枝 release/v<v> が無いこと
  pure def canOpenReleasePR(r: Repo, v: int): bool = all {
    v > latestTag(r),
    key(v, false) > key(headCommit(r).ver, headCommit(r).pre),
    not(r.tags.keys().contains(v)),
    not(r.prs.keys().exists(p => r.prs.get(p).releaseBranch and r.prs.get(p).target == v)),
  }

  pure def openPR(r: Repo, pr: PR): Repo =
    { ...r, prs: r.prs.put(r.nextPr, pr), nextPr: r.nextPr + 1 }

  pure def mapWithout(m: int -> PR, k: int): int -> PR =
    m.keys().exclude(Set(k)).mapBy(x => m.get(x))

  // concurrency の group にジョブが着く（初めての実行も再実行も同じ。#863）
  pure def arriveTag(r: Repo, id: int): Repo =
    { ...r, tagPending: r.tagPending.union(Set(id)), tagArrival: r.tagArrival.put(id, r.arrivals), arrivals: r.arrivals + 1 }

  pure def arrivePublish(r: Repo, v: int): Repo =
    { ...r, publishPending: r.publishPending.union(Set(v)), publishArrival: r.publishArrival.put(v, r.arrivals),
      arrivals: r.arrivals + 1 }

  // squash のマージ。strict なので、マージ時点の main の先頭が親
  pure def merge(r: Repo, p: int, assocDelay: int): Repo =
    val pr = r.prs.get(p)
    val parent = headCommit(r)
    val ver = if (pr.changesVersion) pr.target else parent.ver
    val pre = if (pr.changesVersion) pr.pre else parent.pre
    val c = {
      parent: r.head, ver: ver, pre: pre,
      squashOfReleasePR: pr.releaseBranch and pr.sameRepo and pr.onlyVersion and pr.changesVersion,
    }
    val id = r.nextId
    // Bump-Version の push は paths で版のファイルの変更だけに絞る
    val versionChanged = ver != parent.ver or pre != parent.pre
    val merged = {
      ...r,
      commits: r.commits.put(id, c), head: id, nextId: id + 1,
      prs: mapWithout(r.prs, p),
      lookup: r.lookup.put(id, 0),
      assocAfter: r.assocAfter.put(id, assocDelay),
    }
    if (versionChanged) arriveTag(merged, id) else merged

  // タグの関門（tag のモード）。0 = 何もしない、1 = タグを打つ、2 = 失敗
  pure def tagGate(r: Repo, id: int): int =
    val c = r.commits.get(id)
    val parent = r.commits.get(c.parent)
    if (c.ver == parent.ver and c.pre == parent.pre) 0
    else if (c.pre) 0
    else if (not(c.squashOfReleasePR)) 2
    else if (key(c.ver, c.pre) <= key(parent.ver, parent.pre)) 2
    else if (r.tags.keys().contains(c.ver)) (if (r.tags.get(c.ver) == id) 0 else 2)
    else if (c.ver <= latestTag(r)) 2
    else if (not(requiredPublished(r))) 2   // A1：必要な版が公開先に出るまで、新しい版を拒否
    else 1

  // 公開の関門（publish のモード）＋公開先の事前の確認＋公開の直前の最新タグの確認
  pure def publishGate(r: Repo, v: int): bool =
    val id = r.tags.get(v)
    val c = r.commits.get(id)
    val parent = r.commits.get(c.parent)
    all {
      c.squashOfReleasePR,
      c.ver == v,
      not(c.pre),
      key(c.ver, c.pre) > key(parent.ver, parent.pre),
      requiredPublished(r),                          // A1
      not(isVisible(r, v)),                          // 公開済みの版の確認（遅れがあり、見えないことがある）
      PRECHECK_SEES_DEPLOYMENTS implies not(seenInFlightOrDone(r, v)), // A3：処理中・公開済みの deployment
      PRECHECK_SEES_OTHER_DEPLOYMENTS implies not(seenAnyProcessing(r)), // 処理中の別の版を追い越さない（N3：run をまたいで ID を読む）
      (RECORD_VIEW and UNKNOWN_STOPS) implies r.unknown.keys().size() == 0, // V2：ID の無い試みがあれば止まる
      RECORD_VIEW implies r.stale.size() == 0,       // B2：drop した ID の照会は失敗するので止まる
      RECORD_VIEW implies r.noneConflict.size() == 0, // N1：=none と照会の状態が食い違えば止まる
      v > (if (PRECHECK_ACCEPTED_LATEST) maxOf(r.published) else visibleLatest(r)), // #375 の CodeRabbit の指摘
      PRECHECK_LATEST_TAG implies v == latestTag(r), // 新しいタグに追い越されない
    }

  // 再実行の precheck が、この版の deployment を PUBLISHED と読む（記録を通して、または repo1 が全部返す）。上げずに成功する。
  // 関門（publish のモード）はこの前に通る：版上げの PR の squash、必要な版、ほかのどのタグより大きい（#934）
  pure def resumable(r: Repo, v: int): bool =
    val id = r.tags.get(v)
    val c = r.commits.get(id)
    val parent = r.commits.get(c.parent)
    all {
      c.squashOfReleasePR,
      c.ver == v,
      not(c.pre),
      key(c.ver, c.pre) > key(parent.ver, parent.pre),
      requiredPublished(r),
      v == latestTag(r),
      deployOf(r, v) == Published,
      seenInFlightOrDone(r, v) or isVisible(r, v),
      PRECHECK_SEES_OTHER_DEPLOYMENTS implies not(seenAnyProcessing(r)), // 待ち（処理中）は published より先に決まる
      (RECORD_VIEW and UNKNOWN_STOPS) implies r.unknown.keys().size() == 0,
      RECORD_VIEW implies r.stale.size() == 0,
      RECORD_VIEW implies r.noneConflict.size() == 0,
    }

  pure def becomePublished(r: Repo, v: int, delay: int): Repo =
    {
      ...r,
      deploy: r.deploy.put(v, Published),
      published: r.published.union(Set(v)),
      publishOrder: r.publishOrder.append(v),
      visibleAt: r.visibleAt.put(v, r.clock + delay),
      delayOf: r.delayOf.put(v, delay),
    }

  // 公開先へ出す。処理中・公開済みの版は拒否され、二度目の試みとして数える
  pure def submit(r0: Repo, v: int, delay: int): Repo =
    val r = { ...r0, uploadsWhileUnknown: r0.uploadsWhileUnknown + (if (r0.unknown.keys().size() > 0) 1 else 0) }
    if (inFlightOrDone(r, v)) { ...r, duplicateAttempts: r.duplicateAttempts + 1 }
    else {
      val started = { ...r, confirm: r.confirm.put(v, { status: Waiting, attempts: 0, statusAttempts: 0, whileProcessing: false, lastPoll: -1 }) }
      if (ASYNC_PORTAL) { ...started, deploy: started.deploy.put(v, Processing) }
      else becomePublished(started, v, delay)
    }

  // ---------------------------------------------------------------- 初期状態
  action init: bool = all {
    s' = {
      // コミット 0：移行の時点の最新のタグ。コミット 1：main の先頭
      commits: Map(
        0 -> { parent: 0, ver: INIT_TAG, pre: false, squashOfReleasePR: false },
        1 -> { parent: 0, ver: INIT_VER, pre: INIT_PRE, squashOfReleasePR: false },
      ),
      head: 1, nextId: 2,
      prs: Map(), nextPr: 0,
      tags: Map(INIT_TAG -> 0),
      tagOrder: List(),
      manualTags: Set(),
      tagPending: Set(),
      lookup: Map(), assocAfter: Map(),
      tagFailed: Set(), tagSkipped: Set(), tagArrival: Map(), wouldTag: Set(), oldTags: Set(),
      publishPending: Set(), publishFailed: Set(), publishSkipped: Set(), publishArrival: Map(), arrivals: 0,
      // 移行前の版：11/11 の deployment は FAILED（片付けたかどうかは手順で確かめる）
      deploy: if (LEGACY.contains(INIT_TAG)) Map(INIT_TAG -> Failed) else Map(INIT_TAG -> Published),
      published: if (LEGACY.contains(INIT_TAG)) Set() else Set(INIT_TAG),
      publishOrder: List(),
      failedOnce: Set(),
      jobFailedAfterSubmit: Set(),
      visibleAt: Map(INIT_TAG -> 0),
      delayOf: Map(),
      duplicateAttempts: 0,
      confirm: Map(),
      releases: Set(INIT_TAG),   // kotlin・scala の v5.2.0 は、Central に無いのにリリースがある（今の時点で I7 の例外）
      jobOk: Set(),
      clock: 0,
      unknown: Map(), everUnknown: Set(), recorded: Set(), stale: Set(), everStale: Set(), noneConflict: Set(), uploadsWhileUnknown: 0,
    },
  }

  // ---------------------------------------------------------------- 動作
  // 1. 版上げのワークフロー（workflow_dispatch）。main には書かず、枝と PR を作る
  action openReleasePR(v: int): bool = all {
    NEW_PATH,
    s.nextId < MAX_COMMITS,
    canOpenReleasePR(s, v),
    s' = openPR(s, { target: v, pre: false, changesVersion: true,
                     releaseBranch: true, sameRepo: true, onlyVersion: true }),
  }

  // 2. ほかの PR（壊しうる入力）：版の変更、降版、revert、プレリリース、フォーク、コードと版を一緒に変える。
  //    release/v* の枝を版上げのワークフロー以外が作ることは、前提で除く
  action openOtherPR(v: int, pre: bool, changesVersion: bool, sameRepo: bool, onlyVersion: bool): bool = all {
    OTHER_PRS,
    s.nextId < MAX_COMMITS,
    s.nextPr < MAX_COMMITS,
    s' = openPR(s, { target: v, pre: pre, changesVersion: changesVersion,
                     releaseBranch: false, sameRepo: sameRepo, onlyVersion: onlyVersion }),
  }

  // 3. 人のマージ（必須チェックが通ったものだけ。ワークフローはマージしない）
  action mergePR(p: int, assocDelay: int): bool = all {
    s.prs.keys().contains(p),
    s.nextId < MAX_COMMITS,
    s' = merge(s, p, assocDelay),
  }

  // 4. タグのジョブ：PR の照会（空振りは再試行）と関門
  action tagJob(id: int): bool = all {
    s.tagPending.contains(id),
    val attempt = s.lookup.get(id)
    if (attempt < s.assocAfter.get(id)) {
      if (attempt + 1 >= LOOKUP_ATTEMPTS)
        s' = { ...s, tagPending: s.tagPending.exclude(Set(id)), tagFailed: s.tagFailed.union(Set(id)),
               lookup: s.lookup.put(id, attempt + 1) }
      else
        s' = { ...s, lookup: s.lookup.put(id, attempt + 1) }
    } else {
      val g = tagGate(s, id)
      val c = s.commits.get(id)
      if (g == 1 and not(TAG_PUSH_ENABLED)) {
        // R2a だけの間：打つはずのタグを出して終わる（N1）
        s' = { ...s, tagPending: s.tagPending.exclude(Set(id)), wouldTag: s.wouldTag.union(Set(c.ver)) }
      } else if (g == 1) {
        val tagged = { ...s, tags: s.tags.put(c.ver, id), tagOrder: s.tagOrder.append(c.ver),
                       tagPending: s.tagPending.exclude(Set(id)) }
        // Go：タグの push で公開される。それ以外：タグの push で公開のジョブが起動する
        if (TAG_IS_PUBLISH) {
          nondet d = 0.to(MAX_DELAY).oneOf()
          s' = submit(tagged, c.ver, d)
        } else
          s' = arrivePublish(tagged, c.ver)
      } else
        s' = { ...s, tagPending: s.tagPending.exclude(Set(id)),
               tagFailed: if (g == 2) s.tagFailed.union(Set(id)) else s.tagFailed }
    },
  }

  // 5. 失敗したタグのジョブの再実行（時間がたち、関連付けは返るようになる）
  action rerunTagJob(id: int): bool = all {
    s.tagFailed.contains(id),
    s' = arriveTag({ ...s, tagFailed: s.tagFailed.exclude(Set(id)),
                     lookup: s.lookup.put(id, 0), assocAfter: s.assocAfter.put(id, 0) }, id),
  }

  // 5b（#863）. 置き換えられて取り消されたタグのジョブの run を、人が再実行する
  action rerunCancelledTag(id: int): bool = all {
    RERUN_CANCELLED,
    s.tagSkipped.contains(id),
    s' = arriveTag({ ...s, tagSkipped: s.tagSkipped.exclude(Set(id)),
                     lookup: s.lookup.put(id, 0), assocAfter: s.assocAfter.put(id, 0) }, id),
  }

  // 6. concurrency の group：待っているタグのジョブは、あとから着いたジョブに置き換えられる（queue: max でない間）。
  //    あとから着いたのが古いコミットの再実行でも置き換える（#863）
  action cancelPendingTag(id: int): bool = all {
    s.tagPending.contains(id),
    s.tagPending.exists(other => other != id and s.tagArrival.get(other) > s.tagArrival.get(id)),
    s' = { ...s, tagPending: s.tagPending.exclude(Set(id)), tagSkipped: s.tagSkipped.union(Set(id)) },
  }

  // 7. 人がタグを手で push する（タグの rulesets が無いとき）
  action pushTagByHand(v: int): bool = all {
    MANUAL_TAGS,
    not(s.tags.keys().contains(v)),
    val tagged = { ...s, tags: s.tags.put(v, s.head), manualTags: s.manualTags.union(Set(v)) }
    if (TAG_IS_PUBLISH) {
      nondet d = 0.to(MAX_DELAY).oneOf()
      s' = submit(tagged, v, d)
    } else
      s' = arrivePublish(tagged, v),
  }

  // 8. 公開のジョブ（タグの push、または失敗したジョブの再実行）。
  //    failAfterSubmit：公開の操作のあとでジョブが失敗する（kotlin の 11/11 の release の 400 と同じ形。A3）
  action publishJob(v: int, failAfterSubmit: bool): bool = all {
    nondet d = 0.to(MAX_DELAY).oneOf()
    nondet crash = (if (RECORD_VIEW) 0.to(2) else Set(0)).oneOf()
    publishJobAt(v, failAfterSubmit, crash, d),
  }

  // crash（R2b）：0 = 落ちない、1 = アップロードの手順は始まったが Portal に届く前に落ちた、
  //               2 = Portal に届いた（deployment は処理中）が ID を残す前に落ちた
  action publishJobAt(v: int, failAfterSubmit: bool, crash: int, d: int): bool = all {
    not(TAG_IS_PUBLISH),
    s.publishPending.contains(v),
    // 古い公開のジョブ（今の java・kotlin の release.yml、scala の publish.yml）は、関門も事前の確認も持たない
    if (OLD_PUBLISH or publishGate(s, v)) {
      val pending = { ...s, publishPending: s.publishPending.exclude(Set(v)) }
      if (crash == 1)
        s' = { ...pending, publishFailed: pending.publishFailed.union(Set(v)),
               unknown: if (UNKNOWN_DETECTED) pending.unknown.put(v, false) else pending.unknown,
               everUnknown: if (UNKNOWN_DETECTED) pending.everUnknown.union(Set(v)) else pending.everUnknown }
      else {
        val r = submit(pending, v, d)
        if (crash == 2)
          // ID を残す前に落ちたので、公開のあとの確認は始まらない（人が ID を入れて再実行が通ってから。#862 の CodeRabbit の指摘）
          s' = { ...r, publishFailed: r.publishFailed.union(Set(v)),
                 confirm: r.confirm.keys().exclude(Set(v)).mapBy(x => r.confirm.get(x)),
                 jobFailedAfterSubmit: r.jobFailedAfterSubmit.union(Set(v)),
                 recorded: r.recorded.exclude(Set(v)),
                 unknown: if (UNKNOWN_DETECTED) r.unknown.put(v, true) else r.unknown,
                 everUnknown: if (UNKNOWN_DETECTED) r.everUnknown.union(Set(v)) else r.everUnknown }
        else {
          val rec = { ...r, recorded: r.recorded.union(Set(v)) }
          if (failAfterSubmit)
            // ジョブが落ちたので、待ちの手順もあとのジョブ（リリース・repo1 の確認）も動かない。再実行の precheck が続ける（#934）
            s' = { ...rec, publishFailed: rec.publishFailed.union(Set(v)),
                   confirm: rec.confirm.keys().exclude(Set(v)).mapBy(x => rec.confirm.get(x)),
                   jobFailedAfterSubmit: rec.jobFailedAfterSubmit.union(Set(v)) }
          else s' = rec
        }
      }
    } else
      s' = { ...s, publishPending: s.publishPending.exclude(Set(v)), publishFailed: s.publishFailed.union(Set(v)) },
  }

  action rerunPublishJob(v: int): bool = all {
    s.publishFailed.contains(v),
    s' = arrivePublish({ ...s, publishFailed: s.publishFailed.exclude(Set(v)) }, v),
  }

  // 8a（#934 の CodeRabbit の指摘）. 公開のジョブ（再実行を含む）の precheck が、この版の deployment を PUBLISHED と読む：
  //     上げずに成功で終わり（action=published）、リリースと repo1 の確認のジョブが動く
  action resumePublishJob(v: int): bool = all {
    not(TAG_IS_PUBLISH),
    not(OLD_PUBLISH),
    s.publishPending.contains(v),
    resumable(s, v),
    s' = { ...s, publishPending: s.publishPending.exclude(Set(v)), jobOk: s.jobOk.union(Set(v)),
           confirm: s.confirm.put(v, { status: Waiting, attempts: 0, statusAttempts: 0, whileProcessing: false, lastPoll: -1 }) },
  }

  // 8b（#863）. 置き換えられて取り消された公開のジョブの run を、人が再実行する
  action rerunCancelledPublish(v: int): bool = all {
    RERUN_CANCELLED,
    s.publishSkipped.contains(v),
    s' = arrivePublish({ ...s, publishSkipped: s.publishSkipped.exclude(Set(v)) }, v),
  }

  // 9. concurrency の group：待っている公開のジョブは、あとから着いたジョブに置き換えられる（D2）。
  //    あとから着いたのが古い版の再実行でも置き換える（#863）
  action cancelPendingPublish(v: int): bool = all {
    s.publishPending.contains(v),
    s.publishPending.exists(w => w != v and s.publishArrival.get(w) > s.publishArrival.get(v)),
    s' = { ...s, publishPending: s.publishPending.exclude(Set(v)), publishSkipped: s.publishSkipped.union(Set(v)) },
  }

  // 10. 公開先が deployment を処理し終える（A2）。FAILED なら公開先に何も無く、公開のジョブを再実行してよい
  action portalResolve(v: int, ok: bool): bool = all {
    nondet d = 0.to(MAX_DELAY).oneOf()
    portalResolveAt(v, ok, d),
  }

  // 遅れ d を決めて書く形（決まった手順のテストで、PUBLISHED のあと repo1 に見えるまでの間を作る。kotlin R4 の設計レビュー L1）
  action portalResolveAt(v: int, ok: bool, d: int): bool = all {
    ASYNC_PORTAL,
    deployOf(s, v) == Processing,
    if (ok) s' = becomePublished(s, v, d)
    else s' = { ...s, deploy: s.deploy.put(v, Failed), failedOnce: s.failedOnce.union(Set(v)),
                publishFailed: if (LEGACY.contains(v)) s.publishFailed else s.publishFailed.union(Set(v)) },
  }

  // 11. 公開後の確認：1回ごとに時計が1進む。FAILED を読んだらすぐ失敗。上限まで返らなければ時間切れ
  action confirmPoll(v: int): bool = all {
    s.confirm.keys().contains(v),
    val st = s.confirm.get(v)
    all {
      st.status == Waiting,
      val now = s.clock + 1
      val d = deployOf(s, v)
      val seen = d == Published and s.visibleAt.get(v) <= now
      val polled =
        if (d == Failed) { ...st, status: Rejected }
        else if (d == Processing) { ...st, statusAttempts: st.statusAttempts + 1 }
        else if (seen) { ...st, status: Confirmed, attempts: st.attempts + 1 }
        else if (st.attempts + 1 >= CONFIRM_ATTEMPTS)
          { ...st, status: TimedOut, attempts: st.attempts + 1, whileProcessing: false }
        else { ...st, attempts: st.attempts + 1 }
      // 待ちの手順（deployment の状態の確認、上限 CONFIRM_ATTEMPTS）が処理中のまま時間切れになると、公開のジョブが失敗で
      // 終わる。リリースと repo1 の確認のジョブは動かない。回復は公開のジョブの再実行で、precheck が同じ deployment を
      // 待ち、PUBLISHED なら上げずに成功する（resumePublishJob）。確認だけの再実行は、この場合には無い（#934）
      val waitTimedOut = d == Processing and st.statusAttempts + 1 >= CONFIRM_ATTEMPTS
      // 待ちの手順が PUBLISHED を読むと、公開のジョブは成功で終わる
      val jobOk = if (d == Published) s.jobOk.union(Set(v)) else s.jobOk
      if (waitTimedOut)
        s' = { ...s, clock: now, confirm: s.confirm.keys().exclude(Set(v)).mapBy(x => s.confirm.get(x)),
               publishFailed: s.publishFailed.union(Set(v)) }
      else s' = { ...s, clock: now, jobOk: jobOk, confirm: s.confirm.put(v, { ...polled, lastPoll: now }) },
    },
  }

  // 12. repo1 の反映の時間切れからの回復。正しい手順：確認のジョブだけを再実行する（公開はしない）
  action rerunConfirm(v: int): bool = all {
    not(RERUN_WHOLE_PUBLISH),
    s.confirm.keys().contains(v),
    s.confirm.get(v).status == TimedOut,
    not(s.confirm.get(v).whileProcessing),
    s' = { ...s, confirm: s.confirm.put(v, { status: Waiting, attempts: 0, statusAttempts: 0, whileProcessing: false, lastPoll: -1 }) },
  }

  //     誤った回復：公開のジョブを丸ごと再実行する（事前の確認は、まだ返らない版を「無い」と見る）
  action rerunWholePublish(v: int): bool = all {
    RERUN_WHOLE_PUBLISH,
    not(TAG_IS_PUBLISH),
    s.confirm.keys().contains(v),
    s.confirm.get(v).status == TimedOut,
    nondet d = 0.to(MAX_DELAY).oneOf()
    val r = { ...s, confirm: s.confirm.put(v, { status: Waiting, attempts: 0, statusAttempts: 0, whileProcessing: false, lastPoll: -1 }) }
    if (publishGate(s, v)) s' = submit(r, v, d) else s' = r,
  }

  // 13. GitHub のリリース：deployment が PUBLISHED になった版にだけ作る（A2）。
  //     repo1 などへの反映の時間切れでは止めない（js#1161）
  action githubRelease(v: int): bool = all {
    not(OLD_PUBLISH),                 // 古い構成には、公開のあとのリリースのジョブが無い
    deployOf(s, v) == Published,
    s.jobOk.contains(v),              // 公開のジョブが成功で終わった（needs.release の出力が published か PUBLISHED。#934）
    RELEASE_AFTER_CONFIRM implies (s.confirm.keys().contains(v) and s.confirm.get(v).status == Confirmed), // rs（R6）
    not(s.releases.contains(v)),
    s' = { ...s, releases: s.releases.union(Set(v)) },
  }

  // 13b（R2b、§1.3）. 人が、ID の無い試みの ID を変数に入れる（Portal に無ければ none）。人は Portal を正しく読む前提
  action supplyId(v: int): bool = all {
    s.unknown.keys().contains(v),
    s' = { ...s, unknown: unknownWithout(s.unknown, v),
           // ID が入っても、確認とリリースは始まらない。公開のジョブを再実行し、precheck がその ID で待つか published と
           // 読んでから（#934 の CodeRabbit の指摘）
           recorded: if (s.unknown.get(v)) s.recorded.union(Set(v)) else s.recorded },
  }

  // 13c（R2b、B2）. 人が、記録された FAILED の deployment を Portal で drop する。その ID の照会は失敗し続ける
  action dropDeployment(v: int): bool = all {
    RECORD_VIEW,
    s.recorded.contains(v),
    deployOf(s, v) == Failed,
    not(s.stale.contains(v)),
    s' = { ...s, stale: s.stale.union(Set(v)), everStale: s.everStale.union(Set(v)) },
  }

  // 13d（R2b、B2）. 人が、drop した ID に none の行を変数に足す（変数は artifact より優先）
  action markNone(v: int): bool = all {
    s.stale.contains(v),
    // drop した ID は状態を返さなくなるので、その版の =none の食い違い（wrongNone）も解ける（#862 の CodeRabbit の指摘）
    s' = { ...s, stale: s.stale.exclude(Set(v)), recorded: s.recorded.exclude(Set(v)),
           noneConflict: s.noneConflict.exclude(Set(v)) },
  }

  // 13e（R2b、N1）. 人が、照会が状態を返す ID の試みに、取り違えて =none を書く（drop していない ID）。
  //     v3 の規則：照会はする。状態が返るので食い違いとして止まる。v2 の規則：照会を飛ばし、その deployment が見えなくなる
  action wrongNone(v: int): bool = all {
    RECORD_VIEW,
    s.recorded.contains(v),
    not(s.stale.contains(v)),
    if (NONE_SKIPS_QUERY) s' = { ...s, recorded: s.recorded.exclude(Set(v)) }
    else s' = { ...s, noneConflict: s.noneConflict.union(Set(v)) },
  }

  // 13f（R2b、N1）. 人が、取り違えた =none の行を消す
  action fixNone(v: int): bool = all {
    s.noneConflict.contains(v),
    s' = { ...s, noneConflict: s.noneConflict.exclude(Set(v)) },
  }

  // 14. 移行前の版（kotlin・scala の v5.2.0）の公開。古い実行の再実行で、タグのコミットのワークフローのまま出す。
  //     古いワークフローは関門を持たない。守るのは手順（R3：再実行の前に Portal で処理中・公開済みが無いことを確かめる）
  action publishLegacy(v: int): bool = all {
    not(TAG_IS_PUBLISH),
    LEGACY.contains(v),
    s.tags.keys().contains(v),
    PRECHECK_SEES_DEPLOYMENTS implies not(inFlightOrDone(s, v)),
    not(s.published.contains(v)),
    nondet d = 0.to(MAX_DELAY).oneOf()
    s' = submit(s, v, d),
  }

  // 15. 古い版上げ（scala の Bump Version、R5 の前）：PR を通らずに API で main の先頭にタグを打ち、
  //     公開の前に GitHub のリリースを作る。タグの push で古い publish.yml が動く（N2）
  action oldBumpTag(v: int): bool = all {
    OLD_BUMP,
    v > latestTag(s),
    s' = arrivePublish({ ...s, tags: s.tags.put(v, s.head), oldTags: s.oldTags.union(Set(v)),
                         releases: s.releases.union(Set(v)) }, v),
  }

  action step: bool = {
    nondet v = VERSIONS.oneOf()
    nondet pre = Set(true, false).oneOf()
    nondet changes = Set(true, false).oneOf()
    nondet same = Set(true, false).oneOf()
    nondet only = Set(true, false).oneOf()
    nondet flag = Set(true, false).oneOf()
    nondet assocDelay = 0.to(MAX_ASSOC_DELAY).oneOf()
    any {
      openReleasePR(v),
      openOtherPR(v, pre, changes, same, only),
      // 開いている PR の ID はすべて選べる（openReleasePR は nextPr に上限を付けない。#862 の CodeRabbit の指摘）
      nondet p = 0.to(s.nextPr).oneOf()
      mergePR(p, assocDelay),
      nondet id = 0.to(MAX_COMMITS).oneOf()
      any { tagJob(id), rerunTagJob(id), rerunCancelledTag(id), cancelPendingTag(id) },
      pushTagByHand(v),
      publishJob(v, flag),
      rerunPublishJob(v),
      resumePublishJob(v),
      rerunCancelledPublish(v),
      cancelPendingPublish(v),
      portalResolve(v, flag),
      confirmPoll(v),
      rerunConfirm(v),
      rerunWholePublish(v),
      githubRelease(v),
      supplyId(v),
      dropDeployment(v),
      markNone(v),
      wrongNone(v),
      fixNone(v),
      publishLegacy(v),
      oldBumpTag(v),
    }
  }

  // ---------------------------------------------------------------- 不変条件
  // I1. 公開先に出る版（処理中を含む）は、版上げの PR 由来で main に載ったコミットからだけ（移行前の版を除く。除いた版は I6 で見る）
  val publishedOnlyFromReleasePR: bool =
    s.deploy.keys().filter(v => inFlightOrDone(s, v)).exclude(LEGACY).exclude(Set(INIT_TAG)).forall(v =>
      s.tags.keys().contains(v)
      and s.commits.get(s.tags.get(v)).squashOfReleasePR
      and s.commits.get(s.tags.get(v)).ver == v)

  // I2. 公開先が PUBLISHED にする版は、単調に増える
  val publishedMonotonic: bool = strictlyIncreasing(s.publishOrder)

  // I3. 関門が打つタグは、単調に増える
  val tagsMonotonic: bool = strictlyIncreasing(s.tagOrder)

  // I4. 処理中・公開済みの版を、もう一度出そうとしない（公開先の拒否に頼らない）
  val noDuplicatePublish: bool = s.duplicateAttempts == 0

  // I5. 関門が打ったタグは、版上げの PR の squash を指し、版と一致する
  val gateTagsOnReleaseCommits: bool =
    s.tagOrder.foldl(true, (ok, v) => ok and s.commits.get(s.tags.get(v)).squashOfReleasePR
                                         and s.commits.get(s.tags.get(v)).ver == v)

  // I6. 移行前の版は、タグのあるコミットの版のまま出る
  val legacyFromItsTag: bool =
    LEGACY.forall(v => s.published.contains(v) implies (s.tags.keys().contains(v) and s.commits.get(s.tags.get(v)).ver == v))

  // I6b（A1）. 移行前の版より新しい版が公開先に出る（処理中を含む）なら、移行前の版は既に公開先に出ている
  val legacyBeforeNewer: bool =
    LEGACY.forall(old =>
      s.deploy.keys().forall(w => (w > old and inFlightOrDone(s, w)) implies s.published.contains(old)))

  // I6c（#934 の CodeRabbit の指摘）. 公開先に必要な版より新しい版が公開先に出る（処理中を含む）なら、必要な版は repo1 に
  //     見えている（Portal の PUBLISHED だけでは足りない）。見えることは単調なので、アップロードの時点で見えていたことと同じ
  val requiredVisibleBeforeNewer: bool =
    REQUIRED_PUBLISHED.forall(req =>
      s.deploy.keys().forall(w => (w > req and inFlightOrDone(s, w)) implies isVisible(s, req)))

  // I7（A2 で強めた）. GitHub のリリースは、deployment が PUBLISHED になった版にだけ。
  //     例外は移行の時点のタグだけ（kotlin・scala の v5.2.0 は今この例外に当たる）
  val releaseOnlyAfterPublished: bool =
    s.releases.forall(v => s.published.contains(v) or v == INIT_TAG)

  // I8. 途中で止まっても、手順で回復できる状態だけが残る：
  //     関門が打った最新のタグがまだ PUBLISHED でないなら、公開のジョブが待っている、どこかの deployment が処理中（待てば決まる）、
  //     または失敗したジョブ・取り消された run（#863）の再実行で関門を通る
  val stopsAreRecoverable: bool =
    val v = latestTag(s)
    (s.tagOrder.indices().exists(i => s.tagOrder[i] == v) and not(s.published.contains(v)) and not(TAG_IS_PUBLISH))
      implies (s.publishPending.contains(v) or anyProcessing(s)
               or ((s.publishFailed.contains(v) or (RERUN_CANCELLED and s.publishSkipped.contains(v))) and publishGate(s, v))
               // R2b：ID の無い試み、drop した ID があれば、人が変数に行を足すと進む（supplyId、markNone）
               or s.unknown.keys().size() > 0 or s.stale.size() > 0 or s.noneConflict.size() > 0)

  // I8b（#863）. 最新のタグより大きい版の、タグの無い版上げのコミットは、どれも回復できる：タグのジョブが待っている、
  //     失敗したジョブを再実行できる、または取り消された run を再実行できる。関門（tag のモード）が求めるのは main から届くことと
  //     最新のタグより大きいことだけで、main の先頭であることは求めない（版を変えないマージのあとも、再実行すればタグが付く）。
  //     あとから着いた古いコミットの再実行が、新しい版上げのタグのジョブを置き換えうる
  val untaggedReleaseRecoverable: bool =
    s.commits.keys().forall(id =>
      val c = s.commits.get(id)
      val p = s.commits.get(c.parent)
      // 降版（親より小さい版）は関門が何度でも拒否するので対象から外す（#864 の CodeRabbit・Devin の指摘）
      (TAG_PUSH_ENABLED and id > 1 and c.squashOfReleasePR and not(c.pre) and key(c.ver, c.pre) > key(p.ver, p.pre)
         and c.ver > latestTag(s) and not(s.tags.keys().contains(c.ver)))
        implies (s.tagPending.contains(id) or s.tagFailed.contains(id)
                 or (RERUN_CANCELLED and s.tagSkipped.contains(id))))

  // I8c（#934）. PUBLISHED になった最新のタグの版に GitHub のリリースが無いなら、手順で作れる：公開のジョブが成功した
  //     （リリースのジョブが動ける）、待ちの手順が動いている、公開のジョブが待っている、どこかの deployment が処理中、
  //     失敗したジョブ・取り消された run の再実行で precheck が published と読む、または人が変数に行を足すと進む。
  //     最新のタグでない版は「新しいタグの前に公開された版」の手の手順（CONTRIBUTING）で、ここでは見ない
  val publishedReleaseRecoverable: bool =
    s.published.exclude(LEGACY).exclude(Set(INIT_TAG)).forall(v =>
      (not(TAG_IS_PUBLISH) and not(OLD_PUBLISH) and not(s.releases.contains(v)) and v == latestTag(s))
        implies ((s.jobOk.contains(v) and (RELEASE_AFTER_CONFIRM implies s.confirm.keys().contains(v)))
                 or s.publishPending.contains(v) or anyProcessing(s)
                 or (s.confirm.keys().contains(v) and s.confirm.get(v).status == Waiting)
                 or ((s.publishFailed.contains(v) or (RERUN_CANCELLED and s.publishSkipped.contains(v))) and resumable(s, v))
                 or s.unknown.keys().size() > 0 or s.stale.size() > 0 or s.noneConflict.size() > 0))

  // I9. 公開済み（PUBLISHED）の版の確認が時間切れになるのは、反映の遅れが待ちの上限を超えたときだけ（js#1161）。
  //     処理中のままの時間切れは、確認だけを再実行して待つ
  //     （#862 の CodeRabbit の指摘で強めた）反映の確認が時間切れなら、最後の確認の時刻（lastPoll）には、公開先はまだ返していない。
  //     最後の確認と同時に返し始めた deployment を時間切れにすれば破れる。加えて、その遅れは確認の上限以上
  val timeoutOnlyBeyondBudget: bool =
    s.confirm.keys().forall(v => (s.confirm.get(v).status == TimedOut and not(s.confirm.get(v).whileProcessing))
                                   implies (s.visibleAt.keys().contains(v)
                                            and s.visibleAt.get(v) > s.confirm.get(v).lastPoll
                                            and s.delayOf.get(v) >= CONFIRM_ATTEMPTS))

  // I10（A2）. FAILED を読んだ確認は、リリースを作らせない
  val noReleaseForFailed: bool =
    s.releases.forall(v => v == INIT_TAG or deployOf(s, v) == Published)

  // I11（R2b、V2）. 始まったのに ID の無い試みがあるあいだは、新しいアップロードをしない
  val noUploadWhileUnknown: bool = s.uploadsWhileUnknown == 0

  // I17（rs、R6）. GitHub のリリースは、公開後の確認（sparse index が版を返す）が Confirmed の版にだけ。
  //     safety には RELEASE_AFTER_CONFIRM の下でだけ入れる。条件を持たない構成（rsReleaseNotGated）で破れることも確かめる
  val releaseOnlyAfterConfirmed: bool =
    s.releases.exclude(Set(INIT_TAG)).forall(v => s.confirm.keys().contains(v) and s.confirm.get(v).status == Confirmed)

  val safety: bool = all {
    RELEASE_AFTER_CONFIRM implies releaseOnlyAfterConfirmed,
    publishedOnlyFromReleasePR, publishedMonotonic, tagsMonotonic, noDuplicatePublish,
    gateTagsOnReleaseCommits, legacyFromItsTag, legacyBeforeNewer, requiredVisibleBeforeNewer, releaseOnlyAfterPublished,
    stopsAreRecoverable, untaggedReleaseRecoverable, publishedReleaseRecoverable, timeoutOnlyBeyondBudget, noReleaseForFailed, noUploadWhileUnknown,
  }

  // 確認の上限が反映の遅れを覆うなら、PUBLISHED の版の確認は時間切れにならない（js#1161 の直しの条件）
  val neverTimesOutAfterPublished: bool =
    s.confirm.keys().forall(v => not(s.confirm.get(v).status == TimedOut and not(s.confirm.get(v).whileProcessing)))

  // ---------------------------------------------------------------- 到達の確認（witness）
  val wReleaseOpened: bool = s.prs.keys().exists(p => s.prs.get(p).releaseBranch)
  val wTagged: bool = s.tagOrder.length() > 0
  val wPublished: bool = s.published.exclude(Set(INIT_TAG)).size() > 0
  val wConfirmed: bool = s.confirm.keys().exists(v => s.confirm.get(v).status == Confirmed)
  val wTimedOut: bool = s.confirm.keys().exists(v => s.confirm.get(v).status == TimedOut)
  val wReleased: bool = s.releases.size() > 1
  val wTagLookupFailed: bool = s.tagFailed.size() > 0
  val wTagSkipped: bool = s.tagSkipped.size() > 0
  val wPublishRefused: bool = s.publishFailed.size() > 0
  val wPublishSkipped: bool = s.publishSkipped.size() > 0
  // #863：古い版の再実行が、待っている新しい版を置き換えた／先頭のタグのジョブが置き換えられた
  val wNewerSkipped: bool = s.publishSkipped.exists(v => v == latestTag(s) and not(s.published.contains(v)))
  val wHeadTagSkipped: bool = s.tagSkipped.contains(s.head)
  // 置き換えられたタグのジョブの版が、版を変えないマージのあとも main の今の版のまま（先頭ではない）
  val wSkippedBelowHead: bool = s.tagSkipped.exists(id => id != s.head and s.commits.get(id).ver == headCommit(s).ver
                                                    and not(s.tags.keys().contains(s.commits.get(id).ver)))
  val wDeployFailed: bool = s.failedOnce.size() > 0
  val wFailedThenPublished: bool = s.failedOnce.exists(v => s.published.contains(v))
  val wJobFailedAfterSubmit: bool = s.jobFailedAfterSubmit.size() > 0
  val wLegacyPublished: bool = LEGACY.exists(v => s.published.contains(v))
  val wNewerAfterLegacy: bool = LEGACY.exists(v => s.published.contains(v) and s.published.exists(w => w > v))
  val wOtherVersionMerged: bool = s.commits.keys().exists(i => i > 1 and not(s.commits.get(i).squashOfReleasePR)
                                                          and s.commits.get(i).ver != s.commits.get(s.commits.get(i).parent).ver)
  val wTwoTags: bool = s.tagOrder.length() >= 2
  val wTwoReleases: bool = s.releases.exclude(Set(INIT_TAG)).size() >= 2
  val wWouldTag: bool = s.wouldTag.size() > 0
  val wUnknown: bool = s.unknown.keys().size() > 0
  val wUnknownResolved: bool = s.everUnknown.exists(v => s.published.contains(v)) and s.unknown.keys().size() == 0
  val wStale: bool = s.stale.size() > 0
  val wNoneConflict: bool = s.noneConflict.size() > 0
  val wStaleThenPublished: bool = s.everStale.exists(v => s.published.contains(v))
}

// ---------------------------------------------------------------- 言語ごとのインスタンス
// 版の番号：1 = 5.2.0、2 = 5.2.1 / 5.3.0、3 以降 = その次

// java：5.2.0 は Central にある。main は 5.2.1-SNAPSHOT。Central は2段
module java {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = true, OTHER_PRS = true,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 6, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 6,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 7
  ).*
}

// java で、ほかの PR を外し、版を続けて出す経路を多く試す（D1）
module javaReleasesOnly {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 2, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 6,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).*
}

// kotlin：v5.2.0 のタグと GitHub のリリースはあるが、Central に無い。関門の設定「公開先に必要な版：5.2.0」。
// R4（event-store-adapter-kotlin）の形：事前の確認は deployment を記録を通してだけ見る（RECORD_VIEW、javaR2b と同じ）
module kotlin {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(1), REQUIRED_PUBLISHED = Set(1),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = true, OTHER_PRS = true,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 6, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 6,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 7
  ).*
}

// kotlin で手のタグなし（設計レビューの kotlinNoManual と同じ条件）。I6b が破れないことを示す
module kotlinNoManual {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(1), REQUIRED_PUBLISHED = Set(1),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = true,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 6, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 6,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 7
  ).*
}

// kotlin（R4）で、ほかの PR と手のタグを外し、5.2.0 のあとに版を続けて出す経路を多く試す
module kotlinReleasesOnly {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(1), REQUIRED_PUBLISHED = Set(1),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 2,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).*
}

// scala：kotlin と同じく v5.2.0 のタグと GitHub のリリースはあるが、Central に無い。main の `version` は 5.2.0（R5 で足す。
// プレリリースを経ない）。関門の設定「公開先に必要な版：5.2.0」。R5（event-store-adapter-scala）の形：publish.yml は bundle を上げ、
// 事前の確認は deployment を記録を通してだけ見る（RECORD_VIEW、javaR2b・kotlin と同じ）
module scala {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(1), REQUIRED_PUBLISHED = Set(1),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = true, OTHER_PRS = true,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 6, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 6,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 7
  ).*
}

// scala（R5）で手のタグなし。I6b が破れないことを示す
module scalaNoManual {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(1), REQUIRED_PUBLISHED = Set(1),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = true,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 6, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 6,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 7
  ).*
}

// scala（R5）で、ほかの PR と手のタグを外し、5.2.0 のあとに版を続けて出す経路を多く試す
module scalaReleasesOnly {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(1), REQUIRED_PUBLISHED = Set(1),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 2,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).*
}

// rs（R6）：main は 5.2.0（プレリリースを経ない）。crates.io は受け付け＝公開（ASYNC_PORTAL = false）。
// 事前の確認は crates.io の API を直に読む（記録を通さない：RECORD_VIEW = false。API は受け付けた版をすぐ返すので
// PRECHECK_SEES_DEPLOYMENTS = true）。事後の確認は sparse index（遅れ MAX_DELAY）。リリースは事後の確認のあと
module rs {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = true, OTHER_PRS = true,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 6, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 6,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = true, PRECHECK_ACCEPTED_LATEST = true,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 7
  ).*
}

// rs で手のタグなし
module rsNoManual {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = true,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 6, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 6,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = true, PRECHECK_ACCEPTED_LATEST = true,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 7
  ).*
}

// rs で、ほかの PR と手のタグを外し、版を続けて出す経路を多く試す
module rsReleasesOnly {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 2,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = true, PRECHECK_ACCEPTED_LATEST = true,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).*
}

// go：タグの push が公開。手でタグを作れない前提（A4：今の PAT のままでは作れない。design.md の R7 を参照）。
// 確認の間隔 5 分 × 8 回 = 40 分。プロキシの「無い」の記憶（最大 30 分）＋取得を 7 回分とする（B1）
module go {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = true, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = true,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 6, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 7,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 7
  ).*
}

// ---- 前提を外すと破れることを示すインスタンス（違反を期待する）

// kotlin で、関門の設定「公開先に必要な版」を持たない場合（I6b が破れる見込み。設計レビュー A1 の再現）
module kotlinNoRequired {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(1), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 0,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 5
  ).*
}

// scala（R5）で、関門の設定「公開先に必要な版」を持たない場合（I6b が破れる見込み。A1 の scala での再現）
module scalaNoRequired {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(1), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 0,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 5
  ).*
}

// go でタグの rulesets が無い場合（I1 が破れる見込み）
module goManualTags {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = true, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = true, OTHER_PRS = true,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 0,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 5
  ).*
}

// js#1158 の確認の待ち（6回×10秒）と、実測の反映の遅れ（約3分＝18回分）。時間切れに届く見込み
module jsBefore1161 {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 6, MAX_DELAY = 18,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 4
  ).*
}

// 時間切れのあと、公開のジョブを丸ごと再実行し、事前の確認が deployment を見ない場合（I4 が破れる見込み）
module wholeRerun {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = false, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 2, MAX_DELAY = 6,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = true, MAX_COMMITS = 4
  ).*
}

// 公開の操作のあとでジョブが失敗し、その再実行の事前の確認が deployment を見ない場合（I4 が破れる見込み。設計レビュー A3）
module noDeploymentCheck {
  import release_path(
    VERSIONS = 1.to(3), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = false, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 0,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = false,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 4
  ).*
}

// rs で、事前の確認が crates.io の API を見ず、遅れのある sparse index だけを見る場合。公開の操作のあとでジョブが落ち、
// index にまだ出ていない間に再実行すると、二度目を出す（I4 が破れる見込み）
module rsNoPrecheck {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = false, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 3,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = true, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 4
  ).*
}

// rs で、関門と事前の確認が「最新のタグか」を確かめない場合。事前の確認の最大の版は受理済みの版のすべてから
// （crates.io の API）なので、それだけで I2 は保たれる見込み（#375 の CodeRabbit の指摘。最新のタグの確認は二重の守り）
module rsNoLatestTagCheck {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 2,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = false, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = true, PRECHECK_ACCEPTED_LATEST = true,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).*
}

// rs で、事前の確認の最大の版が、公開先に見える版だけから決まる場合（遅れがある）。最新のタグの確認だけで I2 は保たれる見込み
module rsVisibleLatest {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 2,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = true, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).*
}

// rs で、最大の版が見える版だけから決まり、最新のタグも確かめない場合（I2 が破れる見込み）。
// 上の2つと合わせ、2つの確認のどちらか1つがあれば足り、両方が無いと破れることを示す
module rsNoLatestCheck {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 2,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = false, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = true, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).*
}

// rs で、事後の確認の上限が index の遅れより短い場合（js#1161 と同じ。PUBLISHED の版の時間切れが起きる見込み）
module rsShortConfirm {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 2, MAX_DELAY = 6,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = true, PRECHECK_ACCEPTED_LATEST = true,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 4
  ).*
}

// rs で、githubRelease が確認を待たない場合（Central の形のまま）。I17 が破れる見込み（R6 の設計レビュー M2）
module rsReleaseNotGated {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = false, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 3,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = true,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 4
  ).*
}

// ---- 移行の途中の構成（再レビュー N1・N2・N3）

// java で R2a だけが main にある間：タグのジョブはタグを push しない。公開は古い release.yml のまま。
// 古い Bump-Version は R2a が置き換える。違反しないことを示す（N1 の直し）
module javaR2aOnly {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = true,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 6, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 6,
    NEW_PATH = true, TAG_PUSH_ENABLED = false, OLD_PUBLISH = true, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 7
  ).*
}

// 同じ構成で、R2a のタグのジョブがタグを push する場合（I4 が破れる見込み。再レビュー N1 の再現）
module javaR2aPushesTags {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 0,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = true, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 5
  ).*
}

// scala で R5 の前（12/1 の再実行の期間）：古い Bump Version を止めてある。古い publish.yml の再実行で 5.2.0 を出す
module scalaBeforeR5 {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(1), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = true,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 6, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 6,
    NEW_PATH = false, TAG_PUSH_ENABLED = false, OLD_PUBLISH = true, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 7
  ).*
}

// 同じ期間に、古い Bump Version が動く場合（I6b が破れる見込み。再レビュー N2 の再現）
module scalaOldBumpLive {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 1, INIT_PRE = false, INIT_TAG = 1, LEGACY = Set(1), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 0,
    NEW_PATH = false, TAG_PUSH_ENABLED = false, OLD_PUBLISH = true, OLD_BUMP = true, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 5
  ).*
}

// 事前の確認が、自分の版の deployment しか見ない場合（I2 が破れる見込み。再レビュー N3 の再現）
module noOtherDeploymentCheck {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 0,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = false,
    RECORD_VIEW = false, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).*
}

// ---- R2b（design-r2b.md §5）

// java の R2b：記録を通してだけ deployment を見る。アップロードの手順が始まったあと、ID を残す前に落ちうる。
// 落ちた試みは境の規則で必ず「始まった」と見分け（A1）、ID の無い試みがあれば止まる。違反しないことを示す
module javaR2b {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = true, OTHER_PRS = true,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 6, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 6,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 7
  ).*
}

// 同じ構成で、ほかの PR を外し、続けて出す経路と回復の経路を多く試す
module javaR2bReleasesOnly {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 2,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).*
}

// 手順の一覧が途中で切れた job を数えない規則（直す前の追記。A1）：落ちた試みが見えない（I4 か I2 が破れる見込み）
module stepRecordDropped {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 0,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = false, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).*
}

// ID の無い試みがあっても止まらない場合（V2 の再現。I4 か I2 が破れる見込み）
module unknownIgnored {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 0,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = false, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).*
}

// v2 の規則（=none は artifact の ID の照会を飛ばす）。取り違えた =none で処理中・公開済みの deployment が見えなくなる
// （I4 か I2 が破れる見込み。再レビュー N1 の再現。javaR2bReleasesOnly と同じ構成で NONE_SKIPS_QUERY だけを立てる）
module noneSkipsQuery {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 2,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = true, PRECHECK_LATEST_TAG = true, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).*
}

// 事前の確認が「最新のタグか」を確かめない場合。FAILED の版の再実行が、あとの版の PUBLISHED のあとに出る（I2 が破れる見込み）。
// モデルの関門は、判定とアップロードを1つの動作で行い、決めるときのタグを読む（待ちは「関門で落ちて再実行」で表す）。
// このインスタンスが示すのは、最新のタグの確かめが要ること。待ちのあとにタグを読み直すことは、
// .github/tests/test_central_portal.py の test_precheck_rereads_the_tags_after_waiting で確かめる（#862）
module noLatestTagCheck {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 2,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = false, RERUN_CANCELLED = true, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false,
    RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).*
}

// #863：置き換えられて取り消された run を再実行しない（直す前の §6 の行「そのまま」）。古い版の再実行が最新の版の待ちを
// 置き換えると、最新のタグが公開されないまま止まる（I8 が破れる見込み）。javaR2bReleasesOnly と同じ構成で RERUN_CANCELLED だけを外す
module cancelledLeftAlone {
  import release_path(
    VERSIONS = 1.to(4), INIT_VER = 2, INIT_PRE = true, INIT_TAG = 1, LEGACY = Set(), REQUIRED_PUBLISHED = Set(),
    TAG_IS_PUBLISH = false, ASYNC_PORTAL = true, PRECHECK_SEES_DEPLOYMENTS = true, MANUAL_TAGS = false, OTHER_PRS = false,
    LOOKUP_ATTEMPTS = 5, MAX_ASSOC_DELAY = 0, CONFIRM_ATTEMPTS = 8, MAX_DELAY = 2,
    NEW_PATH = true, TAG_PUSH_ENABLED = true, OLD_PUBLISH = false, OLD_BUMP = false, PRECHECK_SEES_OTHER_DEPLOYMENTS = true,
    RECORD_VIEW = true, UNKNOWN_DETECTED = true, UNKNOWN_STOPS = true, NONE_SKIPS_QUERY = false, PRECHECK_LATEST_TAG = true,
    RERUN_CANCELLED = false, RELEASE_AFTER_CONFIRM = false, PRECHECK_ACCEPTED_LATEST = false, RERUN_WHOLE_PUBLISH = false, MAX_COMMITS = 6
  ).*
}
