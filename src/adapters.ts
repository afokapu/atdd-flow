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
  };
  const discover = discoverers[application];
  if (!discover) throw new Error(`No deterministic discovery adapter is installed for ${application}.`);
  return discover();
}

/** Herdr pane ids are only unique inside a session, so new bindings record both. */
export function discoverHerdrLocator(environment: Environment = process.env) {
  return { session: value(environment, "HERDR_SESSION", "Herdr"), pane: value(environment, "HERDR_PANE_ID", "Herdr") };
}

export function notificationCommand(application: string, address: string, notice: string, herdrSession?: string): string[] | undefined {
  const commands: Record<string, () => string[] | undefined> = {
    tmux: () => ["tmux", "send-keys", "-t", address, notice, "Enter"],
    // Herdr resolves the live agent from its stable pane address and submits
    // an ordered prompt through its agent-control API. Do not fall back to
    // pane text injection: a Desk message remains durable when an older host
    // cannot provide agent.prompt.
    herdr: () => ["herdr", ...(herdrSession ? ["--session", herdrSession] : []), "agent", "prompt", address, notice],
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

/** Flow no longer owns host-pane creation; attach a host-created pane instead. */
export function launchCommand(_request: LaunchRequest): string[] {
  throw new Error("No deterministic launch adapter is installed.");
}

export function launchedAddress(_application: string, _placement: string, _output: string): string {
  throw new Error("No deterministic launch adapter is installed.");
}

export async function notify(application: string, address: string, notice: string, herdrSession?: string) {
  const command = notificationCommand(application, address, notice, herdrSession);
  if (!command) return;
  await run(command, true);
}
