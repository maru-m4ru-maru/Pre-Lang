# Pre 2

**書いたそばから、全部見える小さな言語。** ブラウザで動き、ダウンロードは要りません。依存ライブラリなし・`eval` なし。

```
size  = slider("大きさ", 10, 100, 50)
color = choice("色", ["tomato", "gold", "teal"])
show circle(240, 160, size + 10 * sin(time * 3), color)
```

この 3 行で、スライダーと選択肢と、脈打つ円が画面に出ます。部品を作る処理も、イベントの登録も、アニメーションのループもありません。

## 気持ちいいところは 1 つだけ

**プログラムを、変わるたびに上から何度でも実行する。値がそのまま画面になる。**

- `slider` `choice` `toggle` `textbox` は、呼んだ場所に部品を出して、**いまの値を返す**。`button` は押された実行でだけ `true`。
- `time` と `mouse` もただの値。読んだプログラムだけが、毎フレーム・マウスが動くたびに再実行される。
- 残るのは `state` と書いた変数だけ。ほかは実行のたびに作り直される。
- エディタを書き換えると、`state` と部品の値を保ったまま、その場で反映される。

素の JavaScript で同じ動きを書くと、カウンターは 4 行 → 11 行、触れる円は 3 行 → 21 行です。実際のコードと行数は、画面の「JavaScript と比べる」で見られます。

## 小さくした

| | v1 | v2 |
|---|---|---|
| キーワード | 約 30 | **16** (`state fn if else for in while break return and or not true false null show`) |
| 組み込み | 関数約 80 + メソッド約 100 | **54 個の関数と値** (メソッドなし) |
| 型・クラス・例外・`match` | あり | なし |

全部が「Pre のすべて」の 1 画面に載ります。足りないものは、書いてしまうと「Pre ではこう書く」と教えてくれます (`let x = 1` → `x = 1` と書く、など)。

## 使う

- ブラウザで `dist/pre2-standalone.html` を開く (ネットワークがなくても動きます。フォントだけ外部)。
- 自分のページに入れる: `dist/pre2.js` を読み込むと `Pre2` が使えます。

```js
const s = new Pre2.Session();
s.load('n = slider("n", 1, 10, 3)\nshow "{n} の 2 乗は {n * n}"');
const r = s.frame({ time: 0 });                       // r.items: 画面の部品の一覧
s.frame({ input: { label: 'n', value: 7 } });         // 部品を操作したあとの画面
```

- Node で確かめる: `node tests/run.js examples/02_circle.pre --set "大きさ=80" --shapes`

## 作り・確かめ

```
node build_engine.js        # src/ → dist/pre2.js
node web/build.js           # dist/pre2-page.html と dist/pre2-standalone.html
node tests/lang.test.js     # 言語 134 件
node tests/examples.test.js # 15 個のサンプルが全部動く
node tests/docs.test.js     # 早見表の例が本当に動く
node tests/host.test.js     # 画面とエンジンの窓口
NODE_PATH=/opt/npm-tools/node_modules node tests/e2e.js          # 本物の Chromium で操作 (42 件)
NODE_PATH=/opt/npm-tools/node_modules node tests/compare.e2e.js  # 比較ページの JavaScript が動く (17 件)
```

初見の人 (早見表だけを読んだ別のエージェント) に 6 課題を書いてもらい、全部が最初の試行で動くことも確かめました。そこで見つかった「黙って失敗する書き間違い」は、エラーで教えるように直してあります (`DESIGN.md` の最後)。

## 向いていないこと

- 大きなプログラム。モジュール・非同期・ファイル・ネットワークはありません。
- 速さ。木を歩くだけのインタプリタで、1 回の実行は数百〜数千の図形までを想定しています。
- `random()` は実行のたびに変わります。覚えておきたい値は `state` に入れます。
- 空のリストを `show` すると `[]` と出ます (表か絵か決められないため)。

設計の理由と、削ったものの一覧は `DESIGN.md` にあります。
