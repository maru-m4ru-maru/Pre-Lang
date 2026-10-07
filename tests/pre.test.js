const test = require("node:test");
const assert = require("node:assert/strict");
const Pre = require("../pre.js");

function run(source) {
  let output = "";

  const result = Pre.run(source, {
    print(value) {
      output += value;
    }
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  return output;
}

test("public version is 2.0.0", () => {
  assert.equal(Pre.version, "2.0.0");
  assert.equal(typeof Pre.parse, "function");
  assert.equal(typeof Pre.tokenize, "function");
});

test("basic expressions stay readable", () => {
  assert.equal(run(`
const price = 1200
const tax = 0.1
print(price * (1 + tax))
`), "1320\n");
});

test("strings and templates work", () => {
  assert.equal(run(`
const name = "Pre"
print(f"Hello {name} {2 + 3}")
print(`value: ${name}`)
`), "Hello Pre 5\nvalue: Pre\n");
});

test("functions and default arguments work", () => {
  assert.equal(run(`
fn greet(name, suffix = "!") => "Hello " + name + suffix
print(greet("Pre"))
print(greet("Pre", "."))
`), "Hello Pre!\nHello Pre.\n");
});

test("arrow functions and list methods work", () => {
  assert.equal(run(`
const values = [1, 2, 3, 4]
print(values.map(x => x * 2).filter(x => x > 4).sum())
`), "14\n");
});

test("for and while loops work", () => {
  assert.equal(run(`
let total = 0
for value in [1, 2, 3] {
  total += value
}

let n = 0
while n < 3 {
  n++
}

print(total, n)
`), "6 3\n");
});

test("C-style for loops still work", () => {
  assert.equal(run(`
let total = 0
for (let i = 0; i < 4; i++) {
  total += i
}
print(total)
`), "6\n");
});

test("destructuring and comprehensions work", () => {
  assert.equal(run(`
let [a, b, ...rest] = [1, 2, 3, 4]
const user = { name: "Pre", age: 2 }
const {name, age} = user
const doubled = [x * 2 for x in [1, 2, 3] if x > 1]
print(a, b, rest, name, age, doubled)
`), "1 2 [3, 4] Pre 2 [4, 6]\n");
});

test("maps and spread work", () => {
  assert.equal(run(`
const base = { name: "Pre", version: 1 }
const merged = { ...base, version: 2 }
print(merged.name, merged.version)
print(sum(...[1, 2, 3]))
`), "Pre 2\n6\n");
});

test("classes and methods work", () => {
  assert.equal(run(`
class User {
  constructor(name) {
    this.name = name
  }

  hello() => "Hello " + this.name
}

print(User("maru").hello())
`), "Hello maru\n");
});

test("class inheritance and super work", () => {
  assert.equal(run(`
class Animal {
  constructor(name) {
    this.name = name
  }

  speak() => this.name
}

class Dog extends Animal {
  constructor(name) {
    super(name)
  }

  speak() => super.speak() + "!"
}

print(Dog("Pochi").speak())
`), "Pochi!\n");
});

test("match remains concise", () => {
  assert.equal(run(`
fn describe(value) {
  return match value {
    0 => "zero"
    n: number if n > 0 => "positive"
    _ => "other"
  }
}

print(describe(3))
print(describe(0))
print(describe(null))
`), "positive\nzero\nother\n");
});

test("try catch finally works", () => {
  assert.equal(run(`
try {
  int("oops")
} catch e {
  print(e.name)
} finally {
  print("done")
}
`), "ValueError\ndone\n");
});

test("type annotations are enforced", () => {
  assert.equal(run(`
fn area(w: number, h: number): number => w * h
print(area(3, 4))
`), "12\n");

  const result = Pre.run(`
fn area(w: number, h: number): number => w * h
area("3", 4)
`);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "TypeError");
});

test("traditional pipe syntax remains available", () => {
  assert.equal(run(`
print([1, 2, 3] |> map(x => x * 2) |> sum)
`), "12\n");
});

test("optional chaining still works", () => {
  assert.equal(run(`
let user = null
print(user?.name ?? "guest")
`), "guest\n");
});

test("selector expressions can be used as first-class functions", () => {
  assert.equal(run(`
const getName = .name
print(getName({ name: "Pre" }))
`), "Pre\n");
});

test("selector expressions make pipelines concise", () => {
  assert.equal(run(`
const users = [
  { name: "bob", age: 20 },
  { name: "alice", age: 17 },
  { name: "carol", age: 31 }
]

print(
  users
    |> .filter(.age >= 18)
    |> .map(.name.upper())
    |> .sort()
    |> .join(", ")
)
`), "BOB, CAROL\n");
});

test("selector expressions can be passed to normal higher-order functions", () => {
  assert.equal(run(`
const users = [
  { name: "A" },
  { name: "B" },
  { name: "C" }
]

print(map(users, .name).join("-"))
`), "A-B-C\n");
});

test("selector chains support methods and properties", () => {
  assert.equal(run(`
const names = ["  pre  ", "lang", "  v2 "]

print(
  names
    |> .map(.trim().upper())
    |> .join(", ")
)
`), "PRE, LANG, V2\n");
});

test("selector expressions work inside comparisons and calculations", () => {
  assert.equal(run(`
const values = [
  { score: 4, count: 3 },
  { score: 9, count: 2 },
  { score: 2, count: 10 }
]

print(values |> .filter(.score * .count >= 18) |> .map(.score) |> .join(","))
`), "9\n");
});

test("selector expressions work as sort keys", () => {
  assert.equal(run(`
const users = [
  { name: "C", age: 31 },
  { name: "A", age: 17 },
  { name: "B", age: 20 }
]

print(users |> .sort(.age) |> .map(.name) |> .join(","))
`), "A,B,C\n");
});

test("selector expressions do not capture already parsed call arguments", () => {
  assert.equal(run(`
const users = [
  { name: "A" },
  { name: "B" }
]

print(map(users, .name).join("-"))
`), "A-B\n");
});

test("errors still return structured results", () => {
  const result = Pre.run("print(unknownValue)", {
    print() {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "NameError");
  assert.match(result.error.message, /定義されていません/);
});

test("syntax errors are structured", () => {
  const result = Pre.run("if {");

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "SyntaxError");
});

test("session keeps state between evaluations", () => {
  const session = new Pre.Session({ print() {} });

  assert.equal(session.eval("let x = 1").ok, true);

  const result = session.eval(`
x += 2
x
`);

  assert.equal(result.ok, true);
  assert.equal(result.has, true);
  assert.equal(result.text, "3");
});
