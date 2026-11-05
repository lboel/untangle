import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  createWizardTerminal,
  terminalText,
  wrapTerminalFrame,
  type WizardInput,
} from "./wizard-terminal.js";

class Input extends EventEmitter implements WizardInput {
  isTTY = true;
  isRaw = false;
  paused = true;
  modes: boolean[] = [];
  failRestore = false;
  setRawMode(mode: boolean): this {
    this.modes.push(mode);
    if (!mode && this.failRestore) throw new Error("disconnected tty");
    this.isRaw = mode;
    return this;
  }
  isPaused(): boolean {
    return this.paused;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
}

const choices = [
  { value: "first", label: "First option" },
  { value: "second", label: "Second option" },
] as const;
function fixture() {
  const input = new Input(),
    abort = new AbortController(),
    frames: string[] = [];
  const terminal = createWizardTerminal({
    input,
    signal: abort.signal,
    write: (text) => frames.push(text),
    columns: 30,
  });
  return { input, abort, frames, terminal };
}
function clean(input: Input) {
  expect(input.listenerCount("keypress")).toBe(0);
  expect(input.listenerCount("end")).toBe(0);
  expect(input.listenerCount("close")).toBe(0);
  expect(input.paused).toBe(true);
}

describe("guided setup terminal lifecycle", () => {
  it("wraps full-width paths and combined glyphs without splitting grapheme clusters", () => {
    expect(wrapTerminalFrame("前端/账户", 5)).toBe("前端/\n账户");
    expect(wrapTerminalFrame("a\u0308bcd", 3)).toBe("a\u0308bc\nd");
    expect(wrapTerminalFrame("ab👩‍💻cd", 4)).toBe("ab👩‍💻\ncd");
  });
  it("supports arrow navigation and restores raw/paused state before returning a choice", async () => {
    const { input, terminal } = fixture();
    const result = terminal.choose("Select", choices);
    expect(input.isRaw).toBe(true);
    input.emit("keypress", "\u001b[B", { name: "down" });
    input.emit("keypress", "\r", { name: "return" });
    await expect(result).resolves.toBe("second");
    expect(input.isRaw).toBe(false);
    clean(input);
    expect(input.modes).toEqual([true, false]);
  });
  it("preserves a previously raw and running terminal instead of changing its owner's state", async () => {
    const { input, terminal } = fixture();
    input.isRaw = true;
    input.paused = false;
    const result = terminal.choose("Select", choices);
    input.emit("keypress", "\r", { name: "return" });
    await expect(result).resolves.toBe("first");
    expect(input.isRaw).toBe(true);
    expect(input.paused).toBe(false);
    expect(input.listenerCount("keypress")).toBe(0);
  });
  it.each(["escape", "ctrl-c", "ctrl-d", "end", "close", "signal"])(
    "cancels %s without leaking input listeners or raw mode",
    async (method) => {
      const { input, abort, terminal } = fixture();
      const result = terminal.choose("Select", choices);
      if (method === "signal") abort.abort();
      else if (method === "end" || method === "close") input.emit(method);
      else
        input.emit("keypress", undefined, {
          name: method === "escape" ? "escape" : method.slice(-1),
          ctrl: method !== "escape",
        });
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(input.isRaw).toBe(false);
      clean(input);
    },
  );
  it("does not attach listeners or alter an already-aborted terminal", async () => {
    const { input, abort, terminal } = fixture();
    abort.abort();
    await expect(terminal.choose("Select", choices)).rejects.toMatchObject({ name: "AbortError" });
    expect(input.modes).toEqual([]);
    clean(input);
  });
  it("settles with a recovery error even if raw-mode restoration itself fails", async () => {
    const { input, terminal } = fixture();
    const result = terminal.choose("Select", choices);
    input.failRestore = true;
    input.emit("keypress", "\r", { name: "return" });
    await expect(result).rejects.toMatchObject({
      exitCode: 1,
      nextStep: "Run `stty sane` in this terminal.",
    });
    clean(input);
  });
  it("cleans up when output fails while drawing the first prompt", async () => {
    const input = new Input();
    const terminal = createWizardTerminal({
      input,
      signal: new AbortController().signal,
      write() {
        throw new Error("closed output");
      },
    });
    await expect(terminal.choose("Select", choices)).rejects.toThrow("closed output");
    expect(input.isRaw).toBe(false);
    clean(input);
  });
  it("bounds each frame line to the terminal width before counting redraw rows", async () => {
    const { input, terminal, frames } = fixture();
    const result = terminal.choose("A question that wraps across a narrow terminal viewport", [
      { value: "yes", label: "A very long descriptive option that must wrap too" },
    ]);
    expect(frames[0]!.split("\n").every((line) => line.length <= 29)).toBe(true);
    input.emit("keypress", "\r", { name: "return" });
    await result;
    clean(input);
  });
  it("edits Unicode text, supports clearing defaults and never accepts terminal control sequences", async () => {
    const { input, terminal } = fixture();
    const result = terminal.input("Feature manifest", "old.json");
    input.emit("keypress", "\u0015", { name: "u", ctrl: true });
    input.emit("keypress", "größen.json", {});
    input.emit("keypress", "\u001b[31m", { name: "unknown" });
    input.emit("keypress", "x", {});
    input.emit("keypress", "\b", { name: "backspace" });
    input.emit("keypress", "\r", { name: "return" });
    await expect(result).resolves.toBe("größen.json");
    clean(input);
  });
  it("strips controls from project-derived text while preserving normal Unicode", () => {
    expect(terminalText("src/Größen.ts\u001b[31m\n")).toBe("src/Größen.ts [31m ");
  });
});
