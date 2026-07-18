#!/usr/bin/python3
"""Line, branch and function coverage with no third-party dependency.

The JS suite has carried coverage thresholds all along; the Python suite — which
is the whole settings dialog, including a parser fed by user-typed text — had
none, and "99 % covered" in the README described half the shipped code. coverage
.py is the obvious tool and it is not installable everywhere (PEP 668 externally
managed environments), so this uses what the standard library already offers:
sys.monitoring (with a sys.settrace fallback) for what ran, and the compiled
code objects for what could have.

Run it the way the suite runs: python3 test/helpers/coverage.py
"""

from __future__ import annotations

import dis
import inspect
import sys
import types
import unittest
from pathlib import Path

APPLET_DIR = Path(__file__).resolve().parent.parent.parent
SOURCES = sorted((APPLET_DIR / "files" / "chronos@geraldo-netto").rglob("*.py"))

# The dialog is the user-facing half and is held to the JS suite's line gate.
# The 5.4 shim is three lines of sys.path plumbing and is measured with it — it
# lives in a subdirectory, and the glob here was non-recursive, so the one file
# Cinnamon's create_custom_widget actually loads was the one file the gate did
# not look at, while the comment above claimed it did.
LINE_THRESHOLD = 98.0
BRANCH_THRESHOLD = 90.0
FUNCTION_THRESHOLD = 100.0
# This module's remaining line slack used to consist solely of import fallbacks
# and no-style-context guards. Those paths are now behavioral tests, and a
# per-file override prevents the global 98 % allowance from hiding them again.
LINE_OVERRIDES = {Path("settings_widgets_common.py"): 100.0}


def code_key(code: types.CodeType) -> tuple[str, int]:
    """Stable identity shared by separately compiled and imported code."""
    return (getattr(code, "co_qualname", code.co_name), code.co_firstlineno)


def code_objects(path: Path) -> list[types.CodeType]:
    """Module code and every function, method and comprehension nested in it."""
    root = compile(path.read_text(encoding="utf8"), str(path), "exec")
    found = []
    pending = [root]

    while pending:
        current = pending.pop()
        found.append(current)
        pending.extend(
            constant for constant in current.co_consts
            if isinstance(constant, types.CodeType)
        )

    return found


def executable_lines(path: Path) -> set[int]:
    """Every line the interpreter could stop on, from the compiled code."""
    lines: set[int] = set()
    for current in code_objects(path):
        for _, line in dis.findlinestarts(current):
            if line is not None:
                lines.add(line)

    # 3.12 emits a line 0 for the module code object's implicit RESUME. It is not
    # a line anyone can execute or cover, and on an eight-line file it is an eighth
    # of the score.
    lines.discard(0)

    return lines


def is_conditional_jump(instruction: dis.Instruction) -> bool:
    """Whether bytecode can continue or jump based on runtime state."""
    if instruction.opcode not in set(dis.hasjabs + dis.hasjrel):
        return False
    # Count decisions, including short-circuit boolean expressions. Loop
    # mechanics (FOR_ITER/SEND) say whether an iterable is exhausted, not which
    # application decision was taken, and make one-line comprehensions dominate
    # the score with synthetic edges.
    return "IF_" in instruction.opname


def branch_edges(path: Path) -> set[tuple[tuple[str, int], int, int]]:
    """Both possible destinations of every conditional jump."""
    edges = set()
    for code in code_objects(path):
        # Modules and class bodies run while unittest discovers/imports the
        # suite, before measurement starts. Functions and methods are the code
        # the tests can exercise deliberately.
        if not code.co_flags & inspect.CO_NEWLOCALS:
            continue
        instructions = list(dis.get_instructions(code))
        edges.update(branch_edges_for_code(code, instructions))
    return edges


