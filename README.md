# Pre

Pre は、JavaScript に似た書き方と Python のような読みやすさを組み合わせた、小さなプログラミング言語です。

ブラウザの中だけで動作し、インストールなしでコードを書いて実行できます。

Pre は、値・変数・関数・クラス・パターンマッチ・型注釈・パイプ・描画など、一般的なプログラミングに必要な機能を小さな言語の中にまとめています。

現在の実装バージョンは **2.0.0** です。

## Contents

- [値と変数](#値と変数)
- [文字列](#文字列)
- [演算子](#演算子)
- [条件とくり返し](#条件とくり返し)
- [関数](#関数)
- [リストとマップ](#リストとマップ)
- [クラス](#クラス)
- [パターンマッチ](#パターンマッチ)
- [エラー処理](#エラー処理)
- [型注釈](#型注釈)
- [Selector Expression](#selector-expression)
- [パイプ](#パイプ)
- [描画](#描画)
- [JavaScript・Python との違い](#javascriptpython-との違い)
- [組み込み関数](#組み込み関数)
- [言語ツアー](#言語ツアー)
- [JavaScript から使う](#javascript-から使う)

---

## Selector Expression

Pre 2.0.0 では、データ処理のための「Selector Expression」を追加しました。

`.` から始まる式は、「現在の要素」を対象にした短い関数として使えます。

```pre
const users = [
  { name: "bob", age: 20 },
  { name: "alice", age: 17 },
  { name: "carol", age: 31 }
]

const adults = users
  |> .filter(.age >= 18)
  |> .map(.name.upper())
  |> .sort()

print(adults.join(", "))
```

この例の `filter(.age >= 18)` は、毎回 `user => user.age >= 18` と書く必要がありません。
`.name` はプロパティ取得、`.name.upper()` はメソッド呼び出しまで表現できます。

Selector Expression は通常の高階関数にも使えます。

```pre
print(map(users, .name).join(" - "))
```

さらに比較や計算もそのまま書けます。

```pre
const expensive = items |> .filter(.price * .count >= 10000)
```

Pre 2.0.0 のパイプは、この記法を中心に設計されています。

## 値と変数

文末の `;` は省略できます。ブロックは `{ }` で囲みます。

変数は `let`、変更できない値は `const` で宣言します。

コメントには `//`、`#`、`/* */` を使用できます。

```pre
// コメント
# コメント
/* コメント */

let count = 3
const name = "Pre"

count += 1

print(name, count)
```

Pre では、主に次の値を扱います。

- `number`
- `string`
- `bool`
- `null`
- `list`
- `map`
- `fn`
- クラスのインスタンス

### 真偽値

`false`、`null`、`0`、`""`、`[]`、`{}` は偽として扱われます。

```pre
for v in [0, 1, "", "a", [], [0], {}, null] {
  print(v, v ? "真" : "偽")
}
```

空のリストやマップも偽になる点は Python と同じで、JavaScript とは異なります。

---

## 文字列

文字列は `"..."` と `'...'` のどちらでも書けます。

```pre
const name = "Pre"
const message = 'Hello'

print(name)
print(message)
```

### f文字列

先頭に `f` を付けると式を埋め込めます。

```pre
const price = 1280.5

print(f"価格: {price:,.2f} 円")
print(f"{'L':<4}|{'C':^4}|{'R':>4}|")
print(f"{255:x} {255:b} {0.256:.1%} {7:03d}")
```

`{式:書式}` の書式指定は Python と同じ形式です。

波括弧そのものを表示するときは `{{` と `}}` を使用します。

```pre
print(f"波括弧は {{ と }} で書きます")
```

### テンプレート文字列

JavaScript のバッククォートによるテンプレート文字列も使用できます。

```pre
const name = "Pre"
print(`Hello, ${name}!`)
```

### 複数行文字列

`"""` またはバッククォートを使って複数行の文字列を書けます。

```pre
const poem = """1行目
2行目"""

print(poem)
```

### 文字列メソッド

```pre
const s = "  Hello, Pre!  "

print(s.trim().upper())
print(s.trim().lower())
print("a,b,c".split(","))
print(["x", "y"].join("-"))
print("pre".capitalize())
print("ab" * 3)
print("abc"[0])
print("abc"[-1])
print("hello"[1:3])
print("日本語".length)
print("Pre".replace("r", "R"))
print("Pre".startsWith("P"))
```

---

## 演算子

算術、比較、論理演算に加えて、Python と JavaScript の便利な記法を組み合わせています。

```pre
print(7 / 2)
print(7 % 3)
print(-7 % 3)
print(2 ** 10)
print(idiv(7, 2))
```

比較演算は連鎖できます。

```pre
print(1 < 2 < 3)
print(1 < 3 < 2)
```

`in` と `not in` も使用できます。

```pre
print(3 in [1, 2, 3])
print("ell" in "hello")
print("k" in {k: 1})
print(5 not in [1, 2])
```

### Null 合体演算子とオプショナルチェーン

```pre
print(null ?? "既定値")
print(0 ?? "0 は null ではない")

let user = null

print(user?.name)
print(user?.name ?? "名無し")
```

### 論理演算子

英語形式と記号形式の両方に対応しています。

```pre
print(true and "A")
print(false or "B")
print(not true)

print(true && "A")
print(false || "B")
print(!true)
```

### 三項演算子

```pre
print(10 > 5 ? "大きい" : "小さい")
```

### インクリメント

```pre
let n = 5

n++
n *= 2

print(n)
```

`/` は常に小数の割り算です。

整数の商が必要な場合は `idiv(a, b)` を使用します。

---

## 条件とくり返し

条件式の周りに `()` は必要ありません。

```pre
const score = 72

if score >= 80 {
  print("優")
} elif score >= 60 {
  print("可")
} else {
  print("不可")
}
```

`else if` も使用できます。

### for

```pre
for i in range(3) {
  write(i, " ")
}

print()
```

`enumerate` や `items` と組み合わせることもできます。

```pre
for i, ch in enumerate("abc") {
  print(i, ch)
}

for key, value in items({x: 1, y: 2}) {
  print(key, "=", value)
}
```

C 風の `for` も使用できます。

```pre
for (let i = 0; i < 3; i++) {
  write(i * i, " ")
}

print()
```

### while

```pre
let n = 0

while true {
  n++

  if n % 2 == 0 {
    continue
  }

  if n > 7 {
    break
  }

  write(n, " ")
}

print()
```

### range

```pre
range(n)
range(a, b)
range(a, b, step)
```

はリストを返します。

`for` はリスト、文字列、マップのキーなどを反復できます。

---

## 関数

関数は `fn` で定義します。

```pre
fn add(a, b = 10) {
  return a + b
}

print(add(1))
print(add(1, 2))
```

式をそのまま返す関数は `=>` で短く書けます。

```pre
fn total(...nums) => sum(nums)

const double = x => x * 2

const clamp = (x, lo, hi) => {
  if x < lo {
    return lo
  }

  return x > hi ? hi : x
}
```

### 可変長引数

```pre
fn total(...nums) => sum(nums)

print(total(1, 2, 3))
```

引数を展開して渡すこともできます。

```pre
print(total(...[4, 5, 6]))
```

### クロージャ

関数は値として扱え、外側の変数を覚えるクロージャも利用できます。

```pre
fn counter() {
  let c = 0
  return () => ++c
}

const next = counter()

print(next())
print(next())
print(next())
```

### 関数の巻き上げ

`fn` で宣言した関数は、定義位置より前から呼び出せます。

```pre
print(isEven(10))

fn isEven(n) => n == 0 ? true : isOdd(n - 1)
fn isOdd(n) => n == 0 ? false : isEven(n - 1)
```

引数の数が合わない場合は、関数名と必要な引数数を含むエラーが発生します。

---

## リストとマップ

リストは `[ ]`、マップは `{ }` で作成します。

```pre
const xs = [3, 1, 2]

xs.push(10)

print(xs)
print(xs[0])
print(xs[-1])
print(xs[1:3])
```

範囲外の添字は `null` や `undefined` ではなく `IndexError` になります。

### map / filter / reduce

```pre
print(xs.map(x => x * x))
print(xs.filter(x => x > 1))
print(xs.reduce((a, b) => a + b))
```

```pre
print(xs.sum())
print(xs.max())
print(xs.includes(2))
```

### 内包表記

```pre
print([x * 2 for x in xs if x != 1])

print([[x, y] for x in [1, 2] for y in "ab"])
```

### マップ

```pre
const user = {
  name: "Aya",
  age: 20,
  tags: ["a", "b"]
}

user.age += 1
user["city"] = "Tokyo"

print(user)
print(keys(user))
print(user.get("zip", "なし"))
print("name" in user)
```

### スプレッド

```pre
const merged = {
  ...user,
  age: 99,
  extra: true
}

print(merged.age)
```

### 分割代入

```pre
let [a, b, ...rest] = [1, 2, 3, 4]

const {name, age} = user

print(a, b, rest)
print(name, age)
```

値の入れ替えもできます。

```pre
[a, b] = [b, a]
```

マップのキーにはさまざまな値を使用できます。

---

## クラス

`class` にはフィールド、コンストラクタ、メソッドを書けます。

`extends` で継承し、`super` で親クラスを呼び出します。

インスタンスは `new` を書かずに作成できます。

```pre
class Shape {
  constructor(name) {
    this.name = name
  }

  area() => 0

  describe() => f"{this.name}: 面積 {round(this.area(), 2)}"
}

class Circle extends Shape {
  constructor(r) {
    super("円")
    this.r = r
  }

  area() => PI * this.r ** 2
}

print(Circle(2).describe())
print(Shape("図形").describe())
```

### 初期値つきフィールド

```pre
class Counter {
  count = 0

  constructor(step = 1) {
    this.step = step
  }

  inc() {
    this.count += this.step
    return this
  }

  toString() => f"Counter({this.count})"
}

const c = Counter(2)

c.inc().inc().inc()

print(c)
print(c.count)
```

`this` を返すことでメソッドチェーンも利用できます。

---

## パターンマッチ

`match` は、上から順にパターンを試し、最初に一致したものを実行します。

式としても文としても利用できます。

```pre
fn show(v) {
  return match v {
    0 => "ゼロ"
    1 | 2 | 3 => "小さい数"
    n: number if n < 0 => "負の数"
    n: number => f"数 {n}"
    "" => "空文字列"
    s: string => f"文字列 {s}"
    [] => "空のリスト"
    [x] => f"要素1つ: {x}"
    [x, ...rest] => f"先頭 {x} と残り {len(rest)} 個"
    {type: "point", x, y} => f"点 ({x}, {y})"
    null => "null"
    _ => "その他"
  }
}
```

利用できるパターンには次のようなものがあります。

- リテラル
- 複数候補 `|`
- ワイルドカード `_`
- 名前への束縛
- 型パターン
- ガード条件
- リストパターン
- リストの残り `...rest`
- マップパターン

値として使った `match` がどのパターンにも一致しない場合は `ValueError` になります。

「それ以外」を処理したい場合は、最後に `_ => ...` を置くのが基本です。

---

## エラー処理

`try`、`catch`、`finally`、`throw` を使用できます。

```pre
fn parseAge(text) {
  const n = int(text)

  if n < 0 {
    throw ValueError("年齢は 0 以上です")
  }

  return n
}

for text in ["20", "-3", "abc"] {
  try {
    print("OK:", parseAge(text))
  } catch e {
    print(f"{e.name}: {e.message}")
  }
}
```

### 独自エラー

`Error` を継承して独自のエラー型を作成できます。

```pre
class AppError extends Error {}

try {
  throw AppError("独自のエラー")
} catch e {
  print(e.name)
  print(e.message)
} finally {
  print("finally は必ず実行されます")
}
```

### 主なエラー

- `TypeError`
- `NameError`
- `ValueError`
- `IndexError`
- `AttributeError`
- `ZeroDivisionError`
- `RecursionError`
- `AssertionError`

変数名やメソッド名を間違えた場合は、近い名前を「もしかして」と候補として示します。

---

## 型注釈

TypeScript のように、変数・引数・戻り値・フィールドへ型を書けます。

型注釈は実行時にも検査され、値が一致しない場合は `TypeError` になります。

```pre
fn area(w: number, h: number = 1): number {
  return w * h
}

print(area(3, 4))
```

```pre
let ids: int[] = [1, 2, 3]

let table: map<string, list<number>> = {
  a: [1, 2]
}

let maybe: string? = null

let either: number | string = "ok"
```

### 利用できる型

- `number`
- `int`
- `string`
- `bool`
- `null`
- `any`
- `fn`
- `list<T>`
- `map<K, V>`
- クラス名
- `T[]`
- `T?`
- `A | B`

`T[]` は `list<T>` と同じ意味です。

`T?` は `T | null` と同じ意味です。

---

## パイプ

`|>` を使うと、処理を上から下へ読める形に並べられます。

```pre
const words = ["pre", "is", "a", "small", "language"]

const out = words
  |> .filter(.length > 2)
  |> .map(.upper())
  |> .sort()

print(out)
```

基本的には、

```pre
a |> f
```

は

```pre
f(a)
```

と同じです。

引数を追加することもできます。

```pre
a |> f(x)
```

は、

```pre
f(a, x)
```

と同じ意味になります。

```pre
fn double(x) => x * 2
fn add(a, b) => a + b

print(5 |> double |> add(1))
```

---

## 描画

`canvas` を使うと、Pre のコードから図形を描画できます。

描画結果は対応する環境の「描画」タブなどから表示できます。

```pre
canvas.size(320, 160)
canvas.clear("#fff8e1")

for i in range(8) {
  canvas.rect(
    10 + i * 38,
    100 - i * 10,
    30,
    20 + i * 10,
    canvas.hsl(i * 40, 70, 55)
  )
}

canvas.polygon(
  [[10, 20], [60, 20], [35, 60]],
  "#0b7863"
)

canvas.text("Pre", 80, 52, "#222", 28)
```

### Canvas API

| 関数 | 意味 |
|---|---|
| `canvas.size(幅, 高さ)` | 描画領域の大きさを変更 |
| `canvas.clear(色)` | 全体を塗りつぶす |
| `canvas.rect(x, y, 幅, 高さ, 色, 塗る)` | 長方形 |
| `canvas.circle(x, y, 半径, 色, 塗る)` | 円 |
| `canvas.line(x1, y1, x2, y2, 色, 太さ)` | 線 |
| `canvas.text(文字, x, y, 色, サイズ)` | 文字 |
| `canvas.polygon([[x, y], ...], 色, 塗る)` | 多角形 |
| `canvas.hsl(色相, 彩度, 明るさ)` | HSL 色を生成 |
| `canvas.rgb(r, g, b)` | RGB 色を生成 |

---

## JavaScript・Python との違い

Pre は JavaScript と Python の両方を意識した構文になっています。

| 項目 | Pre |
|---|---|
| 変数 | `let` / `const` |
| 関数 | `fn`。`def` と `function` も `fn` として扱えます |
| 真偽値 | `true` / `false` |
| 空の値 | `null` |
| インスタンス内 | `this` |
| 偽として扱う値 | `false`, `null`, `0`, `""`, `[]`, `{}` |
| 等価比較 | `==` と `===` は同じ意味 |
| 割り算 | `/` は常に小数の割り算 |
| 整数除算 | `idiv(a, b)` |
| 余り | Python と同じ向き |
| 文字列連結 | `+`。片方が文字列なら文字列化して連結 |
| 添字 | 範囲外なら `IndexError` |
| 負の添字 | `xs[-1]` などに対応 |
| 範囲 | `range(a, b, step)` はリストを返す |
| エラー | `try / catch` |
| 出力 | `print(a, b)`。`console.log` も利用可能 |
| 三項演算子 | `condition ? a : b` |
| Null 合体 | `??` |
| オプショナルチェーン | `?.` |
| パイプ | `|>` |

### Python を知っている人へ

Python 風の読みやすさを維持しつつ、ブロックは `{ }` を使用します。

```pre
if score >= 60 {
  print("pass")
}
```

### JavaScript を知っている人へ

JavaScript 風の構文を多く利用できます。

```pre
const double = x => x * 2

let user = null

print(user?.name ?? "名無し")
```

---

## 組み込み関数

Pre には基本的な関数や定数が最初から用意されています。

### 出力と入力

```text
print
write
input
console
```

### 型と変換

```text
type
isinstance
str
num
int
float
bool
list
chr
ord
```

### リストとマップ

```text
len
range
enumerate
zip
sorted
reversed
keys
values
items
has
sum
min
max
map
filter
reduce
any
all
copy
clone
```

### 数学と乱数

```text
abs
round
floor
ceil
trunc
idiv
sqrt
pow
sin
cos
tan
atan2
exp
log
log2
log10
gcd
random
randint
choice
shuffle

PI
E
INF
Math
```

### JSON・時間・検査

```text
toJson
fromJson
JSON
clock
time
assert
```

### エラーのクラス

```text
Error
TypeError
NameError
ValueError
IndexError
AttributeError
ZeroDivisionError
RecursionError
AssertionError
```

`Math` と `JSON` には JavaScript に近い API も用意されています。

---

## 言語ツアー

Pre は、短いコードを実際に動かしながら覚えられるように設計されています。

おすすめの学習順序は次の通りです。

### 1. 値と変数

```pre
let x = 10
const name = "Pre"

print(name, x)
```

### 2. 条件分岐

```pre
if x > 5 {
  print("大きい")
} else {
  print("小さい")
}
```

### 3. くり返し

```pre
for i in range(5) {
  print(i)
}
```

### 4. 関数

```pre
fn square(x) => x * x

print(square(5))
```

### 5. リスト

```pre
const xs = [1, 2, 3, 4, 5]

print(xs.map(x => x * 2))
```

### 6. クラス

```pre
class User {
  constructor(name) {
    this.name = name
  }

  hello() => f"Hello, {this.name}!"
}

print(User("Pre").hello())
```

### 7. パターンマッチ

```pre
fn describe(v) {
  return match v {
    0 => "zero"
    n: number => f"number: {n}"
    s: string => f"string: {s}"
    _ => "other"
  }
}
```

### 8. パイプ

```pre
const result = [1, 2, 3, 4]
  |> filter(x => x % 2 == 0)
  |> map(x => x * 10)

print(result)
```

この順番で進めると、Pre の基本から応用まで自然につながります。

---

## JavaScript から使う

Pre はブラウザでは `Pre` として公開され、Node.js 系の環境ではモジュールとして利用できます。

基本的な実行 API は `Pre.run()` です。

```javascript
const result = Pre.run(`
  let x = 10
  print(x * 2)
`)

console.log(result)
```

`run()` は成功時に `{ ok: true }`、失敗時に `{ ok: false, error: ... }` の形で結果を返します。

状態を維持しながら複数回コードを評価したい場合は `Pre.Session` を使用できます。

また、言語処理系として `parse()`、`tokenize()`、`builtinNames()`、`keywords` も公開されています。

### 実装

Pre は次の流れでコードを処理します。

```text
ソースコード
    ↓
字句解析
    ↓
構文解析
    ↓
AST
    ↓
ツリーウォーク型インタープリタ
    ↓
実行
```

`eval` や `new Function` にコードを直接渡す方式ではなく、Pre 独自の字句解析・構文解析・インタープリタで実行します。

---

## 実行時間について

Pre のインタープリタには実行時間の制限があります。

デフォルトの `timeLimit` は 10 秒で、長時間実行し続けるコードは `TimeoutError` になります。

そのため、意図しない無限ループなどでブラウザを固め続けることを防げます。

```pre
while true {
  print("止まらない")
}
```

このようなコードは一定時間後に停止します。

---

## まとめ

Pre は、

- JavaScript の書きやすさ
- Python の読みやすさ
- TypeScript の型注釈
- Python の内包表記とパターンマッチ
- JavaScript のアロー関数とオプショナルチェーン
- 関数型言語風のパイプ
- 小さな Canvas API

をひとつの小さな言語にまとめたプログラミング言語です。

「JavaScript ほど大きくなく、Python ほど独自でもなく、気軽にブラウザで書ける言語」を目指しています！

```pre
print("Hello, Pre!")
```

これだけでも、Pre は始められます。
