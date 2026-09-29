import { red, yellow } from "@std/fmt/colors";
import inquirer from "inquirer";

/** Everything that asks the user something. Injectable so tests can script answers. */
export interface Prompter {
  select<T extends string>(
    message: string,
    choices: { name: string; value: T }[],
    defaultValue?: T,
  ): Promise<T>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  input(message: string): Promise<string>;
  /** Shows long text through `$PAGER` (falling back to `less -R`). */
  pager(text: string): Promise<void>;
}

export interface Output {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleOutput: Output = {
  log: (message) => console.log(message),
  warn: (message) => console.log(yellow(message)),
  error: (message) => console.error(red(message)),
};

export const inquirerPrompter: Prompter = {
  async select(message, choices, defaultValue) {
    const { answer } = await inquirer.prompt([
      { name: "answer", type: "list", message, choices, default: defaultValue },
    ]);
    return answer;
  },
  async confirm(message, defaultValue = false) {
    const { answer } = await inquirer.prompt([
      { name: "answer", type: "confirm", message, default: defaultValue },
    ]);
    return answer;
  },
  async input(message) {
    const { answer } = await inquirer.prompt([
      { name: "answer", type: "input", message },
    ]);
    return answer;
  },
  pager: showInPager,
};

export async function showInPager(text: string) {
  const [cmd, ...args] = (Deno.env.get("PAGER") || "less -R").split(/\s+/);
  try {
    const child = new Deno.Command(cmd, {
      args,
      stdin: "piped",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(text + "\n"));
    await writer.close();
    await child.status;
  } catch (_) {
    console.log(text);
  }
}
