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

test("basic expressions stay readable", () => {
  assert.equal(run(`
const price = 1200
const tax = 0.1
print(price * (1 + tax))
`), "1320\n");
});

test("functions and default arguments work", () => {
  assert.equal(run(`
fn greet(name, suffix = "!") => "Hello " + name + suffix
print(greet("Pre"))
print(greet("Pre", "."))
`), "Hello Pre!\nHello Pre.\n");
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

test("selector expressions work inside comparisons", () => {
  assert.equal(run(`
const values = [
  { score: 4 },
  { score: 9 },
  { score: 2 }
]

print(values |> .filter(.score >= 5) |> .map(.score) |> .join(","))
`), "9\n");
});

test("optional chaining still works", () => {
  assert.equal(run(`
let user = null
print(user?.name ?? "guest")
`), "guest\n");
});

test("errors still return structured results", () => {
  const result = Pre.run("print(unknownValue)", {
    print() {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "NameError");
  assert.match(result.error.message, /定義されていません/);
});

test("public version is 2.0.0", () => {
  assert.equal(Pre.version, "2.0.0");
  assert.equal(typeof Pre.parse, "function");
  assert.equal(typeof Pre.tokenize, "function");
});
