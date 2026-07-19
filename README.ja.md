# wtshunt

[English](README.md)

`wtshunt` は、あるサービス(たとえばフロントエンドの dev サーバ)が固定
ポートを叩き続けたまま、そのバックエンド(たとえば Rails アプリ)を複数の
git worktree で並行して動かすためのツールです。worktree ごとにバック
エンドのサーバが別ポートで立ち、小さなリバースプロキシが固定ポートに
座って「アクティブ」な worktree に転送します。切り替えは次のリクエスト
から即座に反映され、フロントエンドの再起動も `.env` の書き換えも `cd`
も不要です。

名前は **worktree shunt** の略です。shunt(入換)とは鉄道の操車場で、
ヤード全体を止めることなく車両を別の線路へ振り分ける操作のこと —
wtshunt がトラフィックに対してやっているのはまさにこれです。

direnv やシェルの alias のようなディレクトリ単位のツールが影響できる
のは**これから起動する**プロセスだけで、すでに動いているクライアントの
向き先は変えられません。その「すでに動いているクライアントの向き先を
変える」ことこそが wtshunt の存在理由です。

- worktree のサーバをフォアグラウンドで起動: `wtshunt serve`
- worktree に `cd` せずに単発コマンドを実行: `wtshunt run`
- プロキシの向き先 worktree を切り替え: `wtshunt use`
- 全 worktree の稼働状況を一覧: `wtshunt status`

## これが不要な人

- git worktree をそもそも使っていないなら、出番はありません。
- クライアント側を気軽に再起動できる、あるいは接続先を env 変数や
  設定ファイルから読み直せる構成なら、そのポートを直接向ければ済みます。
- 同時に動かす worktree が常に1つだけなら、従来通り `cd` して起動・
  停止するだけで十分です。

## 動作要件

- Node.js 20 以上(開発は Node 25 で実施)
- macOS または Linux — POSIX の `sh` とプロセスグループに依存し、
  ポート競合の診断に `lsof` を使います
