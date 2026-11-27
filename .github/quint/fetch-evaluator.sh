#!/usr/bin/env bash
# quint 0.32.0 の Rust の評価器（evaluator/v0.6.0）を、認証つきの gh で取り寄せ、quint が読む場所に置く。
# quint は、$QUINT_HOME/rust-evaluator-v0.6.0/quint_evaluator が無いときだけ、GitHub の API を認証なしで読んで取り寄せる
# （@informalsystems/quint 0.32.0 の dist/src/rust/binaryManager.js と dist/src/config.js。認証のヘッダを付けない）。
# 認証なしの API は IP ごとに 1 時間 60 回までで、GitHub のランナーでは使い切られていることがある（#375 の release-model の失敗）。
# 使い方: GH_TOKEN=... fetch-evaluator.sh <QUINT_HOME>
# 取り寄せた tar.gz は、下の SHA-256（GitHub のリリースの資産の digest）と照らし合わせ、違えば置かない。
set -euo pipefail

home="$1"
version=v0.6.0
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    asset=quint_evaluator-x86_64-unknown-linux-gnu.tar.gz
    digest=61755a09d5052d93a4e75e840059edfd0d3674aeda164b9d2464be3d6e21b1c2 ;;
  Linux-aarch64)
    asset=quint_evaluator-aarch64-unknown-linux-gnu.tar.gz
    digest=07e5ec9c756feba0db59987c9f90456dacfecf75f64f111b791b66c770a293d2 ;;
  Darwin-arm64)
    asset=quint_evaluator-aarch64-apple-darwin.tar.gz
    digest=5d15ae38ef9bee3da14a29486d9a65bfbc27c3074adb96a2a89d457215ec8bd5 ;;
  Darwin-x86_64)
    asset=quint_evaluator-x86_64-apple-darwin.tar.gz
    digest=dcebb5a58372c77b47a3a419419d182b62cc7604a9be89a24e2c37b19217b038 ;;
  *)
    echo "unsupported platform: $(uname -s) $(uname -m)" >&2
    exit 1 ;;
esac

target="${home}/rust-evaluator-${version}"
if [[ -x "${target}/quint_evaluator" ]]; then
  echo "the evaluator ${version} is already in ${target}"
  exit 0
fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
gh release download "evaluator/${version}" --repo informalsystems/quint --pattern "$asset" --dir "$work"
actual="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "${work}/${asset}")"
if [[ "$actual" != "$digest" ]]; then
  echo "${asset} has the SHA-256 ${actual}, but ${digest} is expected" >&2
  exit 1
fi
mkdir -p "$target"
tar -xzf "${work}/${asset}" -C "$target"
chmod +x "${target}/quint_evaluator"
echo "the evaluator ${version} is in ${target}"
