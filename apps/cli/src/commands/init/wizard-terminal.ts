import { emitKeypressEvents, type Key } from "node:readline";

import { OperationalError } from "../../cli/exit.js";

export interface WizardChoice<T extends string> {
  value: T;
  label: string;
  detail?: string;
}

export interface WizardTerminal {
  readonly interactive: boolean;
  choose<T extends string>(question: string, choices: readonly WizardChoice<T>[]): Promise<T>;
  input(question: string, initial?: string): Promise<string>;
  message(text: string): void;
}

export interface WizardInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  isPaused(): boolean;
  resume(): unknown;
  pause(): unknown;
  on(event: "keypress", listener: (text: string | undefined, key: Key) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  removeListener(
    event: "keypress",
    listener: (text: string | undefined, key: Key) => void,
  ): unknown;
  removeListener(event: "end" | "close", listener: () => void): unknown;
}

/** Project strings never get to send control sequences to the terminal. */
export function terminalText(text: string): string {
  return text.replace(/\p{Cc}/gu, " ");
}

function cancelled(): Error {
  return new DOMException("Setup cancelled before the next action.", "AbortError");
}

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const wideCell =
  /\p{Extended_Pictographic}|[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;

/** Keep grapheme clusters intact and account for ordinary double-width terminal cells. */
export function wrapTerminalFrame(frame: string, columns: number): string {
  return frame
    .split("\n")
    .map((line) => {
      const rows: string[] = [];
      let current = "",
        width = 0;
      for (const { segment } of graphemes.segment(line)) {
        const cells = /^\p{Mark}+$/u.test(segment) ? 0 : wideCell.test(segment) ? 2 : 1;
        if (width + cells > columns && current) {
          rows.push(current);
          current = "";
          width = 0;
        }
        current += segment;
        width += cells;
      }
      rows.push(current);
      return rows.join("\n");
    })
    .join("\n");
}

/** Each prompt owns its listeners/raw mode only until a choice is made. */
export function createWizardTerminal(options: {
  input?: WizardInput;
  write: (text: string) => void;
  signal: AbortSignal;
  columns?: number;
}): WizardTerminal {
  const input: WizardInput = options.input ?? process.stdin;
  const write = options.write;
  if (input === process.stdin) emitKeypressEvents(process.stdin);

  async function prompt<T>(
    render: () => string,
    handle: (text: string | undefined, key: Key) => { value: T } | undefined,
  ): Promise<T> {
    options.signal.throwIfAborted();
    const wasRaw = input.isRaw === true;
    const wasPaused = input.isPaused();
    let rows = 0;
    const redraw = (): void => {
      if (rows > 0) write(`\x1b[${String(rows)}A\r\x1b[J`);
      const available = options.columns ?? process.stderr.columns;
      const columns = Math.max(8, available !== undefined && available > 0 ? available : 80) - 1;
      const display = wrapTerminalFrame(render(), columns);
      rows = display.split("\n").length - 1;
      write(display);
    };
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const cleanup = (): void => {
        input.removeListener("keypress", onKey);
        input.removeListener("end", onEnd);
        input.removeListener("close", onEnd);
        options.signal.removeEventListener("abort", onAbort);
        try {
          input.setRawMode(wasRaw);
        } finally {
          if (wasPaused) input.pause();
        }
      };
      const finish = (result: { value: T } | { error: unknown }): void => {
        if (finished) return;
        finished = true;
        try {
          cleanup();
        } catch (error) {
          reject(
            new OperationalError(
              "Could not restore the terminal after setup.",
              "Run `stty sane` in this terminal.",
              { cause: error },
            ),
          );
          return;
        }
        if ("error" in result) reject(result.error);
        else resolve(result.value);
      };
      const onEnd = (): void => finish({ error: cancelled() });
      const onAbort = (): void => finish({ error: options.signal.reason ?? cancelled() });
      const onKey = (text: string | undefined, key: Key): void => {
        if (key.name === "escape" || (key.ctrl && (key.name === "c" || key.name === "d"))) {
          finish({ error: cancelled() });
          return;
        }
        try {
          const result = handle(text, key);
          if (result !== undefined) finish(result);
          else redraw();
        } catch (error) {
          finish({ error });
        }
      };
      try {
        input.on("keypress", onKey);
        input.on("end", onEnd);
        input.on("close", onEnd);
        options.signal.addEventListener("abort", onAbort, { once: true });
        input.setRawMode(true);
        input.resume();
        if (options.signal.aborted) onAbort();
        else redraw();
      } catch (error) {
        finish({ error });
      }
    });
  }

  return {
    interactive: input.isTTY === true,
    message(text) {
      write(`${text.split("\n").map(terminalText).join("\n")}\n`);
    },
    choose<T extends string>(question: string, choices: readonly WizardChoice<T>[]): Promise<T> {
      if (choices.length === 0) throw new Error("A setup choice requires at least one option.");
      let selected = 0;
      return prompt(
        () =>
          `\n${terminalText(question)}\n` +
          choices
            .map(
              (choice, i) =>
                `${i === selected ? ">" : " "} ${terminalText(choice.label)}\n` +
                (i === selected && choice.detail ? `  ${terminalText(choice.detail)}\n` : ""),
            )
            .join("") +
          "Up/Down or j/k, Enter to select, Esc to cancel.\n",
        (_text, key) => {
          if (key.name === "return" || key.name === "enter") {
            return { value: choices[selected]!.value };
          }
          if (key.name === "up" || key.name === "k")
            selected = (selected + choices.length - 1) % choices.length;
          if (key.name === "down" || key.name === "j") selected = (selected + 1) % choices.length;
          return undefined;
        },
      );
    },
    input(question, initial = ""): Promise<string> {
      let value = terminalText(initial);
      return prompt(
        () =>
          `\n${terminalText(question)}\n> ${value}\nEnter to accept, Ctrl-U to clear, Esc to cancel.\n`,
        (text, key) => {
          if (key.name === "return" || key.name === "enter") return { value: value.trim() };
          if (key.ctrl && key.name === "u") value = "";
          else if (key.name === "backspace") value = Array.from(value).slice(0, -1).join("");
          else if (!key.ctrl && !key.meta && text !== undefined && !/\p{Cc}/u.test(text)) {
            if (value.length + text.length <= 4096) value += text;
          }
          return undefined;
        },
      );
    },
  };
}