- `git`(worktree の列挙に `git worktree list` を使用)
- [peco](https://github.com/peco/peco) は任意。無ければ worktree の
  選択は番号入力のプロンプトにフォールバックします

## インストール

```sh
npm install
npm link
```

`npm link` で `wtshunt` 実行ファイルが `PATH` に入ります
([tsx](https://github.com/privatenumber/tsx) 経由で動くのでビルドは
不要 — `src/` を編集すれば即座に反映されます)。リンクせずに試したい
場合は、チェックアウトから直接 `./bin/wtshunt.js <command>` を実行
できます。

## クイックスタート

```sh
# 1. バックエンドのリポジトリを登録(初回のみ。下の「設定」参照)
mkdir -p ~/.config/wtshunt && $EDITOR ~/.config/wtshunt/config.toml

# 2. worktree ごとにサーバを温める — ターミナルのタブを分けてフォアグラウンドで
wtshunt serve api/feature-x
wtshunt serve api/feature-y      # 別のタブで

# 3. 固定ポートにプロキシを立てる(さらに別のタブ、これもフォアグラウンド)
wtshunt proxy api

# 4. 固定ポートの向き先を好きなタイミングで切り替える
wtshunt use api                  # ピッカーが開き、次のリクエストから反映
```

プロキシはオプトインです。起動していないあいだは `fixed_port` を何も
占有せず、他のコマンドはそれまで通りに動きます。

## 設定

設定ファイルは `$XDG_CONFIG_HOME/wtshunt/config.toml`(未設定なら
`~/.config/wtshunt/config.toml`)。リポジトリごとに `[repos.<name>]`
テーブルを1つ定義します:

```toml
[repos.api]
path = "~/work/api"           # リポジトリ本体のチェックアウトのパス
fixed_port = 3000              # 他のサービスが常に叩くポート
port_range = [3101, 3199]      # 各 worktree に割り当てるポートの範囲
serve = "bundle exec rails s -p {port}"

[repos.front]
path = "~/work/front"
fixed_port = 8080
port_range = [8101, 8199]
serve = "API_URL=http://127.0.0.1:{port:api} PORT={port} npm run dev"
```

- `path` はリポジトリ本体のチェックアウトを指し、`~` 展開が使えます。
  wtshunt は worktree を作りません — `git worktree add` で自分で追加
  してください。`git worktree list` が返すもの(本体チェックアウトを
  含む)がすべて選択対象になります。
- `serve` は `sh -c` で実行され、`{port}` がその worktree に割り当て
  られたポートに置換されます。そのため
  `serve = "PORT={port} bin/dev"` のような環境変数プレフィックス形式も
  使えます。リテラルの `{port}` プレースホルダは必須で、含まれていない
  場合は設定の読み込み自体が失敗します — これが無いとサーバはフレーム
  ワークのデフォルトポートで起動する一方、`status` とプロキシは割り当て
  ポートにいると思い込んだままになるためです。
- `serve` は `{port:<repo>}` で別の登録済みリポジトリのポートも参照
  できます — 上の `front` のテンプレートは `{port:api}` を `api` の
  アクティブ worktree が使っているポートに解決し、まだ割り当てが無け
  れば新たに割り当てます。これが複数リポジトリの worktree を結びつけ
  る仕組みです。詳しくは下の「タスク」を参照してください。
- 一度 `wtshunt serve` されたことのある worktree は、再起動しても同じ
  ポートを使い続けます(sticky 割り当て)。割り当て時にポートの占有を
  検知した場合のみ、`port_range` 内の次の空きポートが使われます。この
  占有チェックは IPv4 と IPv6 のワイルドカードアドレスへの bind を試す
  ため、どのインターフェースで listen していても他プロセスを検知でき
  ますが、すり抜けるケースは残ります(「制約とトラブルシューティング」
  参照)。

設定ファイルが無い場合、`wtshunt` は上と同じ2リポジトリ構成の例を
表示して終了します。

## コマンド

ほとんどのコマンドは省略可能な `<repo>` または `<repo>/<worktree>`
引数を取ります。`<repo>` だけならそのリポジトリの「アクティブ」な
worktree が対象になり、リポジトリ引数を省略した場合はカレント
ディレクトリから推測します(各リポジトリの本体チェックアウトと全
worktree に対して、シンボリックリンクを解決した上で照合します)。

### `wtshunt use [repo]`

リポジトリの「アクティブ」な worktree を選びます。`repo/worktree`
形式なら直接セット。`repo` だけ(または cwd から推測)ならピッカーが
開きます: `PATH` に [peco](https://github.com/peco/peco) があれば
peco、無ければ番号選択のプロンプトです。プロキシが稼働中なら、切り替え
た瞬間から新しいアクティブ worktree にルーティングされます — 再起動は
不要です。その worktree のサーバがまだ起動していなければ、`use` は
警告を出して `wtshunt serve` の実行を促します。

### `wtshunt serve [repo]`

アクティブな(または指定した)worktree のサーバを、その worktree の
ディレクトリで、割り当てポートを使ってフォアグラウンドで起動します。
すでにサーバが動いている worktree への重複起動は拒否します。
`SIGINT`/`SIGTERM` は子プロセスグループに転送されるので、`Ctrl-C` で
きれいに止まります。

### `wtshunt run [repo[/worktree]] <cmd...>`

worktree のディレクトリの中で任意のコマンドを実行します。自分で `cd`
する必要はありません — たとえば `wtshunt run api bin/rails console`、
そのリポジトリの中にいるなら単に `wtshunt run bin/rails console` と
書けます。内側のコマンドのフラグは一切加工されずに素通しされます
(`run` については `wtshunt` はオプションパースを一切しません)。
`wtshunt run api bin/rails s -p 3105` は手で実行したのと完全に同じ
ように動きます。

### `wtshunt status`

設定済みの各リポジトリについて、アクティブな worktree、稼働中の全
サーバ(worktree、ブランチ、ポート、pid)、プロキシの稼働状況と現在の
転送先を表示します。(定義済みのタスクも一覧します — 下の
「タスク (experimental)」を参照してください。) `wtshunt status --json`
は同じ内容を機械可読な JSON として出力します:

```sh
wtshunt status --json | jq '.repos[] | {name, active}'
```

### `wtshunt stop [repo]`

アクティブな(または指定した)worktree のサーバを停止します: プロセス
グループに `SIGTERM` を送った後、実際に終了したことを最大2秒ポーリング
で確認してから `wtshunt status` の一覧から取り除きます。それでも生きて
いれば、エントリはそのまま残し `stop` は警告付きで exit 1 になります
(「制約とトラブルシューティング」参照)。

### `wtshunt proxy [repo]`

リポジトリの `fixed_port` でリバースプロキシをフォアグラウンド起動
します。停止は `Ctrl-C` です。すべてのリクエストは、その時点で
アクティブな worktree に転送されます。転送先はリクエストごとにディスク
から読み直されるため、`wtshunt use` は次の**新規接続**から反映され、
プロキシは起動しっぱなしで構いません。レスポンス(エラーレスポンスを
含む)には、処理した(あるいは処理に失敗した)worktree 名を示す
`X-Wtshunt-Worktree` ヘッダが付きます。アクティブな worktree のサーバ
が動いていなければ、プロキシは `502` と `wtshunt serve` を促すヒントを
返します。起動時に `fixed_port` が使用中なら、占有しているプロセスを
(`lsof` で)表示して終了します。WebSocket などの upgrade リクエストも
転送します — `use` との関係は「制約とトラブルシューティング」を参照
してください。

### `wtshunt task ...`

experimental な複数リポジトリ向けプリセットです。下の
「タスク (experimental)」を参照してください。

### `wtshunt ui`

対話的なターミナル UI です。`j`/`k` または矢印キーで各リポジトリの
worktree(と定義済みのタスク)を一覧・移動でき、画面を離れずに選択中の
行に対して操作できます:

- `u` / Enter — worktree の行ならそのアクティブ worktree をセットし、
  タスクの行ならそのタスクを適用します。
- `s` — 選択中の worktree のサーバを起動します。
- `x` — 停止します。
- `r` — 再起動します(停止してから起動。停止がタイムアウトした場合は
  起動しません)。
- `p` — その行のリポジトリのプロキシをトグルします: 稼働中なら停止、
  停止中なら起動します。
- `q` / `Ctrl-C` — 終了します。

画面は数秒おきに自動更新され、各操作の直後にも更新されます。
`serve`/`proxy` は常に UI 自身とは別のプロセスとして、別のペイン・タブ・
ウィンドウで開かれます — どのマルチプレクサを使うかは次のセクションを
参照してください。対話的なターミナル(TTY)が必要です。

### `wtshunt help [command]`

`wtshunt --help` と同じ内容を表示します。コマンド名を付けると、その
コマンド自体のヘルプ(`wtshunt <command> --help` 相当)を表示します。

## 制約とトラブルシューティング

- **WebSocket は接続時にルーティングされ、切り替え時には動かない。**
  upgrade リクエスト(Rails ActionCable、Vite/webpack の HMR)は、
  接続が開かれた時点でアクティブな worktree に転送されますが、確立済み
  の接続は `use` で切り替えても移動しません — 次の新規接続から新しい
  worktree に反映されます。実際には ActionCable や HMR のクライアントは
  自分で再接続するため、再接続した瞬間に新しい worktree に繋がり、
  ほとんど気になりません。101 のハンドシェイクレスポンスはそのまま
  中継されるため、通常の HTTP レスポンスと違い `X-Wtshunt-Worktree`
  ヘッダは付きません。
- **`status` が報告するのはプロセスの生存であって、疎通ではない。**
  想定と違うポートやインターフェースに bind してしまったサーバは、
  稼働中と表示されたままプロキシは 502 を返します。`status` と現実が
  食い違うときは、`lsof -i :<port>` で実際に listen しているプロセスを
  確認してください。
- **ポートの空きチェックはすり抜けられることがある。** IPv4/IPv6 の
  ワイルドカードアドレスへの bind を試すため、インターフェースを問わず
  他プロセスを検知できますが、そのチェックと新しいサーバ自身の bind の
  間の短い時間差で sticky ポートを他プロセスに奪われると、新しいサーバ
  は `EADDRINUSE` で即死することがあります。`wtshunt serve` の直後に
  数秒以内でサーバが落ちる場合、表示されるヒントが「割り当てポートが
  (`lsof` によれば)他プロセスに握られている」のか「定番の `.env` /
  `node_modules` の未コピーらしい」のかを教えてくれます。
- **`stop` は最大2秒待ってから諦める。** `SIGTERM` を送った後、実際に
  プロセスが終了するまでポーリングします。2秒経っても生きていれば
  (`SIGTERM` をトラップしている、あるいは単に終了処理が遅い)、state
  のエントリはあえてそのまま残します — `wtshunt status` には引き続き
  表示され、`stop` は成功したふりをせず警告付きで exit 1 になります。
- **worktree 間で開発用データベースを共有しがち。** マイグレーションが
  分岐したブランチ同士を同じデータベースに向けて動かすと、どちらかが
  壊れます。頻繁に切り替えるなら worktree ごとのデータベース名を検討
  してください。

## シェル補完

`wtshunt completion` は、実行しているシェルに合わせた補完スクリプトを
出力します。補完候補は `<Tab>` のたびに動的に計算されるため、リポジトリ
や worktree を後から追加しても、再インストールなしで即座に補完されます:

- 何も入力していない状態では、コマンド名(`use`、`serve`、`run`、
  `status`、`stop`、`proxy`、`task`、`ui`、`help`、`completion`)を
  提案します。
- `use`、`serve`、`stop`、`proxy`、`run` の第1引数では、すべての
  リポジトリ名と `repo/worktree` 名を提案します。`run <Tab>` で全候補
  が並び、`run api/<Tab>` で `api` の worktree に絞り込まれます。
  `help` の引数ではコマンド名を提案します。
- `task` の後は `add`/`use`/`list`/`rm` を、`task use` や `task rm` の
  後は定義済みのタスク名を提案します。`task add <name>` の後は、
  `run` などと同じ repo/worktree の候補にフォールバックします。
- それ以外 — どのリポジトリ・worktree にも前方一致しない語
  (例: `run rails<Tab>`)や、どのコマンドでも第2引数以降
  (例: `run api bin/<Tab>`)— では意図的に候補を返しません。これに
  よりシェルは通常のファイル/コマンド補完にフォールバックし、決して
  当てはまらない worktree 名を提案し続けることがなくなります。

zsh:

```sh
wtshunt completion >> ~/.zshrc
```

bash:

```sh
wtshunt completion >> ~/.bashrc
```

新しいシェルを開く(か rc ファイルを `source` する)と有効になります。
リポジトリや worktree を後から追加しても再インストールは不要です —
一度追記するのは静的なスクリプト(どのコマンド名が存在するか)だけで、
リポジトリと worktree の候補自体は `<Tab>` のたびに計算し直されます。

zsh 用スクリプトは zsh の補完システムを自前で初期化します(`compdef`
が未定義なら `compinit` を呼びます)。そのため、`compinit` を一度も
呼ばない `.zshrc` でもそのまま動きます。

## `wtshunt ui` からのペインの開き方

`wtshunt ui` が行に対して `serve`/`proxy` を開くとき(`s`/`r`/`p`)、
常に別のペイン・タブ・ウィンドウの中でフォアグラウンドプロセスとして
起動します — 手元で `wtshunt serve`/`wtshunt proxy` を実行するのと同じ
種類のプロセスを、代わりに起動してくれるだけです。開き方は次の順番で
決まります:

1. `config.toml` に `[ui]` セクションがあれば、それが常に優先されます:

   ```toml
   [ui]
   open = "my-launcher --name {title} {cmd}"
   ```

   `{title}`、`{cmd}`、`{cwd}` が(それぞれ安全にシェルクォートされた
   上で)置換され、その結果が `sh -c` で実行されます。そのため、
   「ラベル付きの新しいペインで指定コマンドを実行できる」CLI を持つ
   マルチプレクサやランチャーであれば何でも指定できます。
2. それが無ければ、[herdr](https://herdr.dev) が検出された場合はそれを
   使います(`HERDR_ENV`/`HERDR_SOCKET_PATH` 環境変数が設定されている
   場合)。
3. それも無ければ、[cmux](https://cmux.app) が検出された場合はそれを
   使います(`CMUX_SOCKET_PATH`/`CMUX_WORKSPACE_ID` が設定されていて
   `cmux` が `$PATH` にある場合)— フォーカスを奪わずに新しい
   workspace を開きます。
4. それも無ければ、[tmux](https://github.com/tmux/tmux) が検出された
   場合はそれを使います(`$TMUX` が設定されている場合)— 現在の
   セッションに新しいウィンドウを追加します。
5. どれも無ければ、`wtshunt ui` は何も開かず、代わりに手元の別ターミナル
   で実行すべきコマンドを表示します。

いずれの場合も、実行されるコマンドは常に wtshunt 自身の解決済み実行
ファイルパスを直接参照します — 新しいペインで `$PATH` が同じように
設定されているとは限らない、裸の `wtshunt` には依存しません。

## タスク (experimental)

タスクは wtshunt の発展的な複数リポジトリ向けレイヤーで、ここまでの
機能はタスク無しで完結します。この機能は experimental であり、実際の
使用感のフィードバックによって挙動が変わる可能性があります。

変更が複数リポジトリにまたがるようになると、単一リポジトリの worktree
だけでは足りません — たとえば `api` のあるブランチと、それを呼ぶ
`front` のブランチのような組み合わせです。**タスク**はリポジトリごとに
1つの worktree を束ねた名前付きプリセットで、グループ全体をまとめて
切り替えられます:

```sh
wtshunt task add feature-x api/feature-x front/feature-x
wtshunt task use feature-x
```

- `wtshunt task add <name> [repo/worktree ...]` はタスクを作成します。
  明示的に指定したリポジトリはその worktree を使い、指定しなかった
  登録済みリポジトリはそれぞれについて選択を促されます(peco、無けれ
  ば番号選択。先頭に「このリポジトリをタスクに含めない」選択肢があり
  ます)。
- `wtshunt task use <name>` はまず全メンバーの worktree がまだ存在す
  るか検証し、1つでも欠けていれば何も適用せずエラーにします。検証後、
  全メンバーを一括で切り替え、どのメンバーがまだ `wtshunt serve` され
  ていないかを報告し、起動中のサーバの `{port:<repo>}` の結線が古く
  なっていないかも警告します(下記参照)。
- `wtshunt task list` はタスクとそのメンバーを一覧し、全メンバーが
  現在のアクティブ worktree と一致するタスクには `*` を付けます。
- `wtshunt task rm <name>` はタスクを削除します。

**リポジトリ同士がどう結線され続けるか。** サービスの手前に立つ固定
ポートのプロキシはリクエストごとに `state.json` を読み直すため、その
部分は常に現在アクティブな worktree を反映します — 再起動は不要です。
一方 `serve` テンプレートの `{port:<repo>}` 参照は違います: これは
サーバ起動時に実行される具体的なシェルコマンドへ一度だけ置換される
ため、そのプロセスが動き続けている限り固定されたままです。`api` の
アクティブ worktree を切り替えても、すでに動いている `front` のプロ
セスの接続先は自動的には変わりません — 再起動するまで `api` の古い
ポートを叩き続けます。これはまさに `task use` がチェックしている内容
です: `{port:<repo>}` の結線がもう一致しないサーバが動いていれば、
`wtshunt stop <repo> && wtshunt serve <repo>` で結線し直すよう警告し
ます。まだ一度も動いていない worktree は、初めて `serve` したときに
自動的に正しい結線になります。

`front` にも `API_URL` を含むコミット済みの `.env` がある場合、`serve`
テンプレートの `API_URL={port:api}` プレフィックスが優先されるのは、
使っているフレームワークの `.env` ローダーが既に設定済みの環境変数を
上書きしない実装である場合に限ります — ほとんどの dotenv 実装のデフ
ォルト挙動ではありますが、自分のスタックで一度確認しておく価値はあり
ます。

プロキシの host:port は切り替えても変わらないため、クライアントが
持っている Cookie はそのまま引き継がれます。それが表すセッションが
有効なままかどうかは、関係する worktree 同士がセッションストアを共有
しているかどうか次第です — 上の「制約とトラブルシューティング」の
開発用データベース共有の注記を参照してください。

## 開発

```sh
npm install
npm test        # node:test。テストが実際の設定や state に触れることはありません
```

ビルドステップはありません — CLI は tsx 経由で `src/` の TypeScript を
直接実行します。`src/commands/*.ts` が各サブコマンドのハンドラで、
`src/proxy.ts` がリバースプロキシの実装本体です(`src/commands/proxy.ts`
はその薄い CLI ラッパー)。`src/portRefs.ts` が `{port:<repo>}` の解決、
`src/tasks.ts` が結線ズレ検知とタスクの一致判定ロジック、
`src/picker.ts` が `use` と `task add` で共有する peco/番号選択の
ピッカーです。`src/overview.ts` が `status`/`status --json` 双方の元
データを集約し、`src/mux.ts` が `wtshunt ui` の `serve`/`proxy` 起動に
使うマルチプレクサアダプタの実装、`src/ui/` が `wtshunt ui` の
行モデル・キー処理・描画ロジックです(`src/commands/ui.ts` はその薄い
ターミナル/イベントループラッパー)。実行時の state は
`$XDG_STATE_HOME/wtshunt/state.json`(デフォルトは
`~/.local/state/wtshunt/state.json`)に置かれます。

## ライセンス

MIT — [LICENSE](LICENSE) を参照してください。
