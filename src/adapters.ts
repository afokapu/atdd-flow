import { run } from "./core";

type Environment = Record<string, string | undefined>;

const value = (environment: Environment, name: string, application: string) => {
  const current = environment[name];
  if (!current) throw new Error(`Cannot discover ${application} here: ${name} is not set.`);
  return current;
};

/**
 * Native host location discovery. These values come from the host process,
 * rather than from an agent, title, label, or whichever pane happens to have
 * focus in the UI.
 */
export function discoverAddress(application: string, environment: Environment = process.env): string {
  const discoverers: Record<string, () => string> = {
    herdr: () => value(environment, "HERDR_PANE_ID", "Herdr"),
    tmux: () => value(environment, "TMUX_PANE", "tmux"),
    tuios: () => `${value(environment, "TUIOS_SESSION", "TUIOS")}/${value(environment, "TUIOS_WINDOW_ID", "TUIOS")}`,
  };
  const discover = discoverers[application];
  if (!discover) throw new Error(`No deterministic discovery adapter is installed for ${application}.`);
  return discover();
}

export function notificationCommand(application: string, address: string, notice: string, herdrSession?: string): string[] | undefined {
  const commands: Record<string, () => string[] | undefined> = {
    tmux: () => ["tmux", "send-keys", "-t", address, notice, "Enter"],
    // Herdr resolves the live agent from its stable pane address and submits
    // an ordered prompt through its agent-control API. Do not fall back to
    // pane text injection: a Desk message remains durable when an older host
    // cannot provide agent.prompt.
    herdr: () => ["herdr", ...(herdrSession ? ["--session", herdrSession] : []), "agent", "prompt", address, notice],
    tuios: () => {
      const separator = address.indexOf("/");
      if (separator < 1 || separator === address.length - 1) return undefined;
      return ["tuios", "queue", "-s", address.slice(0, separator), "-w", address.slice(separator + 1), notice];
    },
  };
  return commands[application]?.();
}

export type LaunchRequest = {
  application: string;
  placement: string;
  name: string;
  worktree: string;
  agent: string;
  args?: string[];
  environment?: Record<string, string>;
  root: string;
  seat: string;
};

/** A launch placement names a host container, never the currently visible UI. */
export function launchCommand(request: LaunchRequest): string[] {
  const environment = [
    "/usr/bin/env",
    `ATDD_WORKFLOW_ROOT=${request.root}`,
    `ATDD_WORKFLOW_SEAT=${request.seat}`,
    ...Object.entries(request.environment ?? {}).map(([key, value]) => `${key}=${value}`),
    request.agent,
    ...(request.args ?? []),
  ];
  if (request.application === "tuios") {
    return [
      "tuios", "new-window", request.name,
      "-s", request.placement,
      "--cwd", request.worktree,
      "--no-focus", "--print-id", "--",
      ...environment,
    ];
  }
  throw new Error(`No deterministic launch adapter is installed for ${request.application}.`);
}

export function launchedAddress(application: string, placement: string, output: string) {
  if (application !== "tuios") throw new Error(`No deterministic launch adapter is installed for ${application}.`);
  const window = output.split(/\s+/)[0];
  if (!window) throw new Error("TUIOS created a window without returning its id.");
  return `${placement}/${window}`;
}

export async function notify(application: string, address: string, notice: string, herdrSession?: string) {
  const command = notificationCommand(application, address, notice, herdrSession);
  if (!command) return;
  await run(command, true);
}
