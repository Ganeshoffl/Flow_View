/*
 * Tracing a Java program, and narrating it as the universal trace.
 *
 * ## How this works, and why
 *
 * Java has no `sys.settrace`. It has something better: the **Java Debug Interface**, which is how every Java
 * debugger ever written observes a running program. The program runs in a second JVM and this process drives
 * it — step a line, read the locals, step again.
 *
 * That is a deliberate choice over rewriting the source the way the JavaScript adapter does. Instrumentation
 * would be about forty times faster, and it was still rejected: Java's grammar is several times larger, and a
 * mistake there does not produce a slow trace but a wrong one, or a program that no longer compiles. The
 * JavaScript adapter shipped with a scope bug that killed every program containing a `let` inside a block, and
 * sixteen conformance cases failed to notice. JDI cannot have that class of bug, because not one line of the
 * user's program is altered. The reasoning and the measurements are in
 * docs/decisions/0006-tracing-java.md.
 *
 * What JDI does *not* give is structure: it reports "line 7 ran", not "that was the `else` arm of the `if` on
 * line 5". So, exactly as the Python adapter does, the source is parsed once up front for what the code
 * *says*, and execution supplies what actually *happened*. A condition's source text comes from the parse; its
 * outcome comes from watching which line runs next. The user's condition is never evaluated a second time,
 * because `if (queue.pop())` must not run twice.
 *
 * ## No dependencies, and no build step
 *
 * Both halves ship inside the JDK: `jdk.jdi` for execution, `jdk.compiler` for the parse and for compiling the
 * user's program. So this is one file, run straight from source with `java FlowViewTracer.java`. Nothing to
 * fetch, nothing to build, and it works offline — which is the whole point of the project.
 *
 * ## The cost, stated plainly
 *
 * About 0.5ms per step, so roughly 2,000 steps a second. A pasted program of a few dozen lines traces in well
 * under a second. But a 30-second budget only covers about 60,000 steps, so for Java it is usually the *clock*
 * that stops a long run rather than the step count — and the trace says `timeout` and explains itself rather
 * than letting anyone conclude flow_view has hung.
 *
 * Usage:
 *   java FlowViewTracer.java --source Main.java [--max-steps N] [--wall-ms N] [--output-bytes N]
 */

import com.sun.jdi.AbsentInformationException;
import com.sun.jdi.ArrayReference;
import com.sun.jdi.BooleanValue;
import com.sun.jdi.Bootstrap;
import com.sun.jdi.ByteValue;
import com.sun.jdi.CharValue;
import com.sun.jdi.ClassType;
import com.sun.jdi.DoubleValue;
import com.sun.jdi.Field;
import com.sun.jdi.FloatValue;
import com.sun.jdi.IncompatibleThreadStateException;
import com.sun.jdi.IntegerValue;
import com.sun.jdi.InterfaceType;
import com.sun.jdi.LocalVariable;
import com.sun.jdi.Location;
import com.sun.jdi.LongValue;
import com.sun.jdi.Method;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.ShortValue;
import com.sun.jdi.StackFrame;
import com.sun.jdi.StringReference;
import com.sun.jdi.ThreadReference;
import com.sun.jdi.Value;
import com.sun.jdi.VirtualMachine;
import com.sun.jdi.connect.Connector;
import com.sun.jdi.connect.LaunchingConnector;
import com.sun.jdi.event.Event;
import com.sun.jdi.event.EventQueue;
import com.sun.jdi.event.EventSet;
import com.sun.jdi.event.MethodEntryEvent;
import com.sun.jdi.event.MethodExitEvent;
import com.sun.jdi.event.StepEvent;
import com.sun.jdi.event.VMDeathEvent;
import com.sun.jdi.event.VMDisconnectEvent;
import com.sun.jdi.request.EventRequest;
import com.sun.jdi.request.MethodEntryRequest;
import com.sun.jdi.request.MethodExitRequest;
import com.sun.jdi.request.StepRequest;