def branch_labels(path: Path) -> dict[tuple[tuple[str, int], int, int], str]:
    """Human-readable source anchors for branch edges."""
    labels = {}
    for code in code_objects(path):
        if not code.co_flags & inspect.CO_NEWLOCALS:
            continue
        instructions = list(dis.get_instructions(code))
        by_offset = instruction_line_map(instructions)
        key = code_key(code)
        for edge in branch_edges_for_code(code, instructions):
            _key, source, destination = edge
            source_line = by_offset[source]
            destination_line = by_offset[destination]
            labels[edge] = f"{key[0]}:{source_line}->{destination_line}"
    return labels


def instruction_line_map(instructions):
    """Source line at each bytecode offset, including Python before 3.11."""
    lines = {}
    current = None
    for instruction in instructions:
        positions = getattr(instruction, "positions", None)
        positioned = getattr(positions, "lineno", None)
        if positioned is not None:
            current = positioned
        elif instruction.starts_line is not None:
            current = instruction.starts_line
        lines[instruction.offset] = current
    return lines


def branch_edges_for_code(code, instructions):
    key = code_key(code)
    for index, instruction in enumerate(instructions[:-1]):
        if not is_conditional_jump(instruction):
            continue
        source_index = index
        while (source_index > 0
               and instructions[source_index - 1].opname == "EXTENDED_ARG"):
            source_index -= 1
        source = instructions[source_index].offset
        yield (key, source, int(instruction.argval))
        yield (key, source, instructions[index + 1].offset)


def function_keys(path: Path) -> set[tuple[str, int]]:
    """Functions and methods, excluding module/class bodies and comprehensions."""
    ignored = {"<listcomp>", "<dictcomp>", "<setcomp>", "<genexpr>"}
    return {
        code_key(code) for code in code_objects(path)
        if code.co_flags & inspect.CO_NEWLOCALS and code.co_name not in ignored
    }


def percent(covered: int, total: int) -> float:
    return 100.0 * covered / total if total else 100.0


class CoverageRecorder:
    """Collect line, branch and function events for the watched sources."""

    def __init__(self, watched, monitoring):
        self.monitoring = monitoring
        self.executed = {name: set() for name in watched}
        self.executed_edges = {name: set() for name in watched}
        self.executed_functions = {name: set() for name in watched}
        self.previous_offsets = {}

    def monitor_branch(self, code, source, destination):
        filename = code.co_filename
        if filename in self.executed_edges:
            self.executed_edges[filename].add(
                (code_key(code), source, destination))

    def monitor_start(self, code, _offset):
        filename = code.co_filename
        if filename in self.executed_functions:
            self.executed_functions[filename].add(code_key(code))

    def _trace_call(self, frame, filename):
        if self.monitoring is not None:
            return
        frame.f_trace_opcodes = True
        self.previous_offsets[id(frame)] = None
        self.executed_functions[filename].add(code_key(frame.f_code))

    def _trace_opcode(self, frame, filename):
        frame_id = id(frame)
        previous = self.previous_offsets.get(frame_id)
        if previous is not None:
            self.executed_edges[filename].add(
                (code_key(frame.f_code), previous, frame.f_lasti))
        self.previous_offsets[frame_id] = frame.f_lasti

    def trace(self, frame, event, _arg):
        filename = frame.f_code.co_filename
        if filename not in self.executed:
            return None
        if event == "call":
            self._trace_call(frame, filename)
        elif event == "line":
            self.executed[filename].add(frame.f_lineno)
        elif event == "opcode":
            self._trace_opcode(frame, filename)
        elif event == "return":
            self.previous_offsets.pop(id(frame), None)
        return self.trace


def start_monitoring(recorder):
    monitoring = recorder.monitoring
    if monitoring is None:
        return
    monitoring.use_tool_id(monitoring.COVERAGE_ID, "chronos coverage")
    monitoring.register_callback(
        monitoring.COVERAGE_ID, monitoring.events.BRANCH,
        recorder.monitor_branch)
    monitoring.register_callback(
        monitoring.COVERAGE_ID, monitoring.events.PY_START,
        recorder.monitor_start)
    monitoring.set_events(
        monitoring.COVERAGE_ID,
        monitoring.events.BRANCH | monitoring.events.PY_START)


