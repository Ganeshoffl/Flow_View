/**
 * Turning a JavaScript program into one that narrates itself.
 *
 * There is no `sys.settrace` here. The chosen approach is AST instrumentation: parse the program, insert
 * calls to a runtime at the points that matter, and run the result. The alternative was the Chrome
 * DevTools Protocol, which was rejected in the design phase because CDP only exists in the Full profile —
 * the Lite profile runs in a browser worker with no debugger to attach to, and two mechanisms would mean
 * two behaviours and a trace that depends on where you ran it.
 *
 * ## Two properties this has to preserve
 *
 * **Line numbers must not move.** A trace whose `line` fields point at the instrumented source rather
 * than what the user wrote is useless: the code pane would highlight the wrong line. So every insertion
 * is made without adding a newline, and `magic-string` edits the original text in place rather than
 * regenerating it from the AST. That rules out pretty-printing and it rules out inserting statements on
 * their own lines, which is why the generated calls look cramped.
 *
 * **Values are observed, not re-evaluated.** The runtime is handed values, never expressions to evaluate
 * a second time. `xs.pop()` must not be called twice because something wanted to know its result.
 *
 * ## How variables are observed
 *
 * The same way the Python tracer does it: by diffing a scope after each statement rather than
 * instrumenting every assignment expression. Assignment in JavaScript has too many shapes —
 * destructuring, `+=`, `++`, patterns with defaults, holes — and catching them one at a time means
 * missing some silently.
 *
 * So after each statement the runtime is handed the scope's current values and works out what moved. The
 * names included are only those *already declared* at that point in the source, which avoids reading a
 * `let` in its temporal dead zone — `typeof x` throws for those too, so a guard would not have helped.
 */

import { parse } from "acorn";
import MagicString from "magic-string";

/** The name the runtime is bound to in the instrumented program. Deliberately unlikely to collide. */
export const RUNTIME = "__flowView";

/** The binding an inserted `catch` uses. Named so it cannot shadow anything the user wrote. */
const ERR = "__flowViewErr";

/**
 * The binding holding the frame this code is running in.
 *
 * Declared once per function, because "the frame we are in" cannot be recovered from a stack when more than one
 * call is open at a time. Two concurrent `async` calls are both open, and the one that is *running* is whichever
 * is not sitting at an `await` — which only the code inside it knows.
 */
const FRAME = "__flowViewFrame";

/**
 * Nothing here passes a frame id.
 *
 * The first version numbered frames at instrumentation time, one per function in the source. That is
 * wrong the moment a function calls itself: every level of a recursion shared one id, so the frames
 * collapsed into each other and `fact(4)` reported returning 1 instead of 24. The conformance corpus said
 * so in as many words - "each recursive call must get its own frame id, never a reused one".
 *
 * Frames are allocated by the runtime when a call happens, and everything else refers to "the frame we
 * are in", which for synchronous code is exactly the top of the stack. Async is not handled yet, and the
 * adapter says so rather than guessing.
 */

/** Statements that leave the block, so a scan placed after them would never run. */
/** If-statements that are the `else if` of another, so they can be reported as chained. */
const ELIF = new WeakSet();

const JUMPS = new Set(["ReturnStatement", "BreakStatement", "ContinueStatement", "ThrowStatement"]);

/**
 * Instrument a program.
 *
 * @param {string} source the user's program, unmodified
 * @param {{ path?: string }} [options]
 * @returns {{ code: string, lineCount: number }}
 */
export function instrument(source, options = {}) {
  const path = options.path ?? "main.js";
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
    allowAwaitOutsideFunction: true,
  });

  const edits = new MagicString(source);
  const state = { nextRegion: 0 };

  // The module body is a frame like any other, so the stack pane has something to show at depth zero. It needs a
  // frame binding of its own for the same reason a function does: top-level `await` suspends it.
  edits.appendLeft(0, `const ${FRAME}=${RUNTIME}.currentFrame();`);
  instrumentBody(ast.body, edits, source, state, functionScope([]));
  instrumentAwaits({ type: "Program", body: ast.body }, edits);

  return { code: edits.toString(), lineCount: source.split("\n").length, path };
}