import javax.tools.JavaCompiler;
import javax.tools.ToolProvider;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class FlowViewTracer {

    /** What the source says about each line. Read once, before the program runs. */
    private Analysis analysis = new Analysis();

    /**
     * How long to wait for the next event before checking the clock.
     *
     * Short enough that a runaway program is stopped promptly, long enough that waiting costs nothing while a
     * normal program is producing events steadily.
     */
    private static final long POLL_MS = 100;

    // ------------------------------------------------------------------ options

    /** Everything the run was asked for. Mirrors the other adapters' flags so the server can spawn any of them. */
    static final class Options {
        String source;
        String sessionId = "local";
        long maxSteps = 200_000;
        long wallMs = 30_000;
        long outputBytes = 1_048_576;
        long memoryMb = 512;
        boolean completeHeap = false;
        boolean collapse = true;
        Integer collapseKeep;
        Integer collapseChunk;
        Integer collapseMin;
        final List<String> unknown = new ArrayList<>();
    }

    static Options parse(String[] argv) {
        Options options = new Options();
        for (int i = 0; i < argv.length; i++) {
            String flag = argv[i];
            switch (flag) {
                case "--source" -> options.source = argv[++i];
                case "--session-id" -> options.sessionId = argv[++i];
                case "--max-steps" -> options.maxSteps = Long.parseLong(argv[++i]);
                case "--wall-ms" -> options.wallMs = Long.parseLong(argv[++i]);
                case "--output-bytes" -> options.outputBytes = Long.parseLong(argv[++i]);
                case "--memory-mb" -> options.memoryMb = Long.parseLong(argv[++i]);
                case "--complete-heap" -> options.completeHeap = true;
                case "--no-collapse" -> options.collapse = false;
                case "--collapse-keep" -> options.collapseKeep = Integer.parseInt(argv[++i]);
                case "--collapse-chunk" -> options.collapseChunk = Integer.parseInt(argv[++i]);
                case "--collapse-min" -> options.collapseMin = Integer.parseInt(argv[++i]);
                // Reported rather than ignored. Drift between the adapters should be visible.
                default -> options.unknown.add(flag);
            }
        }
        return options;
    }

    // ------------------------------------------------------------------ entry

    public static void main(String[] argv) throws Exception {
        Options options = parse(argv);
        // Flushed on every line, so the trace streams.
        //
        // Buffering it meant a run that was killed — the very case a step budget exists for — produced nothing
        // but a header, because everything it had already worked out was still sitting in memory. It also
        // matters for the server: the UI shows a run as it happens, which is impossible if the first event
        // arrives at the same time as the last.
        PrintWriter out = new PrintWriter(
                new BufferedWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8)), true);

        if (options.source == null) {
            out.println(Json.write(Map.of("seq", 0, "t", "note", "level", "warn",
                    "text", "--source is required")));
            out.flush();
            System.exit(2);
        }

        Path sourcePath = Path.of(options.source);
        String source;
        try {
            source = Files.readString(sourcePath);
        } catch (IOException error) {
            out.println(Json.write(Map.of("seq", 0, "t", "note", "level", "warn",
                    "text", "Could not read the program: " + error.getMessage())));
            out.flush();
            System.exit(2);
            return;
        }

        String path = sourcePath.getFileName().toString();
        String className = path.endsWith(".java") ? path.substring(0, path.length() - 5) : path;

        Emitter emitter = new Emitter(out, options, path, source);
        int code = new FlowViewTracer().run(emitter, options, sourcePath, source, path, className);
        out.flush();
        System.exit(code);
    }

    int run(Emitter emitter, Options options, Path sourcePath, String source, String path, String className)
            throws Exception {
        Path workdir = Files.createTempDirectory("flow_view_java_");
        Path classes = workdir.resolve("classes");
        Files.createDirectories(classes);

        // Compiled before the header is written, because a program that does not compile has no run to
        // describe. The failure is the user's result, not a tracer error.
        String compileError = compile(sourcePath, classes);
        emitter.header();
        if (options.unknown.size() > 0) {
            emitter.note("warn", "Ignored unrecognised options: " + String.join(" ", options.unknown));
        }
        emitter.emit("run_start", new LinkedHashMap<>());
        if (compileError != null) {
            emitter.note("warn", "Could not compile the program: " + compileError);
            emitter.finish("error", 1);
            return 1;
        }

        // Parsed only once the program is known to compile, so a syntax error is reported by the compiler with
        // the line it is on rather than silently producing an empty structure here.
        analysis = Analysis.of(sourcePath, source);

        return trace(emitter, options, classes, className);
    }

    /** Compile with debug information. Without `-g` there are no local names, and the whole point is lost. */
    static String compile(Path sourcePath, Path classes) {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            return "no Java compiler is available; flow_view needs a JDK rather than a JRE";
        }
        StringWriter diagnostics = new StringWriter();
        int status = compiler.run(
                null, null, new java.io.PrintStream(new java.io.ByteArrayOutputStream()),
                "-g", "-d", classes.toString(), "-proc:none", sourcePath.toString());
        if (status != 0) {
            // Re-run capturing diagnostics, so the message names the line.
            StringWriter captured = new StringWriter();
            compiler.run(null, null, new WriterOutputStream(captured), "-g", "-d", classes.toString(),
                    "-proc:none", sourcePath.toString());
            String text = captured.toString().trim();
            return text.isEmpty() ? "compilation failed" : firstUsefulLine(text);
        }
        diagnostics.flush();
        return null;
    }

    static String firstUsefulLine(String text) {
        for (String line : text.split("\n")) {
            String trimmed = line.trim();
            if (!trimmed.isEmpty() && !trimmed.startsWith("^")) {
                return trimmed;
            }
        }
        return text.trim();
    }

    /** An OutputStream that appends to a StringWriter, so javac's diagnostics can be captured as text. */
    static final class WriterOutputStream extends java.io.OutputStream {
        private final StringWriter target;

        WriterOutputStream(StringWriter target) {
            this.target = target;
        }

        @Override
        public void write(int b) {
            target.write((char) b);
        }
    }

    // ------------------------------------------------------------------ tracing

    int trace(Emitter emitter, Options options, Path classes, String className) throws Exception {
        LaunchingConnector connector = Bootstrap.virtualMachineManager().defaultConnector();
        Map<String, Connector.Argument> arguments = connector.defaultArguments();
        arguments.get("main").setValue(className);
        // The ceilings the server asked for have to be passed on: they were applied to *this* process, and the
        // program runs in a grandchild that inherited none of them.
        arguments.get("options").setValue(
                "-cp " + classes + " -Xmx" + Math.max(16, options.memoryMb) + "m -XX:-UsePerfData");

        VirtualMachine vm;
        try {
            vm = connector.launch(arguments);
        } catch (Exception error) {
            emitter.note("warn", "Could not start a JVM for the program: " + error.getMessage());
            emitter.finish("error", 1);
            return 1;
        }

        Encoder encoder = new Encoder(emitter);
        State state = new State();
        Output output = new Output(emitter, state, vm.process().getInputStream(),
                vm.process().getErrorStream());
        // Set FLOW_VIEW_JAVA_DEBUG=1 to see the raw event stream on stderr. The order JDI delivers events in is
        // the thing most likely to be misunderstood here, and guessing at it cost an afternoon once.
        boolean debug = "1".equals(System.getenv("FLOW_VIEW_JAVA_DEBUG"));

        // The program's input, forwarded as it arrives.
        //
        // On its own thread because the two ends are independent: the program may block on a read long before
        // anyone types, and this process is meanwhile sitting in the event loop.
        pumpStdin(vm.process().getOutputStream());

        // Entry first: it fires when the program's own `main` begins, which is where stepping should start.
        // Creating the step request before that would step through the JVM's startup.
        MethodEntryRequest entry = vm.eventRequestManager().createMethodEntryRequest();
        MethodExitRequest exit = vm.eventRequestManager().createMethodExitRequest();
        // Both caught and uncaught, because "this was handled" is as much a part of the story as the throw.
        // The class filters matter more here than anywhere else: the JVM raises and handles exceptions
        // routinely during startup and class loading, and without excluding its own code every run would begin
        // with a flurry of exceptions the program did not cause.
        com.sun.jdi.request.ExceptionRequest thrown =
                vm.eventRequestManager().createExceptionRequest(null, true, true);
        for (EventRequest request : List.of(entry, exit, thrown)) {
            exclude(request);
            request.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            request.enable();
        }

        // Reading input is the one thing the program does inside the standard library that the trace has to
        // show, because it is the program stopping to ask a question. So the library classes that do it are
        // watched specifically, having been excluded from everything else above.
        //
        // One request per class: JDI combines several filters on a single request with AND, so adding three
        // class filters to one request would match nothing at all.
        for (String reader : READING_CLASSES) {
            MethodEntryRequest readEntry = vm.eventRequestManager().createMethodEntryRequest();
            readEntry.addClassFilter(reader);
            readEntry.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            readEntry.enable();
            MethodExitRequest readExit = vm.eventRequestManager().createMethodExitRequest();
            readExit.addClassFilter(reader);
            readExit.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            readExit.enable();
        }

        String status = "ok";
        int exitCode = 0;
        EventQueue queue = vm.eventQueue();

        try {
            boolean running = true;
            while (running) {
                // Waited for with a limit, never indefinitely.
                //
                // A stepping request only completes when the *line* changes, so `while (true) { n += 1; }`
                // produces exactly one event and then nothing at all: the body and the jump back to it are the
                // same line, the program spins, and an unbounded `remove()` waits for an event that will never
                // come. The tracer hung for as long as it was allowed to, and the step budget could not save it
                // because budgets are only checked when an event arrives.
                //
                // The same applies to any program that stops producing events — blocked on a lock, waiting on a
                // socket, sleeping. Coming back empty-handed periodically is what lets the clock be enforced at
                // all.
                EventSet set = queue.remove(POLL_MS);
                if (set == null) {
                    // Not while the program is waiting for an answer. A person reading a question and typing a
                    // reply is not a runaway program, and charging that time to the clock would end the run for
                    // the one thing it was built to allow.
                    if (state.readDepth == 0) emitter.checkBudget();
                    continue;
                }
                for (Event event : set) {
                    if (debug) {
                        System.err.println("  jdi: " + describe(event)
                                + "  | shadow stack: " + state.describe());
                    }
                    if (event instanceof MethodEntryEvent entered) {
                        // Library methods reach here only because they were asked for by name, and the only
                        // reason to ask is that they read input.
                        if (isReader(entered.method())) onReadStart(emitter, state, entered.method());
                        else onEntry(emitter, encoder, state, vm, entered);
                    } else if (event instanceof MethodExitEvent exited) {
                        if (isReader(exited.method())) onReadEnd(emitter, state, exited);
                        else onExit(emitter, encoder, state, exited);
                    } else if (event instanceof com.sun.jdi.event.ExceptionEvent raised) {
                        onException(emitter, encoder, state, raised);
                    } else if (event instanceof StepEvent stepped) {
                        onStep(emitter, encoder, state, stepped);
                    } else if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) {
                        running = false;
                    }
                }
                // Drained while the program is suspended, so anything it printed on the line just executed is
                // reported before the next line begins.
                output.drain();
                if (running) {
                    set.resume();
                }
            }
        } catch (Emitter.BudgetExceeded stopped) {
            status = emitter.stopReason();
            try {
                vm.exit(0);
            } catch (com.sun.jdi.VMDisconnectedException alreadyGone) {
                // Killing a VM that has already died is not a problem.
            }
        } catch (com.sun.jdi.VMDisconnectedException disconnected) {
            // The program ended between one event and the next. Not an error, and not worth a note.
        }

        output.drain();
        emitter.seal();

        // An exception nothing handled ended the program. Reported here rather than when it was thrown, because
        // only now is it certain no handler was going to run — but the *stack* is the one captured at the throw,
        // since by now every frame has been unwound and the live stack says the program failed nowhere.
        if (state.uncaught != null) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("type", state.uncaught.type);
            payload.put("message", state.uncaught.message);
            payload.put("stack", state.uncaught.stack);
            emitter.emit("exception_uncaught", payload);
            status = "error";
            exitCode = 1;
        }

        // Frames the program never returned from, closed in the order they would have been.
        state.closeAll(emitter);
        emitter.finish(status, exitCode);
        return exitCode;
    }

    /**
     * An exception was raised.
     *
     * Reported once, where it happened. JDI says at the moment of the throw whether a handler exists and where
     * it is, which is what lets the trace distinguish "this was dealt with" from "this ended the run" without
     * waiting to find out.
     */
    void onException(Emitter emitter, Encoder encoder, State state, com.sun.jdi.event.ExceptionEvent event) {
        ObjectReference thrown = event.exception();
        String type = Encoder.typeNameOf(thrown);
        String message = encoder.messageOf(thrown);
        Location where = event.location();
        Long frame = state.currentFrame();

        Map<String, Object> payload = new LinkedHashMap<>();
        if (frame != null) payload.put("frame", frame);
        payload.put("line", where.lineNumber() > 0 ? where.lineNumber() : state.line);
        payload.put("path", emitter.path);
        payload.put("type", type);
        payload.put("message", message);
        emitter.emit("exception_raise", payload);

        // From here until the stack settles, the frames this tracer holds cannot be trusted: the exception may
        // leave any number of them without JDI reporting a single exit.
        state.unwinding = true;

        Location handler = event.catchLocation();
        if (handler == null) {
            state.uncaught = new State.Uncaught(type, message, stackOf(event.thread(), emitter.path));
        } else {
            // The handler has not run yet. Remembered, and reported when control actually reaches it, so the
            // order in the trace is the order things happened.
            state.pendingCatch = handler.lineNumber();
        }
    }

    /** The frames currently running, innermost first, with only the program's own in it. */
    static List<Map<String, Object>> stackOf(ThreadReference thread, String path) {
        List<Map<String, Object>> entries = new ArrayList<>();
        try {
            for (StackFrame frame : thread.frames()) {
                Location where = frame.location();
                String declaring = where.declaringType().name();
                if (declaring.startsWith("java.") || declaring.startsWith("javax.")
                        || declaring.startsWith("jdk.") || declaring.startsWith("sun.")
                        || declaring.startsWith("com.sun.")) {
                    continue;
                }
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("func", where.method().name());
                entry.put("path", path);
                entry.put("line", Math.max(1, where.lineNumber()));
                entries.add(entry);
            }
        } catch (IncompatibleThreadStateException ignored) {
            // The thread moved. An empty stack is caught by the corpus, so this cannot pass silently.
        }
        if (entries.isEmpty()) {
            entries.add(Map.of("func", "main", "path", path, "line", 1));
        }
        return entries;
    }

    /** Standard library classes that read input on the program's behalf. */
    private static final List<String> READING_CLASSES =
            List.of("java.util.Scanner", "java.io.BufferedReader", "java.io.Console");

    /**
     * Methods that consume input.
     *
     * Only the ones a program calls directly. `Scanner.nextInt` is implemented in terms of `next`, so both fire
     * and the nesting is counted rather than reported twice.
     */
    private static final java.util.Set<String> READING_METHODS = java.util.Set.of(
            "nextLine", "next", "nextInt", "nextLong", "nextShort", "nextByte",
            "nextDouble", "nextFloat", "nextBoolean", "nextBigInteger", "nextBigDecimal",
            "readLine", "readPassword");

    static boolean isReader(Method method) {
        String declaring = method.declaringType().name();
        return READING_CLASSES.contains(declaring) && READING_METHODS.contains(method.name());
    }

    /** The program has stopped to ask for input. */
    void onReadStart(Emitter emitter, State state, Method method) {
        if (state.readDepth++ > 0) return;
        state.readingSince = System.nanoTime();
        emitter.askStart(state.currentFrame(), state.line);
    }

    /** The answer arrived. Recorded, so replaying the trace needs no one present. */
    void onReadEnd(Emitter emitter, State state, MethodExitEvent event) {
        if (state.readDepth == 0) return;
        if (--state.readDepth > 0) return;
        double waited = (System.nanoTime() - state.readingSince) / 1e6;
        Value returned = event.returnValue();
        String text = returned instanceof StringReference typed ? typed.value()
                : returned == null ? "" : returned.toString();
        emitter.askEnd(text, waited);
    }

    /**
     * Forward this process's input to the program's.
     *
     * A daemon thread, so it cannot keep the tracer alive after the run is over, and byte at a time rather than
     * line at a time so a program that reads a single character is not left waiting for a newline.
     */
    static void pumpStdin(java.io.OutputStream into) {
        Thread pump = new Thread(() -> {
            try {
                byte[] buffer = new byte[4096];
                int read;
                while ((read = System.in.read(buffer)) > 0) {
                    into.write(buffer, 0, read);
                    into.flush();
                }
                into.close();
            } catch (IOException ignored) {
                // The program exited before its input was consumed. Nothing to do, and nothing wrong.
            }
        }, "flow-view-stdin");
        pump.setDaemon(true);
        pump.start();
    }

    /** One line describing a JDI event, for the debug stream. */
    static String describe(Event event) {
        if (event instanceof MethodEntryEvent typed) {
            return "entry " + typed.method().name() + ":" + typed.location().lineNumber();
        }
        if (event instanceof MethodExitEvent typed) {
            return "exit  " + typed.method().name() + ":" + typed.location().lineNumber();
        }
        if (event instanceof StepEvent typed) {
            return "step  " + typed.location().method().name() + ":" + typed.location().lineNumber();
        }
        if (event instanceof com.sun.jdi.event.ExceptionEvent typed) {
            Location caught = typed.catchLocation();
            return "throw " + typed.exception().referenceType().name()
                    + " at " + typed.location().method().name() + ":" + typed.location().lineNumber()
                    + (caught == null ? " (uncaught)"
                    : " caught at " + caught.method().name() + ":" + caught.lineNumber());
        }
        return event.getClass().getSimpleName();
    }

    /** Everything that is not the user's program is one step, not a tour of its internals. */
    static void exclude(EventRequest request) {
        String[] foreign = {"java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*", "jakarta.*", "kotlin.*"};
        for (String pattern : foreign) {
            if (request instanceof MethodEntryRequest typed) typed.addClassExclusionFilter(pattern);
            else if (request instanceof MethodExitRequest typed) typed.addClassExclusionFilter(pattern);
            else if (request instanceof StepRequest typed) typed.addClassExclusionFilter(pattern);
        }
    }

    void onEntry(Emitter emitter, Encoder encoder, State state, VirtualMachine vm, MethodEntryEvent event)
            throws Exception {
        Method method = event.location().method();
        ThreadReference thread = event.thread();

        // Stepping begins with the program's own first method and not before.
        if (state.stepRequest == null) {
            StepRequest step = vm.eventRequestManager()
                    .createStepRequest(thread, StepRequest.STEP_LINE, StepRequest.STEP_INTO);
            exclude(step);
            step.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            step.enable();
            state.stepRequest = step;
        }

        String name = method.name();
        long frame = state.nextFrame++;
        int depth = 0;
        for (State.Frame open : state.stack) {
            if (open.name.equals(name)) depth++;
        }
        Long caller = state.stack.isEmpty() ? null : state.stack.get(state.stack.size() - 1).id;

        List<Map<String, Object>> args = new ArrayList<>();
        Map<String, Value> captured = new LinkedHashMap<>();
        try {
            StackFrame top = thread.frame(0);
            List<LocalVariable> parameters = method.arguments();
            List<Value> values = top.getArgumentValues();
            for (int i = 0; i < parameters.size() && i < values.size(); i++) {
                Value value = values.get(i);
                String argName = parameters.get(i).name();
                args.add(Map.of("name", argName, "value", encoder.encode(value)));
                captured.put(argName, value);
            }
        } catch (AbsentInformationException | IncompatibleThreadStateException ignored) {
            // Compiled without names, or the thread moved on. Neither is worth losing the frame over.
        }

        State.Frame pushed = new State.Frame(frame, name, method);
        pushed.previous.putAll(captured);
        // Seeded with the line the method opens on, so the *first* statement in it is attributed correctly.
        // Left at zero, the first observation falls back to the line being entered and every method's opening
        // assignment is reported one line late.
        pushed.line = event.location().lineNumber();
        state.stack.add(pushed);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("frame", frame);
        payload.put("func", name);
        payload.put("args", args);
        payload.put("kind", "user");
        payload.put("recursion_depth", depth);
        payload.put("line", event.location().lineNumber());
        payload.put("path", emitter.path);
        if (caller != null) payload.put("caller", caller);
        emitter.emit("frame_push", payload);
        emitter.metric("call", 1);
    }

    void onExit(Emitter emitter, Encoder encoder, State state, MethodExitEvent event) {
        if (state.stack.isEmpty()) return;
        State.Frame frame = state.stack.remove(state.stack.size() - 1);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("frame", frame.id);
        payload.put("reason", "return");
        payload.put("line", frame.line > 0 ? frame.line : event.location().lineNumber());
        Value returned = event.returnValue();
        if (returned != null && !(returned instanceof com.sun.jdi.VoidValue)) {
            payload.put("return_value", encoder.encode(returned));
        }
        emitter.emit("frame_pop", payload);
    }

    void onStep(Emitter emitter, Encoder encoder, State state, StepEvent event) {
        Location where = event.location();
        int line = where.lineNumber();
        if (line <= 0) return;
        if (state.stack.isEmpty()) return;

        // Before anything else: is the stack this tracer believes in still the real one?
        //
        // JDI sends no MethodExitEvent for a method that exits by throwing. `divide` throws, `main` catches, and
        // the next event is a step in `main` while this tracer still thinks `divide` is running. Everything
        // after that is attributed to the wrong frame — the catch, the output, the return — and reading `main`'s
        // locals through `divide`'s variable table fails outright with "frame method different than variable's
        // method".
        //
        // Reconciling costs a round trip, so it is only done when there is reason to think something moved:
        // either the step is in a different method than the frame on top, or an exception is known to be
        // unwinding. Both of those tests are free.
        Method running = where.method();
        boolean suspect = state.unwinding
                || !running.equals(state.stack.get(state.stack.size() - 1).method);
        if (suspect) {
            reconcile(emitter, state, event.thread());
            if (state.stack.isEmpty()) return;
        }

        State.Frame frame = state.stack.get(state.stack.size() - 1);
        emitter.checkBudget();

        // A decision made on the previous line, settled now that it is clear where control went.
        resolveBranch(emitter, state, frame, line);
        // Any loop this frame has jumped out of, closed now that control is outside it.
        closeEscapedLoops(emitter, state, frame, line);
        // Arriving at a loop's body is one iteration of it, whichever loop form it is — but only an arrival
        // from somewhere else counts.
        //
        // A body line containing a call is stepped twice per pass: once on the way into the call and once when
        // it comes back. `total += twice(i)` therefore reported six iterations for three, because the line was
        // reached twice each time round. Requiring the previous line in this frame to be a different line
        // distinguishes "came round again" from "carried on where it left off": returning from a call leaves the
        // frame on the line it was already on, while a real iteration arrives from the header, or from the `do`,
        // or from the end of the body.
        if (frame.line != line) {
            for (Map.Entry<Integer, Analysis.Loop> candidate : analysis.loops.entrySet()) {
                Analysis.Loop loop = candidate.getValue();
                if (loop.bodyLine() == line && loop.bodyLine() != candidate.getKey()) {
                    countIteration(emitter, state, frame, candidate.getKey(), loop);
                    break;
                }
            }
        }

        // An exception was thrown and a handler existed; control has now reached it.
        if (state.pendingCatch != null) {
            Map<String, Object> caught = new LinkedHashMap<>();
            caught.put("frame", frame.id);
            caught.put("line", line);
            caught.put("path", emitter.path);
            caught.put("handler_line", state.pendingCatch);
            state.pendingCatch = null;
            emitter.emit("exception_catch", caught);
        }

        // The line that just finished, which is the line that did whatever is about to be observed.
        //
        // A variable is only seen to have changed *after* the statement that changed it, because that is when
        // the new value exists. Attributing the change to the line now being entered would say `y = x + 2`
        // assigned `x` — off by one line, on every assignment in the program. The Python adapter reports the
        // same way, which is what makes a trace from either of them mean the same thing.
        int assignedOn = frame.line > 0 ? frame.line : line;
        frame.line = line;
        // Output is attributed the same way and for the same reason: `System.out.println` on line 13 has
        // finished by the time control reaches line 14, so the text belongs to 13.
        state.line = assignedOn;

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("frame", frame.id);
        payload.put("line", line);
        payload.put("path", emitter.path);
        emitter.emit("step_line", payload);

        // Only look at state if the line that just ran could have changed any.
        //
        // This is the difference between two round trips per step and none. The source already says that
        // `if (n <= 1)` assigns nothing and calls nothing, so asking the other JVM to confirm it is work done to
        // learn something already known — and it was half the reads in the corpus outside tight loops.
        if (!analysis.changesNothing(assignedOn)) {
            observe(emitter, encoder, state, event.thread(), frame, assignedOn);
        }

        // A jump has to be announced as control leaves, because the loop it leaves only finds out afterwards
        // and "why did this loop stop" is the question the loop event has to answer.
        String jump = analysis.jumps.get(line);
        if (jump != null) {
            Map<String, Object> leaving = new LinkedHashMap<>();
            leaving.put("frame", frame.id);
            leaving.put("line", line);
            leaving.put("kind", jump);
            emitter.emit("jump", leaving);
            if (jump.equals("break")) frame.pendingJump = "break";
        }

        // Remembered, not resolved: this line has made a decision whose outcome is not yet observable.
        Analysis.Branch branch = analysis.branches.get(line);
        frame.pendingBranch = branch == null ? null : line;
    }

    /**
     * Decide the branch left pending by the previous line, from where control actually went.
     *
     * The outcome is read off the arrival line rather than by asking the program again. A condition with a side
     * effect — `if (queue.pop())` — would otherwise run twice, and the program being visualised would no longer
     * be the program the user wrote.
     */
    void resolveBranch(Emitter emitter, State state, State.Frame frame, int arrivedAt) {
        Integer pending = frame.pendingBranch;
        if (pending == null) return;
        frame.pendingBranch = null;

        Analysis.Branch branch = analysis.branches.get(pending);
        if (branch == null) return;
        boolean taken = arrivedAt == branch.bodyLine();

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("frame", frame.id);
        payload.put("line", pending);
        payload.put("kind", branch.kind());
        payload.put("expr", branch.expr());
        payload.put("outcome", taken ? "taken" : "not_taken");
        payload.put("target_line", arrivedAt);
        emitter.emit("branch", payload);
        emitter.metric("comparison", 1);

        Analysis.Loop loop = analysis.loops.get(pending);
        if (loop == null) return;

        // A loop written entirely on one line — `while (n < 2) n++;` — cannot be counted by arrivals at its
        // body, because the body's line and the header's are the same line and the two are indistinguishable.
        // There the condition coming back true *is* the evidence of an iteration, which is exact.
        if (loop.bodyLine() == pending && taken) {
            countIteration(emitter, state, frame, pending, loop);
        }

        if (!taken && !frame.loops.isEmpty()
                && frame.loops.get(frame.loops.size() - 1).branchLine == pending) {
            // The condition failed, which is the ordinary way for a loop to end.
            closeLoop(emitter, frame, "condition");
        }
    }

    /**
     * Control has reached a loop's body, so another iteration is under way.
     *
     * Opening the loop here rather than at its first true test is what makes every loop form count the same.
     */
    void countIteration(Emitter emitter, State state, State.Frame frame, int branchLine, Analysis.Loop loop) {
        State.OpenLoop open = null;
        for (State.OpenLoop candidate : frame.loops) {
            if (candidate.branchLine == branchLine) {
                open = candidate;
                break;
            }
        }
        if (open == null) {
            open = new State.OpenLoop(state.nextRegion++, branchLine, loop.lineStart(), loop.lineEnd());
            frame.loops.add(open);
            Map<String, Object> entered = new LinkedHashMap<>();
            entered.put("frame", frame.id);
            entered.put("region", open.region);
            entered.put("line_start", loop.lineStart());
            entered.put("line_end", loop.lineEnd());
            emitter.emit("loop_enter", entered);
        }
        Map<String, Object> iteration = new LinkedHashMap<>();
        iteration.put("frame", frame.id);
        iteration.put("region", open.region);
        iteration.put("i", open.iterations++);
        emitter.emit("loop_iter", iteration);
        emitter.metric("iteration", 1);
    }

    /**
     * Close any loop control has left without its condition failing.
     *
     * A `break` does not produce a false test — it jumps straight past the loop — so the only reliable evidence
     * that the loop is over is that execution is now somewhere outside it.
     */
    void closeEscapedLoops(Emitter emitter, State state, State.Frame frame, int line) {
        while (!frame.loops.isEmpty()) {
            State.OpenLoop open = frame.loops.get(frame.loops.size() - 1);
            if (line >= open.lineStart && line <= open.lineEnd) return;
            closeLoop(emitter, frame, frame.pendingJump == null ? "condition" : frame.pendingJump);
        }
    }

    void closeLoop(Emitter emitter, State.Frame frame, String reason) {
        if (frame.loops.isEmpty()) return;
        State.OpenLoop open = frame.loops.remove(frame.loops.size() - 1);
        frame.pendingJump = null;
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("frame", frame.id);
        payload.put("region", open.region);
        payload.put("iterations", open.iterations);
        payload.put("reason", reason);
        emitter.emit("loop_exit", payload);
    }

    /**
     * Bring the shadow stack back in line with the JVM's.
     *
     * The real depth is the authority. Any frame this tracer still holds above it has gone, and gone by being
     * thrown out of rather than by returning — a normal return arrives as a MethodExitEvent, which has already
     * popped it and reported the value it returned.
     */
    void reconcile(Emitter emitter, State state, ThreadReference thread) {
        int depth;
        try {
            depth = thread.frameCount();
        } catch (IncompatibleThreadStateException ignored) {
            return;
        }
        while (state.stack.size() > depth) {
            State.Frame lost = state.stack.remove(state.stack.size() - 1);
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("frame", lost.id);
            payload.put("reason", "exception");
            payload.put("line", lost.line > 0 ? lost.line : 1);
            emitter.emit("frame_pop", payload);
        }
        if (state.stack.size() == depth) state.unwinding = false;
    }

    /**
     * What moved, since the last time this frame was looked at.
     *
     * Diffing rather than being told, for the same reason the other adapters diff: nothing has to enumerate the
     * shapes an assignment can take, so none can be missed.
     */
    void observe(Emitter emitter, Encoder encoder, State state, ThreadReference thread, State.Frame frame,
                 int line) {
        // Whether the heap needs re-reading, as opposed to just the locals. A name being given a new value is
        // always reported; an object changing underneath an unchanged name is only possible on some lines.
        boolean mayMutate = analysis.mayMutate(line);
        StackFrame top;
        List<LocalVariable> declared;
        try {
            top = thread.frame(0);
            // Taken from the method actually running, not from the frame this tracer has recorded. They should
            // agree, and reconciliation above is what keeps them agreeing — but a variable table belongs to a
            // method, and using the wrong one throws rather than merely reporting something odd.
            Method running = top.location().method();
            declared = running.equals(frame.method) ? frame.variables() : running.variables();
        } catch (IncompatibleThreadStateException | AbsentInformationException ignored) {
            return;
        }

        List<LocalVariable> live = new ArrayList<>(declared.size());
        for (LocalVariable variable : declared) {
            // `getValues` refuses a variable that is not live at this instruction, so the list is filtered
            // rather than handed over whole. This is also exactly right for the trace: a variable whose
            // declaration has not run yet does not exist, and reporting it would invent a value.
            if (variable.isVisible(top)) live.add(variable);
        }
        if (live.isEmpty()) return;

        Map<LocalVariable, Value> now;
        try {
            now = top.getValues(live);
        } catch (IllegalArgumentException ignored) {
            return;
        }

        List<Value> touched = new ArrayList<>();
        for (Map.Entry<LocalVariable, Value> pair : now.entrySet()) {
            String name = pair.getKey().name();
            Value value = pair.getValue();
            boolean had = frame.previous.containsKey(name);
            Value before = frame.previous.get(name);
            if (had && sameValue(before, value)) {
                // Unchanged — but the object it points at may have grown, so it is worth looking inside *if*
                // this line could have changed an object at all. Re-walking a linked list after a line that
                // only compared two numbers is the most expensive way to discover nothing happened.
                if (mayMutate && !encoder.isInline(value)) touched.add(value);
                continue;
            }

            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("frame", frame.id);
            payload.put("name", name);
            payload.put("value", encoder.encode(value));
            payload.put("scope", "local");
            payload.put("line", line);
            if (had) payload.put("prev", encoder.encode(before));
            else payload.put("declared", true);
            emitter.emit("var_set", payload);
            emitter.metric("assignment", 1);
            frame.previous.put(name, value);
            if (!encoder.isInline(value)) touched.add(value);
        }

        for (Value value : touched) {
            encoder.walk((ObjectReference) value, frame.id, line);
        }
    }

    static boolean sameValue(Value a, Value b) {
        if (a == null || b == null) return a == b;
        if (a instanceof ObjectReference && b instanceof ObjectReference) {
            return ((ObjectReference) a).uniqueID() == ((ObjectReference) b).uniqueID();
        }
        return a.equals(b);
    }

    // ------------------------------------------------------------------ run state

    /** The frames currently open, and what was last seen in each. */
    static final class State {
        final List<Frame> stack = new ArrayList<>();
        long nextFrame = 0;
        long nextRegion = 0;
        StepRequest stepRequest;
        /** The line last executed anywhere, so output can be attributed to the step that produced it. */
        int line;
        /** The handler line of an exception that was thrown and is about to be caught. */
        Integer pendingCatch;
        /** The exception that ended the run, if one did. */
        Uncaught uncaught;
        /** True while an exception is travelling outwards, so the stack is checked rather than assumed. */
        boolean unwinding;
        /** How deep inside a library read call the program is. Nested reads are one question, not several. */
        int readDepth;
        long readingSince;

        Long currentFrame() {
            return stack.isEmpty() ? null : stack.get(stack.size() - 1).id;
        }

        record Uncaught(String type, String message, List<Map<String, Object>> stack) {
        }

        String describe() {
            StringBuilder out = new StringBuilder();
            for (Frame frame : stack) out.append(frame.name).append('#').append(frame.id).append(' ');
            return out.isEmpty() ? "(empty)" : out.toString().trim();
        }

        void closeAll(Emitter emitter) {
            for (int i = stack.size() - 1; i >= 0; i--) {
                Frame frame = stack.get(i);
                // A loop the frame never left, closed before the frame itself: a loop_enter with no matching
                // loop_exit leaves anyone tracking regions waiting for an end that never comes.
                while (!frame.loops.isEmpty()) {
                    OpenLoop open = frame.loops.remove(frame.loops.size() - 1);
                    Map<String, Object> exited = new LinkedHashMap<>();
                    exited.put("frame", frame.id);
                    exited.put("region", open.region);
                    exited.put("iterations", open.iterations);
                    exited.put("reason", "return");
                    emitter.emit("loop_exit", exited);
                }
                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("frame", frame.id);
                payload.put("reason", "return");
                payload.put("line", frame.line > 0 ? frame.line : 1);
                emitter.emit("frame_pop", payload);
            }
            stack.clear();
        }

        /** A loop this frame is inside. */
        static final class OpenLoop {
            final long region;
            /** The line whose condition decides this loop, used to recognise it again. */
            final int branchLine;
            /** The span of the whole statement, used to notice control leaving it. */
            final int lineStart;
            final int lineEnd;
            int iterations;

            OpenLoop(long region, int branchLine, int lineStart, int lineEnd) {
                this.region = region;
                this.branchLine = branchLine;
                this.lineStart = lineStart;
                this.lineEnd = lineEnd;
            }
        }

        static final class Frame {
            final long id;
            final String name;
            final Method method;
            final Map<String, Value> previous = new LinkedHashMap<>();
            /** Loops this frame is inside, innermost last. */
            final List<OpenLoop> loops = new ArrayList<>();
            int line;
            /** The line of a decision whose outcome is not yet known. */
            Integer pendingBranch;
            /** Set by a `break`, so the loop it leaves can say why it ended. */
            String pendingJump;
            private List<LocalVariable> cached;

            Frame(long id, String name, Method method) {
                this.id = id;
                this.name = name;
                this.method = method;
            }

            /**
             * The method's declared locals, fetched once.
             *
             * Asking JDI again on every step is a round trip that can only ever give the same answer — a
             * method's declared variables do not change between two visits to it.
             */
            List<LocalVariable> variables() throws AbsentInformationException {
                if (cached == null) cached = method.variables();
                return cached;
            }
        }
    }

    // ------------------------------------------------------------------ the program's output

    /**
     * The traced program's own output, turned into trace events.
     *
     * Read from the debuggee's pipes while it is suspended, so a line that printed is reported before the next
     * line runs. Its output must never reach this process's real stdout, which carries the trace.
     */
    static final class Output {
        private final Emitter emitter;
        private final State state;
        private final InputStream stdout;
        private final InputStream stderr;
        private final byte[] buffer = new byte[8192];

        Output(Emitter emitter, State state, InputStream stdout, InputStream stderr) {
            this.emitter = emitter;
            this.state = state;
            this.stdout = stdout;
            this.stderr = stderr;
        }

        void drain() {
            pump(stdout, "stdout");
            pump(stderr, "stderr");
        }

        private void pump(InputStream stream, String kind) {
            try {
                while (stream.available() > 0) {
                    int read = stream.read(buffer, 0, Math.min(buffer.length, stream.available()));
                    if (read <= 0) break;
                    emitter.output(kind, new String(buffer, 0, read, StandardCharsets.UTF_8),
                            state.currentFrame(), state.line);
                }
            } catch (IOException ignored) {
                // The pipe closed with the program. Nothing left to read, and nothing wrong.
            }
        }
    }

    // ------------------------------------------------------------------ values and the heap

    /**
     * Turning JDI values into the trace's own vocabulary.
     *
     * Two judgements live here. **Boxed primitives are unwrapped**: `Integer n = 5` is an object on the JVM's
     * heap, but showing it as a reference to a box containing 5 teaches nobody anything. And **the heap is read
     * to a bounded depth**, with the same ceilings the other adapters use, because an unbounded walk after
     * every statement was measured at 28ms per step in Python and is no cheaper here.
     */
    static final class Encoder {
        static final int MAX_DEPTH = 3;
        static final int MAX_OBJECTS = 128;
        static final int MAX_SLOTS = 32;

        private final Emitter emitter;
        private final Map<Long, Long> ids = new HashMap<>();
        private final Map<Long, Map<String, Value>> slots = new HashMap<>();
        private final Map<ReferenceType, String> kinds = new HashMap<>();
        private final Map<ReferenceType, Field> boxes = new HashMap<>();
        private long nextId = 1;

        Encoder(Emitter emitter) {
            this.emitter = emitter;
        }

        Map<String, Object> encode(Value value) {
            if (value == null) return prim(null);
            if (value instanceof BooleanValue typed) return prim(typed.value());
            if (value instanceof ByteValue typed) return prim(typed.value());
            if (value instanceof ShortValue typed) return prim(typed.value());
            if (value instanceof IntegerValue typed) return prim(typed.value());
            if (value instanceof LongValue typed) return prim(typed.value());
            if (value instanceof CharValue typed) return prim(String.valueOf(typed.value()));
            if (value instanceof FloatValue typed) return real(typed.value());
            if (value instanceof DoubleValue typed) return real(typed.value());
            if (value instanceof StringReference typed) return prim(typed.value());

            if (value instanceof ObjectReference reference) {
                Value unboxed = unbox(reference);
                if (unboxed != null) return encode(unboxed);
                return Map.of("ref", idFor(reference));
            }
            return prim(null);
        }

        static Map<String, Object> prim(Object value) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("prim", value);
            return out;
        }

        /** Infinity and NaN have no JSON spelling, so the schema names them. */
        static Map<String, Object> real(double value) {
            if (Double.isNaN(value)) return prim("nan");
            if (value == Double.POSITIVE_INFINITY) return prim("inf");
            if (value == Double.NEGATIVE_INFINITY) return prim("-inf");
            return prim(value);
        }

        /**
         * A throwable's message, read rather than asked for.
         *
         * `Throwable.detailMessage` is read as a field instead of calling `getMessage()`. Invoking a method in
         * the debuggee means running the program's code to describe the program's failure: an overridden
         * `getMessage` could have side effects, or throw, or not return.
         */
        String messageOf(ObjectReference thrown) {
            ReferenceType type = thrown.referenceType();
            Field field = type.fieldByName("detailMessage");
            if (field == null) return "";
            Value value = thrown.getValue(field);
            return value instanceof StringReference text ? text.value() : "";
        }

        /** The value inside a boxed primitive, or null if this is not one. */
        Value unbox(ObjectReference reference) {
            ReferenceType type = reference.referenceType();
            if (!boxes.containsKey(type)) {
                Field field = switch (type.name()) {
                    case "java.lang.Integer", "java.lang.Long", "java.lang.Short", "java.lang.Byte",
                         "java.lang.Double", "java.lang.Float", "java.lang.Boolean",
                         "java.lang.Character" -> type.fieldByName("value");
                    default -> null;
                };
                boxes.put(type, field);
            }
            Field field = boxes.get(type);
            return field == null ? null : reference.getValue(field);
        }

        long idFor(ObjectReference reference) {
            long unique = reference.uniqueID();
            Long existing = ids.get(unique);
            if (existing != null) return existing;
            long assigned = nextId++;
            ids.put(unique, assigned);
            announce(assigned, reference);
            return assigned;
        }

        boolean known(ObjectReference reference) {
            return ids.containsKey(reference.uniqueID());
        }

        void announce(long id, ObjectReference reference) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("obj", id);
            payload.put("kind", kindOf(reference));
            payload.put("type_name", typeNameOf(reference));
            Integer length = lengthOf(reference);
            if (length != null) payload.put("length", length);
            emitter.emit("obj_new", payload);
            emitter.metric("allocation", 1);
        }

        String kindOf(ObjectReference reference) {
            if (reference instanceof ArrayReference) return "list";
            ReferenceType type = reference.referenceType();
            String cached = kinds.get(type);
            if (cached != null) return cached;

            String kind = "instance";
            List<InterfaceType> interfaces = type instanceof ClassType classType
                    ? classType.allInterfaces() : List.of();
            for (InterfaceType each : interfaces) {
                String name = each.name();
                if (name.equals("java.util.Map")) { kind = "map"; break; }
                if (name.equals("java.util.Set")) { kind = "set"; break; }
                if (name.equals("java.util.List")) { kind = "list"; break; }
            }
            kinds.put(type, kind);
            return kind;
        }

        /**
         * A value that belongs *in* the trace rather than on the heap.
         *
         * Strings and boxed primitives are objects to the JVM and values to everybody else. Left as objects,
         * `String label = "hi"` put a `String` in the heap pane carrying `coder`, `hash`, `hashIsZero` and a
         * `byte[]` of character codes — four entries of JDK bookkeeping in place of the word "hi". This is the
         * same flaw that was fixed once already for Python, where the heap showed 49 objects of which 45 were
         * flow_view's and the JDK's rather than the program's.
         */
        boolean isInline(Value value) {
            if (!(value instanceof ObjectReference reference)) return true;
            if (value instanceof StringReference) return true;
            return unbox(reference) != null;
        }

        /**
         * Whether an object's insides belong to the user or to the JDK.
         *
         * A library object is shown as itself — a `BigDecimal`, a `LocalDate` — and not as the fields it happens
         * to be built from. Nobody pasted a program in order to read `java.time`'s internals, and a heap full of
         * them buries the two objects that matter.
         */
        static boolean isOpaque(ObjectReference reference) {
            if (reference instanceof ArrayReference) return false;
            String name = reference.referenceType().name();
            return name.startsWith("java.") || name.startsWith("javax.") || name.startsWith("jdk.")
                    || name.startsWith("sun.") || name.startsWith("com.sun.");
        }

        static String typeNameOf(ObjectReference reference) {
            String name = reference.referenceType().name();
            // The simple name is what a reader recognises; the package is noise in a heap view.
            int dot = name.lastIndexOf('.');
            if (dot >= 0) name = name.substring(dot + 1);
            // A nested class arrives as `Outer$Inner`. `Inner` is what the user called it — unless the part
            // after the `$` is a number, which means the compiler named it and `Outer$1` is the clearest
            // available answer.
            int dollar = name.lastIndexOf('$');
            if (dollar >= 0 && dollar < name.length() - 1) {
                String tail = name.substring(dollar + 1);
                if (!tail.chars().allMatch(Character::isDigit)) name = tail;
            }
            return name;
        }

        Integer lengthOf(ObjectReference reference) {
            if (reference instanceof ArrayReference array) return array.length();
            // A collection's own idea of how big it is, which is not the same as how much room it has.
            Field size = reference.referenceType().fieldByName("size");
            if (size != null && reference.getValue(size) instanceof IntegerValue count) {
                return count.value();
            }
            return null;
        }

        void walk(ObjectReference root, long frame, int line) {
            Map<Long, Boolean> visited = new IdentityHashMap<>();
            int[] budget = {MAX_OBJECTS};
            walkFrom(root, frame, line, 0, visited, budget);
        }

        private void walkFrom(ObjectReference reference, long frame, int line, int depth,
                              Map<Long, Boolean> visited, int[] budget) {
            if (depth > MAX_DEPTH) return;
            long id = idFor(reference);
            if (visited.put(id, Boolean.TRUE) != null) return;
            if (budget[0]-- <= 0) return;

            boolean seen = slots.containsKey(id);
            Map<String, Value> before = slots.getOrDefault(id, Map.of());
            Map<String, Value> now = readSlots(reference);
            List<ObjectReference> children = new ArrayList<>();

            for (Map.Entry<String, Value> pair : now.entrySet()) {
                String key = pair.getKey();
                Value value = pair.getValue();
                if (value instanceof ObjectReference child && !isInline(child)) {
                    // Followed whether or not it changed: an object two levels down can grow while the
                    // reference to it stays exactly the same.
                    children.add(child);
                }
                boolean had = before.containsKey(key);
                if (had && sameValue(before.get(key), value)) continue;

                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("obj", id);
                payload.put("key", key);
                payload.put("value", encode(value));
                // A new key on an object already known is a mutation; on a new object it is construction.
                payload.put("op", had ? "set" : seen ? "append" : "set");
                if (had) payload.put("prev", encode(before.get(key)));
                payload.put("frame", frame);
                payload.put("line", line);
                emitter.emit("obj_set", payload);
                emitter.metric("write", 1);
            }

            for (String key : before.keySet()) {
                if (!now.containsKey(key)) {
                    Map<String, Object> payload = new LinkedHashMap<>();
                    payload.put("obj", id);
                    payload.put("key", key);
                    payload.put("value", prim(null));
                    payload.put("prev", encode(before.get(key)));
                    payload.put("op", "delete");
                    payload.put("frame", frame);
                    payload.put("line", line);
                    emitter.emit("obj_set", payload);
                    emitter.metric("write", 1);
                }
            }

            slots.put(id, now);
            for (ObjectReference child : children) {
                walkFrom(child, frame, line, depth + 1, visited, budget);
            }
        }

        /**
         * The contents of a standard collection, or null if this is not one.
         *
         * Java's collections are library objects, and the rule below is that library objects are not opened up.
         * Applied to a `List`, that rule hides the very thing the program is about: `items.add(30)` produced no
         * visible change at all, and two names pointing at one list looked like two names pointing at nothing.
         *
         * So the common collections are read directly, by their fields, and presented as what they hold. An
         * `ArrayList` is shown as its elements — not as an `elementData` array with trailing nulls and a `size`
         * counter, which is how it is built rather than what it is.
         *
         * Read, never invoked. Calling `toArray()` or `entrySet()` in the debuggee would mean running the
         * program's own code to describe it, and an overridden method could have side effects, or throw, or not
         * come back at all.
         */
        Map<String, Value> collectionSlots(ObjectReference reference) {
            String name = reference.referenceType().name();
            return switch (name) {
                case "java.util.ArrayList", "java.util.Vector" -> listSlots(reference);
                case "java.util.HashMap", "java.util.LinkedHashMap", "java.util.TreeMap" ->
                        mapSlots(reference);
                case "java.util.HashSet", "java.util.LinkedHashSet", "java.util.TreeSet" ->
                        setSlots(reference);
                default -> null;
            };
        }

        private Map<String, Value> listSlots(ObjectReference list) {
            Map<String, Value> out = new LinkedHashMap<>();
            Field sizeField = list.referenceType().fieldByName("size");
            Field dataField = list.referenceType().fieldByName("elementData");
            if (sizeField == null || dataField == null) return out;
            if (!(list.getValue(sizeField) instanceof IntegerValue size)) return out;
            if (!(list.getValue(dataField) instanceof ArrayReference data)) return out;
            int shown = Math.min(Math.min(size.value(), data.length()), MAX_SLOTS);
            if (shown <= 0) return out;
            List<Value> values = data.getValues(0, shown);
            for (int i = 0; i < values.size(); i++) out.put(String.valueOf(i), values.get(i));
            return out;
        }

        private Map<String, Value> mapSlots(ObjectReference map) {
            Map<String, Value> out = new LinkedHashMap<>();
            Field tableField = map.referenceType().fieldByName("table");
            if (tableField == null) return out;
            if (!(map.getValue(tableField) instanceof ArrayReference table)) return out;
            for (Value bucket : table.getValues()) {
                // Each bucket is a chain of entries; a collision puts more than one key in the same slot.
                ObjectReference node = bucket instanceof ObjectReference entry ? entry : null;
                while (node != null && out.size() < MAX_SLOTS) {
                    ReferenceType nodeType = node.referenceType();
                    Field keyField = nodeType.fieldByName("key");
                    Field valueField = nodeType.fieldByName("value");
                    Field nextField = nodeType.fieldByName("next");
                    if (keyField == null || valueField == null) break;
                    Value key = node.getValue(keyField);
                    out.put(keyText(key), node.getValue(valueField));
                    Value next = nextField == null ? null : node.getValue(nextField);
                    node = next instanceof ObjectReference following ? following : null;
                }
            }
            return out;
        }

        private Map<String, Value> setSlots(ObjectReference set) {
            Map<String, Value> out = new LinkedHashMap<>();
            Field mapField = set.referenceType().fieldByName("map");
            if (mapField == null) return out;
            if (!(set.getValue(mapField) instanceof ObjectReference backing)) return out;
            // A set is a map whose values nobody looks at, so only the keys are its contents.
            int index = 0;
            for (String key : mapSlots(backing).keySet()) {
                out.put(String.valueOf(index++), backing.virtualMachine().mirrorOf(key));
            }
            return out;
        }

        /** A map key rendered as the string the schema wants for a slot name. */
        String keyText(Value key) {
            if (key == null) return "null";
            if (key instanceof StringReference text) return text.value();
            if (key instanceof ObjectReference object) {
                Value unboxed = unbox(object);
                if (unboxed != null) return keyText(unboxed);
                return "(object)";
            }
            if (key instanceof CharValue typed) return String.valueOf(typed.value());
            return key.toString();
        }

        /** An object's contents: array elements, or the fields the user declared. */
        Map<String, Value> readSlots(ObjectReference reference) {
            Map<String, Value> out = new LinkedHashMap<>();
            if (reference instanceof ArrayReference array) {
                int length = array.length();
                int shown = Math.min(length, MAX_SLOTS);
                if (shown > 0) {
                    List<Value> values = array.getValues(0, shown);
                    for (int i = 0; i < values.size(); i++) out.put(String.valueOf(i), values.get(i));
                }
                return out;
            }

            // A collection is shown as its contents, before the library rule below would hide them.
            Map<String, Value> collection = collectionSlots(reference);
            if (collection != null) return collection;

            // A library object is reported as itself and not opened up.
            if (isOpaque(reference)) return out;

            ReferenceType type = reference.referenceType();
            List<Field> fields = new ArrayList<>();
            for (Field field : type.fields()) {
                if (!field.isStatic() && !field.isSynthetic()) fields.add(field);
            }
            fields.sort(Comparator.comparing(Field::name));
            if (fields.isEmpty()) return out;
            if (fields.size() > MAX_SLOTS) fields = fields.subList(0, MAX_SLOTS);
            Map<Field, Value> values = reference.getValues(fields);
            for (Field field : fields) out.put(field.name(), values.get(field));
            return out;
        }
    }

    // ------------------------------------------------------------------ what the source says

    /**
     * The shape of the program, read once before it runs.
     *
     * JDI reports that line 7 executed. It cannot report that line 7 was the `else` arm of the `if` on line 5,
     * because that is a fact about the source rather than about the execution. So the source is parsed — with
     * javac's own parser, which ships in the JDK — and the two are put together at run time.
     *
     * The division of labour is the same one the Python adapter uses, and it matters: a condition's **source
     * text** comes from here, and its **outcome** never does. The outcome is worked out by seeing which line
     * runs next. Asking the program again what `queue.pop()` evaluates to would run it twice.
     */
    static final class Analysis {
        /** Lines that make a decision, by line number. */
        final Map<Integer, Branch> branches = new HashMap<>();
        /** Loops, by the line their header sits on. */
        final Map<Integer, Loop> loops = new HashMap<>();
        /** Lines that are a `break` or a `continue`. */
        final Map<Integer, String> jumps = new HashMap<>();

        /**
         * Lines that could give a local a new value.
         *
         * Reading every visible local after every line is the single most expensive thing this tracer does: two
         * round trips to the other JVM, against 0.16ms for the step itself. Measured across the conformance
         * corpus, half of those reads outside tight loops found nothing had changed — the work was done to
         * discover that `if (score >= 90)` assigns nothing, which the source already says.
         */
        final java.util.Set<Integer> assigning = new java.util.HashSet<>();

        /**
         * Lines that could change an object in place.
         *
         * Separate from assignment because the cost is separate and much larger: walking the heap reads an
         * object's fields, and then the fields of what those point at. `head.next.next` was re-walked on every
         * step of the program, and 84% of the reads in that case found nothing.
         *
         * A call is included whatever it looks like, because any call may mutate anything it was handed.
         */
        final java.util.Set<Integer> mutating = new java.util.HashSet<>();

        /**
         * Whether a line is known to change nothing at all.
         *
         * Phrased so that not knowing means doing the work. A line missing from both sets because the parse
         * failed, or because it holds a construct the scanner does not recognise, must still be observed: being
         * slower than necessary is a cost, while missing a variable change is a wrong trace.
         */
        boolean changesNothing(int line) {
            return parsed && !assigning.contains(line) && !mutating.contains(line);
        }

        boolean mayMutate(int line) {
            return !parsed || mutating.contains(line);
        }

        /** False when the source could not be read, in which case nothing here may be trusted. */
        boolean parsed;

        record Branch(String kind, String expr, int bodyLine) {
        }

        /**
         * A loop, and the three lines that describe it.
         *
         * `bodyLine` is what iterations are counted on, and that is not an implementation detail. Counting on
         * the condition instead undercounts a `do`/`while` by exactly one, because a do-while runs its body
         * before it ever tests anything: two passes through the body produced one test that came back true, and
         * the trace reported one iteration for two.
         *
         * Counting arrivals at the body works for every loop form. A `for`, a `while`, an enhanced `for` and a
         * `do`/`while` all reach their body exactly once per iteration, whatever order they test in.
         */
        record Loop(int lineStart, int lineEnd, int bodyLine) {
        }

        static Analysis of(Path sourcePath, String source) {
            Analysis analysis = new Analysis();
            try {
                JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
                if (compiler == null) return analysis;
                javax.tools.StandardJavaFileManager files =
                        compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8);
                Iterable<? extends javax.tools.JavaFileObject> units =
                        files.getJavaFileObjects(sourcePath.toFile());
                // `-proc:none` because annotation processors would be someone else's code running during what
                // is meant to be a read of the text.
                com.sun.source.util.JavacTask task = (com.sun.source.util.JavacTask) compiler.getTask(
                        new StringWriter(), files, diagnostic -> {
                        }, List.of("-proc:none"), null, units);
                com.sun.source.util.SourcePositions positions =
                        com.sun.source.util.Trees.instance(task).getSourcePositions();

                for (com.sun.source.tree.CompilationUnitTree unit : task.parse()) {
                    new Scanner(analysis, unit, positions, source).scan(unit, null);
                }
                files.close();
                analysis.parsed = true;
            } catch (Exception ignored) {
                // A program that does not parse is reported by the compile step, which runs separately and owns
                // that message. Losing the structure only costs branch and loop events, so a partial answer is
                // better than no trace at all.
            }
            return analysis;
        }

        /** Walks the parsed program, recording the three things the tracer cannot see for itself. */
        static final class Scanner extends com.sun.source.util.TreeScanner<Void, Void> {
            private final Analysis into;
            private final com.sun.source.tree.CompilationUnitTree unit;
            private final com.sun.source.util.SourcePositions positions;
            private final String source;
            private final com.sun.source.tree.LineMap lines;
            /** `if` statements that are the `else` of another, so they can be reported as chained. */
            private final java.util.Set<com.sun.source.tree.Tree> chained =
                    java.util.Collections.newSetFromMap(new IdentityHashMap<>());

            Scanner(Analysis into, com.sun.source.tree.CompilationUnitTree unit,
                    com.sun.source.util.SourcePositions positions, String source) {
                this.into = into;
                this.unit = unit;
                this.positions = positions;
                this.source = source;
                this.lines = unit.getLineMap();
            }

            private int lineOf(com.sun.source.tree.Tree tree) {
                long start = positions.getStartPosition(unit, tree);
                return start < 0 ? -1 : (int) lines.getLineNumber(start);
            }

            private int endLineOf(com.sun.source.tree.Tree tree) {
                long end = positions.getEndPosition(unit, tree);
                return end < 0 ? -1 : (int) lines.getLineNumber(end);
            }

            private String textOf(com.sun.source.tree.Tree tree) {
                long start = positions.getStartPosition(unit, tree);
                long end = positions.getEndPosition(unit, tree);
                if (start < 0 || end < 0 || end > source.length() || end <= start) return "";
                String text = source.substring((int) start, (int) end).trim();
                // A parenthesised condition reads better without the parentheses javac counts as part of it.
                while (text.startsWith("(") && text.endsWith(")") && balanced(text)) {
                    text = text.substring(1, text.length() - 1).trim();
                }
                return text;
            }

            /** Whether the outermost parentheses of the text wrap the whole of it. */
            private static boolean balanced(String text) {
                int depth = 0;
                for (int i = 0; i < text.length(); i++) {
                    char c = text.charAt(i);
                    if (c == '(') depth++;
                    else if (c == ')') {
                        depth--;
                        if (depth == 0) return i == text.length() - 1;
                    }
                }
                return false;
            }

            /**
             * The first line that actually runs when this arm is taken.
             *
             * This is the whole basis for deciding an outcome, so it has to be the line control lands on and not
             * the line the brace is on: `if (x) {` puts the brace on the `if`'s own line, and the first
             * statement inside is what executes.
             */
            private int firstLineOf(com.sun.source.tree.StatementTree statement) {
                if (statement == null) return -1;
                if (statement instanceof com.sun.source.tree.BlockTree block) {
                    for (com.sun.source.tree.StatementTree inner : block.getStatements()) {
                        int line = lineOf(inner);
                        if (line > 0) return line;
                    }
                    return endLineOf(block);
                }
                return lineOf(statement);
            }

            @Override
            public Void visitIf(com.sun.source.tree.IfTree tree, Void ignored) {
                int line = lineOf(tree);
                if (line > 0) {
                    // `else if` is one construct to a reader and two nested nodes to a parser. The schema calls
                    // the chained form "elif", which is what it is whatever the language spells it.
                    String kind = chained.contains(tree) ? "elif" : "if";
                    into.branches.put(line,
                            new Branch(kind, textOf(tree.getCondition()), firstLineOf(tree.getThenStatement())));
                }
                if (tree.getElseStatement() instanceof com.sun.source.tree.IfTree nested) {
                    chained.add(nested);
                }
                return super.visitIf(tree, ignored);
            }

            @Override
            public Void visitWhileLoop(com.sun.source.tree.WhileLoopTree tree, Void ignored) {
                record(lineOf(tree), lineOf(tree), endLineOf(tree), "while", textOf(tree.getCondition()),
                        firstLineOf(tree.getStatement()));
                return super.visitWhileLoop(tree, ignored);
            }

            @Override
            public Void visitDoWhileLoop(com.sun.source.tree.DoWhileLoopTree tree, Void ignored) {
                // A do-while tests at the bottom, so the deciding line is the condition's — but the loop itself
                // begins at the `do`, and its range has to cover the body or control would look as though it had
                // left the loop the moment it entered it.
                record(lineOf(tree.getCondition()), lineOf(tree), endLineOf(tree), "while",
                        textOf(tree.getCondition()), firstLineOf(tree.getStatement()));
                return super.visitDoWhileLoop(tree, ignored);
            }

            @Override
            public Void visitForLoop(com.sun.source.tree.ForLoopTree tree, Void ignored) {
                String expr = tree.getCondition() == null ? "" : textOf(tree.getCondition());
                record(lineOf(tree), lineOf(tree), endLineOf(tree), "for", expr,
                        firstLineOf(tree.getStatement()));
                return super.visitForLoop(tree, ignored);
            }

            @Override
            public Void visitEnhancedForLoop(com.sun.source.tree.EnhancedForLoopTree tree, Void ignored) {
                record(lineOf(tree), lineOf(tree), endLineOf(tree), "for", textOf(tree.getExpression()),
                        firstLineOf(tree.getStatement()));
                return super.visitEnhancedForLoop(tree, ignored);
            }

            // -- what each line can change -------------------------------------------------------------
            //
            // Recorded against the line the *operation* sits on rather than the line the statement starts on,
            // because a statement broken across several lines does its assigning on one of them.

            @Override
            public Void visitAssignment(com.sun.source.tree.AssignmentTree tree, Void ignored) {
                int line = lineOf(tree);
                if (line > 0) {
                    into.assigning.add(line);
                    // `xs[0] = 1` and `node.next = other` change an object rather than a local, so the heap has
                    // to be re-read as well. Only a bare name is purely a local.
                    if (!(tree.getVariable() instanceof com.sun.source.tree.IdentifierTree)) {
                        into.mutating.add(line);
                    }
                }
                return super.visitAssignment(tree, ignored);
            }

            @Override
            public Void visitCompoundAssignment(com.sun.source.tree.CompoundAssignmentTree tree, Void ignored) {
                int line = lineOf(tree);
                if (line > 0) {
                    into.assigning.add(line);
                    if (!(tree.getVariable() instanceof com.sun.source.tree.IdentifierTree)) {
                        into.mutating.add(line);
                    }
                }
                return super.visitCompoundAssignment(tree, ignored);
            }

            @Override
            public Void visitUnary(com.sun.source.tree.UnaryTree tree, Void ignored) {
                // `i++` and `--n` assign; `!flag` and `-x` do not.
                switch (tree.getKind()) {
                    case POSTFIX_INCREMENT, POSTFIX_DECREMENT, PREFIX_INCREMENT, PREFIX_DECREMENT -> {
                        int line = lineOf(tree);
                        if (line > 0) {
                            into.assigning.add(line);
                            if (!(tree.getExpression() instanceof com.sun.source.tree.IdentifierTree)) {
                                into.mutating.add(line);
                            }
                        }
                    }
                    default -> {
                    }
                }
                return super.visitUnary(tree, ignored);
            }

            @Override
            public Void visitVariable(com.sun.source.tree.VariableTree tree, Void ignored) {
                // A declaration brings a name into existence, which is a change worth reporting even when
                // nothing is assigned to it.
                int line = lineOf(tree);
                if (line > 0) into.assigning.add(line);
                return super.visitVariable(tree, ignored);
            }

            @Override
            public Void visitMethodInvocation(com.sun.source.tree.MethodInvocationTree tree, Void ignored) {
                // Any call may change anything it can reach, so a line containing one is never skipped.
                int line = lineOf(tree);
                if (line > 0) into.mutating.add(line);
                return super.visitMethodInvocation(tree, ignored);
            }

            @Override
            public Void visitNewClass(com.sun.source.tree.NewClassTree tree, Void ignored) {
                int line = lineOf(tree);
                if (line > 0) into.mutating.add(line);
                return super.visitNewClass(tree, ignored);
            }

            @Override
            public Void visitNewArray(com.sun.source.tree.NewArrayTree tree, Void ignored) {
                int line = lineOf(tree);
                if (line > 0) into.mutating.add(line);
                return super.visitNewArray(tree, ignored);
            }

            @Override
            public Void visitBreak(com.sun.source.tree.BreakTree tree, Void ignored) {
                int line = lineOf(tree);
                if (line > 0) into.jumps.put(line, "break");
                return super.visitBreak(tree, ignored);
            }

            @Override
            public Void visitContinue(com.sun.source.tree.ContinueTree tree, Void ignored) {
                int line = lineOf(tree);
                if (line > 0) into.jumps.put(line, "continue");
                return super.visitContinue(tree, ignored);
            }

            private void record(int branchLine, int startLine, int endLine, String kind, String expr,
                                int bodyLine) {
                if (branchLine <= 0) return;
                into.branches.put(branchLine, new Branch(kind, expr, bodyLine));
                into.loops.put(branchLine,
                        new Loop(Math.min(startLine, branchLine), Math.max(endLine, branchLine), bodyLine));
            }
        }
    }

    // ------------------------------------------------------------------ folding a long loop

    /**
     * Folding the middle of a long loop, in flight.
     *
     * The third implementation of this algorithm, after Python's and JavaScript's, and deliberately recognisable
     * against both. It is a pure transform over schema events — it never touches a JDI value — so the three can
     * be read side by side, and the conformance corpus holds all three to the same guarantees.
     *
     * Folding does *not* make Java faster, and it is worth being clear about why it is here anyway. The JVM has
     * already been stepped to produce the events a fold discards, so the time is spent either way. What folding
     * buys is a trace small enough for a browser to hold and a timeline short enough to scrub: a 20,000-iteration
     * loop is 200,000 events unfolded and a few hundred folded.
     *
     * Three properties, in order of how badly they hurt when broken:
     *
     * 1. **Nothing is lost.** Output, questions asked, exceptions and new objects are visible behaviour. A span
     *    containing anything this cannot represent is not folded at all — see {@link #FOLDABLE}.
     * 2. **State is exact.** Replaying a folded trace must leave exactly the state an unfolded one would, which
     *    is why each `collapse` carries the net before and after value of every slot the span touched.
     * 3. **It streams.** Waiting for the loop to end before emitting anything would defeat the purpose.
     */
    static final class Collapser {
        /**
         * Events a fold can represent, and therefore swallow.
         *
         * `var_set` and `obj_set` become effects; `metric` deltas are summed onto the collapse event. The rest
         * describe *how* the span got there, which is precisely what folding discards.
         *
         * Notably absent: `obj_new`, `stdout`, `stderr`, the `stdin_*` pair, the exception events and `note`.
         */
        static final java.util.Set<String> FOLDABLE = java.util.Set.of(
                "step_line", "branch", "jump", "loop_iter", "var_set", "var_del",
                "obj_set", "obj_resize", "metric", "frame_push", "frame_pop");

        static final int DEFAULT_KEEP = 3;
        static final int DEFAULT_CHUNK = 2000;
        /** Below this a fold costs more than it saves, and a reader would rather see the iterations. */
        static final int DEFAULT_MIN_ITERATIONS = 20;

        /** One event, before it has been given a number. */
        record Event(String kind, Map<String, Object> payload) {
        }

        private final int keepHead;
        private final int keepTail;
        private final int chunk;
        private final int minIterations;
        /** Reads the sequence number a fold would be stamped with. Supplied by the emitter, which owns it. */
        java.util.function.LongSupplier seq = () -> 0L;
        private final List<Region> stack = new ArrayList<>();

        Collapser(Integer keep, Integer chunkSize, Integer minimum) {
            this.keepHead = keep == null ? DEFAULT_KEEP : Math.max(0, keep);
            this.keepTail = keep == null ? DEFAULT_KEEP : Math.max(0, keep);
            this.chunk = chunkSize == null ? DEFAULT_CHUNK : Math.max(1, chunkSize);
            this.minIterations = minimum == null ? DEFAULT_MIN_ITERATIONS : Math.max(0, minimum);
        }

        /** The net effect of a run of iterations, accumulated as they go by. */
        private final class Fold {
            final long region;
            final long fromSeq;
            int iterations;
            Integer firstIter;
            Integer lastIter;
            // Keyed by the slot written to. Insertion-ordered, so effects appear in the order the span first
            // touched them and two traces of the same program stay comparable.
            final Map<String, Map<String, Object>> effects = new LinkedHashMap<>();
            final Map<String, Long> metrics = new LinkedHashMap<>();

            Fold(long region, long fromSeq) {
                this.region = region;
                this.fromSeq = fromSeq;
            }

            boolean isEmpty() {
                return iterations == 0;
            }

            void absorb(Event event) {
                Map<String, Object> payload = event.payload();
                switch (event.kind()) {
                    case "loop_iter" -> {
                        iterations++;
                        Object index = payload.get("i");
                        if (index instanceof Number number) {
                            if (firstIter == null) firstIter = number.intValue();
                            lastIter = number.intValue();
                        }
                    }
                    case "metric" -> {
                        String name = String.valueOf(payload.get("name"));
                        long delta = payload.get("delta") instanceof Number number ? number.longValue() : 1;
                        metrics.merge(name, delta, Long::sum);
                    }
                    case "var_set" -> write("var", payload.get("frame"), payload.get("name"), payload, false);
                    case "var_del" -> write("var", payload.get("frame"), payload.get("name"), payload, true);
                    case "obj_set" -> write("obj", payload.get("obj"), payload.get("key"), payload, false);
                    default -> {
                        // step_line, branch, jump, frame_push, frame_pop: how the span got here.
                    }
                }
            }

            private void write(String kind, Object owner, Object key, Map<String, Object> payload,
                               boolean deleted) {
                String slot = kind + "\u0000" + owner + "\u0000" + key;
                Map<String, Object> effect = effects.get(slot);
                if (effect == null) {
                    effect = new LinkedHashMap<>();
                    effect.put("kind", kind);
                    effect.put("key", String.valueOf(key));
                    if (kind.equals("var")) {
                        if (owner != null) effect.put("frame", owner);
                    } else {
                        effect.put("obj", owner);
                    }
                    // The first write's `prev` is where the span started. An absent `prev` means the slot did
                    // not exist, which is itself the correct `before`: the store reads a missing one as
                    // "remove this again" when stepping backwards.
                    if (payload.containsKey("prev")) effect.put("before", payload.get("prev"));
                    effects.put(slot, effect);
                }
                // The last write wins for `after`, which is the whole idea of a net effect.
                if (deleted) effect.remove("after");
                else effect.put("after", payload.get("value"));
            }

            Map<String, Object> toPayload(long toSeq) {
                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("region", region);
                payload.put("from_seq", fromSeq);
                payload.put("to_seq", toSeq);
                payload.put("iterations", iterations);
                payload.put("effects", new ArrayList<>(effects.values()));
                if (firstIter != null) payload.put("from_iter", firstIter);
                if (lastIter != null) payload.put("to_iter", lastIter);
                if (!metrics.isEmpty()) payload.put("metrics", new LinkedHashMap<>(metrics));
                return payload;
            }
        }

        /** One loop being watched. */
        private static final class Region {
            final long region;
            int seen;
            /** Completed iterations held back, oldest first. Each is the list of its events. */
            final List<List<Event>> tail = new ArrayList<>();
            /** The iteration being collected, if it is being held back. */
            List<Event> current;
            Object fold;
            /** Set once the span turns out to contain something a fold cannot represent. */
            boolean givingUp;
            /** Call depth inside the buffered iteration, so an unbalanced frame is never folded away. */
            int depth;

            Region(long region) {
                this.region = region;
            }
        }

        /** Return the events to emit in place of this one. */
        List<Event> feed(String kind, Map<String, Object> payload) {
            Map<String, Object> data = payload == null ? Map.of() : payload;

            if (kind.equals("loop_enter")) {
                List<Event> out = flushAll();
                stack.add(new Region(number(data.get("region"))));
                out.add(new Event(kind, data));
                return out;
            }

            if (kind.equals("loop_exit")) {
                List<Event> out = close(number(data.get("region")));
                out.add(new Event(kind, data));
                return out;
            }

            Region active = stack.isEmpty() ? null : stack.get(stack.size() - 1);
            if (active == null || active.givingUp) return list(new Event(kind, data));

            if (kind.equals("loop_iter") && number(data.get("region")) == active.region) {
                return beginIteration(active, data);
            }

            if (active.current == null) return list(new Event(kind, data));

            if (!FOLDABLE.contains(kind)) {
                // Output, a question, an exception, a new object: behaviour no summary can stand in for.
                return giveUp(active, new Event(kind, data));
            }

            if (kind.equals("frame_push")) {
                active.depth++;
            } else if (kind.equals("frame_pop")) {
                active.depth--;
                if (active.depth < 0) {
                    // A return out of the loop's own frame. Folding across it would erase a frame change.
                    return giveUp(active, new Event(kind, data));
                }
            }

            active.current.add(new Event(kind, data));
            return new ArrayList<>();
        }

        private List<Event> beginIteration(Region active, Map<String, Object> data) {
            List<Event> out = new ArrayList<>();

            if (active.current != null) {
                if (active.depth != 0) return giveUp(active, new Event("loop_iter", data));
                active.tail.add(active.current);
                active.current = null;
            }

            active.seen++;

            // The head runs verbatim, and so does everything until the loop proves it is long enough to be
            // worth folding at all.
            if (active.seen <= keepHead || active.seen <= minIterations) {
                out.addAll(drainTail(active));
                out.add(new Event("loop_iter", data));
                return out;
            }

            // Past the head: hold this iteration back, and fold the oldest held one once the tail window is
            // full. This is the only reason anything is buffered — an iteration cannot be known to be among the
            // last few until the loop ends.
            active.current = new ArrayList<>(list(new Event("loop_iter", data)));
            active.depth = 0;
            while (active.tail.size() > keepTail) {
                out.addAll(foldOldest(active));
            }
            return out;
        }

        private List<Event> foldOldest(Region active) {
            List<Event> oldest = active.tail.remove(0);
            Fold fold = (Fold) active.fold;
            if (fold == null) {
                fold = new Fold(active.region, seq.getAsLong());
                active.fold = fold;
            }
            for (Event event : oldest) fold.absorb(event);
            if (fold.iterations >= chunk) return emitFold(active);
            return new ArrayList<>();
        }

        private List<Event> emitFold(Region active) {
            Fold fold = (Fold) active.fold;
            active.fold = null;
            if (fold == null || fold.isEmpty()) return new ArrayList<>();
            return list(new Event("collapse", fold.toPayload(seq.getAsLong())));
        }

        /** Emit held iterations verbatim, after whatever has been folded so far. */
        private List<Event> drainTail(Region active) {
            List<Event> out = emitFold(active);
            for (List<Event> iteration : active.tail) out.addAll(iteration);
            active.tail.clear();
            return out;
        }

        private List<Event> close(long region) {
            List<Event> out = new ArrayList<>();
            while (!stack.isEmpty()) {
                Region active = stack.remove(stack.size() - 1);
                if (active.current != null) {
                    active.tail.add(active.current);
                    active.current = null;
                }
                out.addAll(drainTail(active));
                if (active.region == region) break;
            }
            return out;
        }

        /**
         * Abandon folding this loop, emitting everything held in the order it happened.
         *
         * Correctness first. A loop that prints, raises, asks a question or allocates is left alone rather than
         * summarised approximately — and anything already folded is still described, or its state changes vanish.
         */
        private List<Event> giveUp(Region active, Event event) {
            active.givingUp = true;
            List<Event> out = emitFold(active);
            for (List<Event> iteration : active.tail) out.addAll(iteration);
            active.tail.clear();
            if (active.current != null) {
                out.addAll(active.current);
                active.current = null;
            }
            out.add(event);
            return out;
        }

        private List<Event> flushAll() {
            List<Event> out = new ArrayList<>();
            for (Region active : stack) out.addAll(drainTail(active));
            return out;
        }

        /** Everything still held, for the end of a run that never closed its loops. */
        List<Event> drain() {
            List<Event> out = new ArrayList<>();
            while (!stack.isEmpty()) {
                Region active = stack.remove(stack.size() - 1);
                if (active.current != null) {
                    active.tail.add(active.current);
                    active.current = null;
                }
                out.addAll(drainTail(active));
            }
            return out;
        }

        private static long number(Object value) {
            return value instanceof Number typed ? typed.longValue() : -1;
        }

        private static List<Event> list(Event event) {
            List<Event> out = new ArrayList<>(1);
            out.add(event);
            return out;
        }
    }

    // ------------------------------------------------------------------ emission

    /** Sequence and step numbering, budgets, and writing the trace out. */
    static final class Emitter {
        static final class BudgetExceeded extends RuntimeException {
        }

        private static final List<String> STEPPABLE = List.of(
                "step_line", "branch", "jump", "frame_push", "frame_pop",
                "exception_raise", "exception_catch", "collapse");

        final String path;
        private final PrintWriter out;
        private final Options options;
        private final String source;
        private final long started = System.nanoTime();
        private final java.util.Set<String> notesSent = new java.util.HashSet<>();

        private long seq = 0;
        private long step = 0;
        /** Above this, a read is taken to have been answered by a person. Measured, not assumed. */
        private static final double WAIT_IS_A_PERSON_MS = 250;

        private long outputBytes = 0;
        private long idleMs = 0;
        /** Output printed without a newline, which is what a Java prompt looks like. */
        private String pendingPrompt = "";
        private boolean stopped = false;
        private boolean sealed = false;
        private String stopReason = null;

        /** Folds long loops, if asked for. The collapser stamps sequence numbers this object owns. */
        private Collapser collapser;

        Emitter(PrintWriter out, Options options, String path, String source) {
            this.out = out;
            this.options = options;
            this.path = path;
            this.source = source;
            if (options.collapse) {
                this.collapser = new Collapser(
                        options.collapseKeep, options.collapseChunk, options.collapseMin);
                this.collapser.seq = () -> seq;
            }
        }

        double elapsedMs() {
            return (System.nanoTime() - started) / 1e6 - idleMs;
        }

        void discountIdle(double ms) {
            idleMs += (long) ms;
        }

        /**
         * Offer one event to the trace.
         *
         * With a collapser attached, events pass through it first — *before* numbering, on purpose. A folded
         * event never receives a `seq` or a `step`, so both stay dense and a folded trace is indistinguishable
         * from one that was short to begin with. Numbering first and folding second would leave gaps, and every
         * reader that walks a trace by sequence would trip over them.
         */
        void emit(String kind, Map<String, Object> payload) {
            if (stopped) return;
            if (collapser == null) {
                write(kind, payload);
                return;
            }
            for (Collapser.Event folded : collapser.feed(kind, payload)) {
                write(folded.kind(), folded.payload());
            }
        }

        void write(String kind, Map<String, Object> payload) {
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("seq", seq++);
            event.put("t", kind);
            event.putAll(payload);
            event.put("ms", round(elapsedMs()));
            if (STEPPABLE.contains(kind)) event.put("step", step++);
            out.println(Json.write(event));
        }

        /** Emit anything the collapser is still holding. Called once, as the run ends. */
        void drainCollapser() {
            if (collapser == null) return;
            Collapser held = collapser;
            collapser = null;
            for (Collapser.Event event : held.drain()) write(event.kind(), event.payload());
        }

        void metric(String name, long delta) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("name", name);
            payload.put("delta", delta);
            emit("metric", payload);
        }

        void note(String level, String text) {
            if (!notesSent.add(text)) return;
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("level", level);
            payload.put("text", text);
            emit("note", payload);
        }

        /**
         * The program printed something.
         *
         * Carries the frame and line that produced it, so the output pane can say which step wrote which line
         * rather than showing an undifferentiated block of text.
         */
        void output(String stream, String text, Long frame, int line) {
            long remaining = options.outputBytes - outputBytes;
            if (remaining <= 0) {
                note("warn", "The program produced more output than the budget allows; the rest is dropped.");
                return;
            }
            String clipped = text.length() > remaining ? text.substring(0, (int) remaining) : text;
            outputBytes += clipped.length();
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("text", clipped);
            if (frame != null) payload.put("frame", frame);
            if (line > 0) payload.put("line", line);
            emit(stream, payload);

            // Text printed without a newline, immediately before a read, is a prompt — that is what a prompt is
            // in Java, where nothing passes one to `Scanner`. Tracked here so the question can be reported along
            // with the request rather than left as a stray line of output.
            if ("stdout".equals(stream)) {
                int newline = clipped.lastIndexOf('\n');
                pendingPrompt = newline >= 0 ? clipped.substring(newline + 1) : pendingPrompt + clipped;
            }
        }

        /** The program is waiting for input. */
        void askStart(Long frame, int line) {
            Map<String, Object> payload = new LinkedHashMap<>();
            if (frame != null) payload.put("frame", frame);
            if (line > 0) payload.put("line", line);
            if (!pendingPrompt.isEmpty()) payload.put("prompt", pendingPrompt);
            pendingPrompt = "";
            emit("stdin_request", payload);
        }

        /**
         * The answer, recorded so a replay needs nobody present.
         *
         * `source` is derived from how long the read actually blocked rather than assumed. Under the conformance
         * runner the answer is already in the pipe and comes back immediately; under the server a person was
         * typing. The same threshold as the other adapters, so the label means the same thing.
         */
        void askEnd(String text, double waitedMs) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("text", text);
            payload.put("source", waitedMs >= WAIT_IS_A_PERSON_MS ? "interactive" : "prefilled");
            payload.put("waited_ms", round(waitedMs));
            emit("stdin_response", payload);
            discountIdle(waitedMs);
        }

        void checkBudget() {
            if (stopped || sealed) return;
            if (step >= options.maxSteps) stop("step_limit");
            else if (elapsedMs() >= options.wallMs) stop("timeout");
        }

        void stop(String reason) {
            stopReason = reason;
            note("warn", reason.equals("timeout")
                    ? "Stopped after " + options.wallMs + "ms. The trace up to here is complete."
                    : "Stopped after " + options.maxSteps + " steps. The trace up to here is complete.");
            stopped = true;
            throw new BudgetExceeded();
        }

        String stopReason() {
            return stopReason == null ? "step_limit" : stopReason;
        }

        /** Re-open emission so a truncated run can still close its frames and say how it ended. */
        void seal() {
            stopped = false;
            sealed = true;
        }

        void finish(String status, int exitCode) {
            seal();
            // Anything still held belongs in the trace before the run is declared over.
            drainCollapser();
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("status", stopReason == null ? status : stopReason);
            payload.put("exit_code", exitCode);
            payload.put("steps", step);
            payload.put("duration_ms", round(elapsedMs()));
            emit("run_end", payload);
            out.flush();
        }

        void header() {
            Map<String, Object> file = new LinkedHashMap<>();
            file.put("path", path);
            file.put("sha256", sha256(source));
            file.put("line_count", source.split("\n", -1).length);

            Map<String, Object> limits = new LinkedHashMap<>();
            limits.put("max_steps", options.maxSteps);
            limits.put("wall_ms", options.wallMs);
            limits.put("memory_mb", options.memoryMb);
            limits.put("output_bytes", options.outputBytes);

            Map<String, Object> session = new LinkedHashMap<>();
            session.put("id", options.sessionId);
            session.put("language", "java");
            session.put("language_version", System.getProperty("java.version"));
            session.put("adapter_version", "0.1.0");
            session.put("profile", "full");
            session.put("source_files", List.of(file));
            session.put("entry", Map.of("path", path, "line", 1));
            session.put("limits", limits);
            session.put("started_at", Instant.now().toString());
            session.put("guards_active", guards());

            Map<String, Object> document = new LinkedHashMap<>();
            document.put("schema", "flow_view/trace@1");
            document.put("session", session);
            out.println(Json.write(document));
            out.flush();
        }

        /**
         * What is really protecting this run.
         *
         * The program runs in its own JVM with a heap ceiling, which is a real limit. Java has no equivalent of
         * node's permission model, so nothing here stops it opening a socket or writing a file — and saying so
         * is the only honest option. A guard that is advertised and not enforced is worse than none.
         */
        List<String> guards() {
            return List.of(
                    "runs in a separate JVM, killed when the run ends",
                    "heap capped at " + options.memoryMb + "MB",
                    "file writes NOT restricted: the JVM has no permission model for it",
                    "network NOT restricted: the JVM has no permission model for it");
        }

        static double round(double value) {
            return Math.round(value * 1000.0) / 1000.0;
        }

        static String sha256(String text) {
            try {
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                byte[] hashed = digest.digest(text.getBytes(StandardCharsets.UTF_8));
                StringBuilder hex = new StringBuilder(hashed.length * 2);
                for (byte b : hashed) hex.append(String.format("%02x", b));
                return hex.toString();
            } catch (Exception unreachable) {
                return "0".repeat(64);
            }
        }
    }

    // ------------------------------------------------------------------ JSON

    /**
     * Just enough JSON to write a trace.
     *
     * Hand-rolled because the adapter has no dependencies, and adding one for this would mean a build step and
     * a download — both of which the project has ruled out.
     */
    static final class Json {
        static String write(Object value) {
            StringBuilder out = new StringBuilder(256);
            append(out, value);
            return out.toString();
        }

        @SuppressWarnings("unchecked")
        private static void append(StringBuilder out, Object value) {
            if (value == null) {
                out.append("null");
            } else if (value instanceof String text) {
                string(out, text);
            } else if (value instanceof Boolean flag) {
                out.append(flag ? "true" : "false");
            } else if (value instanceof Double || value instanceof Float) {
                double number = ((Number) value).doubleValue();
                // Whole doubles are written without a fractional part so a value that is conceptually an
                // integer does not arrive as 5.0 and read as a different thing.
                if (number == Math.floor(number) && !Double.isInfinite(number)) {
                    out.append((long) number);
                } else {
                    out.append(number);
                }
            } else if (value instanceof Number number) {
                out.append(number);
            } else if (value instanceof Map<?, ?> map) {
                out.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!first) out.append(',');
                    first = false;
                    string(out, String.valueOf(entry.getKey()));
                    out.append(':');
                    append(out, entry.getValue());
                }
                out.append('}');
            } else if (value instanceof Iterable<?> items) {
                out.append('[');
                boolean first = true;
                for (Object item : items) {
                    if (!first) out.append(',');
                    first = false;
                    append(out, item);
                }
                out.append(']');
            } else {
                string(out, String.valueOf(value));
            }
        }

        private static void string(StringBuilder out, String text) {
            out.append('"');
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                switch (c) {
                    case '"' -> out.append("\\\"");
                    case '\\' -> out.append("\\\\");
                    case '\n' -> out.append("\\n");
                    case '\r' -> out.append("\\r");
                    case '\t' -> out.append("\\t");
                    case '\b' -> out.append("\\b");
                    case '\f' -> out.append("\\f");
                    default -> {
                        if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                        else out.append(c);
                    }
                }
            }
            out.append('"');
        }
    }
}