def stop_monitoring(recorder):
    monitoring = recorder.monitoring
    if monitoring is None:
        return
    monitoring.set_events(monitoring.COVERAGE_ID, monitoring.events.NO_EVENTS)
    monitoring.register_callback(
        monitoring.COVERAGE_ID, monitoring.events.BRANCH, None)
    monitoring.register_callback(
        monitoring.COVERAGE_ID, monitoring.events.PY_START, None)
    monitoring.free_tool_id(monitoring.COVERAGE_ID)


def run_test_suite(recorder):
    loader = unittest.TestLoader()
    suite = loader.discover(str(APPLET_DIR / "test"), pattern="*.py")

    start_monitoring(recorder)
    sys.settrace(recorder.trace)
    try:
        return unittest.TextTestRunner(verbosity=1).run(suite)
    finally:
        sys.settrace(None)
        stop_monitoring(recorder)


def measure_file(name, path, recorder):
    can_run = executable_lines(path)
    can_branch = branch_edges(path)
    can_call = function_keys(path)
    # The import-time lines run before the tracer is installed; the module is
    # already imported by the test harness, so count only what a test can reach.
    did_run = recorder.executed[name] & can_run
    did_branch = recorder.executed_edges[name] & can_branch
    did_call = recorder.executed_functions[name] & can_call
    return {
        "path": path,
        "shown": path.relative_to(
            APPLET_DIR / "files" / "chronos@geraldo-netto"),
        "line_percent": percent(len(did_run), len(can_run)),
        "branch_percent": percent(len(did_branch), len(can_branch)),
        "function_percent": percent(len(did_call), len(can_call)),
        "missed": sorted(can_run - did_run),
        "missed_branches": can_branch - did_branch,
    }


def print_file_coverage(coverage):
    shown = coverage["shown"]
    print(f"{str(shown):32} lines {coverage['line_percent']:6.2f} %  "
          f"branches {coverage['branch_percent']:6.2f} %  "
          f"functions {coverage['function_percent']:6.2f} %")
    missed = coverage["missed"]
    if missed:
        print(f"{'':32} missed: {', '.join(str(line) for line in missed[:12])}"
              + (" …" if len(missed) > 12 else ""))
    missed_branches = coverage["missed_branches"]
    if missed_branches:
        labels = branch_labels(coverage["path"])
        shown_branches = sorted(labels[edge] for edge in missed_branches)
        print(f"{'':32} branches: {', '.join(shown_branches[:12])}"
              + (" …" if len(shown_branches) > 12 else ""))


def gate_failures(coverage):
    metrics = (
        ("lines", coverage["line_percent"],
         LINE_OVERRIDES.get(coverage["shown"], LINE_THRESHOLD)),
        ("branches", coverage["branch_percent"], BRANCH_THRESHOLD),
        ("functions", coverage["function_percent"], FUNCTION_THRESHOLD),
    )
    return [
        f"{coverage['shown']}: {actual:.2f} % {label} is under the {threshold} % gate"
        for label, actual, threshold in metrics
        if actual + 1e-9 < threshold
    ]


def report_coverage(watched, recorder):
    failures = []
    for name, path in watched.items():
        coverage = measure_file(name, path, recorder)
        print_file_coverage(coverage)
        failures.extend(gate_failures(coverage))

    if failures:
        print("\npython coverage below the gate:\n")
        for failure in failures:
            print("  " + failure)
        return 1

    print("\npython coverage: every file meets "
          f"{LINE_THRESHOLD} % lines / {BRANCH_THRESHOLD} % branches / "
          f"{FUNCTION_THRESHOLD} % functions")
    return 0


def main() -> int:
    watched = {str(path): path for path in SOURCES}
    recorder = CoverageRecorder(watched, getattr(sys, "monitoring", None))
    result = run_test_suite(recorder)
    if not result.wasSuccessful():
        return 1
    print()
    return report_coverage(watched, recorder)


if __name__ == "__main__":
    sys.exit(main())