/**
 * A lexical scope, for working out which names a scan may legally mention.
 *
 * This has to model JavaScript's real scoping, not an approximation of it. A scan is generated code that
 * names variables, and naming one that is not in scope does not produce a slightly wrong trace — it throws
 * a `ReferenceError` and kills the program being visualised. Treating every block as part of its enclosing
 * scope did exactly that: a `let` inside an `if` was still mentioned by the scan placed *after* the `if`,
 * where it no longer exists.
 *
 * `isFunction` marks where the chain stops. Names from an enclosing function are reachable through a
 * closure, but they are not locals of this call, and the walk stops rather than reporting them as such.
 */
function childScope(parent) {
  return { names: [], parent, isFunction: false };
}

function functionScope(names) {
  return { names: [...names], parent: null, isFunction: true };
}

/** Names a scan at this point may mention, outermost first so the trace reads in declaration order. */
function visibleNames(scope) {
  const levels = [];
  for (let current = scope; current; current = current.parent) {
    levels.unshift(current.names);
    if (current.isFunction) break;
  }
  const seen = new Set();
  const out = [];
  for (const level of levels) {
    for (const name of level) {
      // An inner declaration shadows an outer one. Both spellings refer to the same identifier in generated
      // code, so mentioning it twice would report the same value twice.
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

/**
 * Record what a statement declares, in the scope that will actually hold it.
 *
 * `var` is function-scoped and really does outlive the block it appears in; `let`, `const`, classes and
 * function declarations do not. Getting this backwards is not a detail: put a `let` in the function scope
 * and later scans crash, put a `var` in the block scope and it vanishes from the trace the moment the block
 * ends even though the program can still see it.
 */
function declare(scope, statement) {
  const names = declaredNames(statement);
  if (names.length === 0) return;
  const hoists = statement.type === "VariableDeclaration" && statement.kind === "var";
  const target = hoists ? enclosingFunctionScope(scope) : scope;
  target.names.push(...names);
}

function enclosingFunctionScope(scope) {
  let current = scope;
  while (current.parent && !current.isFunction) current = current.parent;
  return current;
}

/**
 * Instrument the statements of one scope.
 *
 * @param {any[]} body
 * @param {MagicString} edits
 * @param {string} source
 * @param {{ nextRegion: number }} state
 * @param {{ names: string[], parent: object | null, isFunction: boolean }} scope
 */
function instrumentBody(body, edits, source, state, scope) {
  for (const statement of body) {
    const line = statement.loc.start.line;

    // The line marker goes first, so the trace says "about to run line N" before anything happens.
    edits.appendLeft(statement.start, `${RUNTIME}.line(${line});`);

    if (JUMPS.has(statement.type)) {
      // Nothing placed after this would run, so observe the scope before leaving.
      edits.appendLeft(statement.start, scan(scope, line));
      if (statement.type === "BreakStatement" || statement.type === "ContinueStatement") {
        const kind = statement.type === "BreakStatement" ? "break" : "continue";
        edits.appendLeft(statement.start, `${RUNTIME}.jump(${line},${JSON.stringify(kind)});`);
      }
      if (statement.type === "ReturnStatement") {
        instrumentReturn(statement, edits, scope);
      }
    }

    instrumentInner(statement, edits, source, state, scope);

    // Names this statement brings into existence become visible to later scans, not to this one: reading a
    // `let` before its declaration has run is a temporal dead zone error, and `typeof` throws for those too,
    // so no guard would have saved it.
    declare(scope, statement);

    if (!JUMPS.has(statement.type)) {
      edits.appendRight(statement.end, scan(scope, line));
    }
  }
}

/** A call handing the runtime the scope's current values. */
function scan(scope, line) {
  const names = visibleNames(scope);
  if (names.length === 0) return `${RUNTIME}.after(${line},null);`;
  const pairs = names.map((name) => `${JSON.stringify(name)}:${name}`).join(",");
  return `${RUNTIME}.after(${line},{${pairs}});`;
}

/** Report what a function returned without evaluating the expression twice. */
function instrumentReturn(statement, edits, scope) {
  if (!statement.argument) return;
  edits.appendLeft(statement.argument.start, `${RUNTIME}.returned(`);
  edits.appendRight(statement.argument.end, `)`);
}

/**
 * Recurse into the parts of a statement that contain more statements.
 *
 * Deliberately explicit rather than a generic walk. A generic walk would descend into expressions and
 * instrument things that are not statements, and the shapes that matter here are few enough to name.
 */
function instrumentInner(statement, edits, source, state, scope) {
  switch (statement.type) {
    case "FunctionDeclaration":
      instrumentFunction(statement, edits, source, state, scope, statement.id?.name ?? "anonymous");
      return;

    case "VariableDeclaration":
      // `const f = function () {}` and arrow functions get frames too.
      for (const declarator of statement.declarations) {
        const init = declarator.init;
        if (init && (init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression")) {
          instrumentFunction(init, edits, source, state, scope, declarator.id?.name ?? "anonymous");
        }
      }
      return;

    case "IfStatement": {
      // The condition's outcome is observed rather than re-evaluated, so a test with a side effect runs
      // exactly once.
      const kind = ELIF.has(statement) ? "elif" : "if";
      edits.appendLeft(statement.test.start, `${RUNTIME}.branch(${statement.loc.start.line},${JSON.stringify(kind)},${JSON.stringify(sourceOf(source, statement.test))},`);
      edits.appendRight(statement.test.end, `)`);
      instrumentBranchBody(statement.consequent, edits, source, state, scope);
      if (statement.alternate) {
        // `else if` is one construct to a reader and two nested nodes to a parser. The schema calls the
        // chained form "elif", because that is what it is regardless of the language's spelling.
        if (statement.alternate.type === "IfStatement") ELIF.add(statement.alternate);
        instrumentBranchBody(statement.alternate, edits, source, state, scope);
      }
      return;
    }

    case "WhileStatement":
    case "DoWhileStatement":
    case "ForStatement":
    case "ForOfStatement":
    case "ForInStatement": {
      const region = state.nextRegion++;
      const start = statement.loc.start.line;
      const end = statement.loc.end.line;
      edits.appendLeft(statement.start, `${RUNTIME}.loopEnter(${region},${start},${end});`);

      // The loop's own variable belongs to the loop, and the body is where it is visible. Without this the
      // counter of a `for` loop appears nowhere in the trace at all — which is a strange thing for a tool
      // that exists to show loops running, since `i` is usually the first thing anyone looks for.
      const bodyScope = childScope(scope);
      const header = statement.type === "ForStatement" ? statement.init : statement.left;
      if (header && header.type === "VariableDeclaration") declare(bodyScope, header);

      // Each pass through the body is one iteration.
      const body = statement.body;
      if (body.type === "BlockStatement") {
        edits.appendRight(body.start + 1, `${RUNTIME}.loopIter(${region});`);
        instrumentBody(body.body, edits, source, state, childScope(bodyScope));
      } else {
        edits.appendLeft(body.start, `{${RUNTIME}.loopIter(${region});`);
        edits.appendRight(body.end, `}`);
      }
      edits.appendRight(statement.end, `${RUNTIME}.loopExit(${region});`);
      return;
    }

    case "BlockStatement":
      instrumentBody(statement.body, edits, source, state, childScope(scope));
      return;

    case "TryStatement":
      instrumentBranchBody(statement.block, edits, source, state, scope);
      if (statement.handler) {
        // The caught value is handed over when the handler names it, so an exception raised at the top
        // level — which crossed no function frame and so was never seen unwinding — is still reported as
        // having been raised before it is reported as caught. A handler that destructures its argument, or
        // omits it entirely with `catch {}`, has no name to pass, and the catch is reported on its own.
        const bound = statement.handler.param?.type === "Identifier" ? statement.handler.param.name : null;
        const args = bound === null
          ? `${statement.handler.loc.start.line}`
          : `${statement.handler.loc.start.line},${bound}`;
        edits.appendRight(statement.handler.body.start + 1, `${RUNTIME}.caught(${args});`);
        // The caught value is a binding of the handler, so the handler's scope is where it belongs.
        const handlerScope = childScope(scope);
        if (statement.handler.param) collectPattern(statement.handler.param, handlerScope.names);
        instrumentBody(
          statement.handler.body.body,
          edits,
          source,
          state,
          handlerScope,
        );
      }
      if (statement.finalizer) instrumentBranchBody(statement.finalizer, edits, source, state, scope);
      return;

    case "ClassDeclaration":
      for (const member of statement.body.body) {
        if (member.type === "MethodDefinition" && member.value) {
          const name = `${statement.id?.name ?? "anonymous"}.${member.key.name ?? "method"}`;
          instrumentFunction(member.value, edits, source, state, scope, name);
        }
      }
      return;

    default:
      return;
  }
}

/**
 * A nested block: its own scope, since a braced block in JavaScript is one.
 *
 * A single unbraced statement — `if (x) doThing();` — cannot declare anything that outlives it, so giving it
 * a scope of its own costs nothing and keeps the two paths the same shape.
 */
function instrumentBranchBody(node, edits, source, state, scope) {
  const inner = childScope(scope);
  if (node.type === "BlockStatement") {
    instrumentBody(node.body, edits, source, state, inner);
  } else {
    instrumentBody([node], edits, source, state, inner);
  }
}

/** Give a function its own frame, with its parameters reported on entry. */
function instrumentFunction(fn, edits, source, state, parentScope, name) {
  const params = fn.params.map((p) => (p.type === "Identifier" ? p.name : null));
  const named = params.filter((p) => p !== null);
  const argPairs = named.map((p) => `${JSON.stringify(p)}:${p}`).join(",");

  // The frame id is kept in a local, so this function always knows which frame is its own.
  const enter = `const ${FRAME}=${RUNTIME}.enter(${JSON.stringify(name)},${fn.loc.start.line},{${argPairs}});`;
  const leave = `${RUNTIME}.leave(${FRAME});`;

  // The `catch` exists only to notice that an exception is leaving, so a loop this frame abandoned can be
  // reported as ending by `exception` rather than by `return`. It re-throws the same object, so the
  // program's own error handling is unchanged.
  const unwind = `}catch(${ERR}){${RUNTIME}.threw(${ERR});throw ${ERR};}finally{${leave}}`;

  if (fn.body.type === "BlockStatement") {
    edits.appendRight(fn.body.start + 1, `${enter}try{`);
    edits.appendLeft(fn.body.end - 1, unwind);
    instrumentBody(fn.body.body, edits, source, state, functionScope(named));
  } else {
    // A concise arrow body is an expression: wrap it so there is somewhere to put the frame.
    edits.appendLeft(fn.body.start, `{${enter}try{return ${RUNTIME}.returned(`);
    edits.appendRight(fn.body.end, `);${unwind}}`);
  }

  // Awaits belonging to *this* function, so it can say when it stops and starts running.
  instrumentAwaits(fn.body, edits);
}

/**
 * Mark where a function stops running and starts again.
 *
 * `await x` becomes `resumed(frame, await suspending(frame, x))`. The value is passed straight through both, so
 * the program's behaviour is untouched — all that changes is that the tracer knows this frame is parked.
 *
 * Without it, a frame suspended at an `await` still looks like the innermost thing running, so the next call is
 * reported as happening *inside* it. That is how two sibling calls came to look like recursion.
 *
 * Nested functions are skipped: their awaits belong to their own frames, and each is instrumented when that
 * function is.
 */
function instrumentAwaits(body, edits) {
  forEachAwait(body, (node) => {
    if (!node.argument) return;
    edits.appendLeft(node.start, `${RUNTIME}.resumed(${FRAME},`);
    edits.appendLeft(node.argument.start, `${RUNTIME}.suspending(${FRAME},`);
    edits.appendRight(node.argument.end, `))`);
  });
}

/** Visit every `await` that belongs to this function, without descending into nested ones. */
function forEachAwait(node, visit) {
  if (node === null || typeof node !== "object") return;
  if (FUNCTIONS.has(node.type)) return;
  if (node.type === "AwaitExpression") visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const each of child) forEachAwait(each, visit);
    } else if (child && typeof child === "object" && typeof child.type === "string") {
      forEachAwait(child, visit);
    }
  }
}

const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** The names a statement brings into scope. */
function declaredNames(statement) {
  const names = [];
  if (statement.type === "VariableDeclaration") {
    for (const declarator of statement.declarations) collectPattern(declarator.id, names);
  } else if (statement.type === "FunctionDeclaration" && statement.id) {
    names.push(statement.id.name);
  } else if (statement.type === "ClassDeclaration" && statement.id) {
    names.push(statement.id.name);
  }
  return names;
}

/** Destructuring means one declaration can introduce many names. */
function collectPattern(node, into) {
  if (!node) return;
  switch (node.type) {
    case "Identifier":
      into.push(node.name);
      return;
    case "ObjectPattern":
      for (const prop of node.properties) {
        collectPattern(prop.type === "RestElement" ? prop.argument : prop.value, into);
      }
      return;
    case "ArrayPattern":
      for (const element of node.elements) collectPattern(element, into);
      return;
    case "AssignmentPattern":
      collectPattern(node.left, into);
      return;
    case "RestElement":
      collectPattern(node.argument, into);
      return;
    default:
      return;
  }
}

function sourceOf(source, node) {
  return source.slice(node.start, node.end);
}
