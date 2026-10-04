#!/usr/bin/env bun

import { basename, resolve } from "node:path";
import { init, initProject, spawn, bind, describe, checkpoint, openSeat } from "./seats";
import { addParticipant, post, receipt, result, startThread, status } from "./threads";
import * as tasks from "./tasks";
import { required } from "./core";

const usage = `atdd-workflow — filesystem-first agent seats and tasks

Run commands from a workflow directory containing workflow.yaml.

Usage:
  atdd-workflow init <workflow-directory>
  atdd-workflow project init <project>
  atdd-workflow spawn <project> <role> <name> [--worktree <path>] [--branch <branch>]
  atdd-workflow bind <address> --pane <target> [--backend tmux|herdr|tuios]
  atdd-workflow describe <address> --purpose <one-line responsibility>
  atdd-workflow checkpoint <address> --summary <text> --next <text> [--status active|standby|blocked|complete|unverified]
  atdd-workflow task add <project> <task-id> --title <text> --coordinator <address> [--assignee <address>] --done-when <text> [--done-when <text> ...]
  atdd-workflow task start|review|done|return <project> <task-id> --by <address>
  atdd-workflow task prove <project> <task-id> --by <address> --item <number> --proof <reference>
  atdd-workflow task block <project> <task-id> --by <address> --reason <text>
  atdd-workflow task list <project> [--coordinator <address>] [--assignee <address>]
  atdd-workflow task open <project> <task-id>
  atdd-workflow thread start --with <address,...> --subject <text> [--task <project/task-id>]
  atdd-workflow thread add <thread-id> <address>
  atdd-workflow post <thread-id> --from <address> --to <all|address,...> --body <text> [--expects-result]
  atdd-workflow receipt <thread-id> <message-id> --from <address> [--body <text>]
  atdd-workflow result <thread-id> <message-id> --from <address> --body <text>
  atdd-workflow status
  atdd-workflow open <address>`;

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) return console.log(usage);
  const [command, ...rest] = args;
  const root = resolve(process.cwd());
  const commands: Record<string, () => Promise<void>> = {
    init: () => init(resolve(required(rest[0], "site directory")), basename(required(rest[0], "site directory"))),
    project: async () => {
      if (rest[0] === "init") return initProject(root, required(rest[1], "project"));
      throw new Error("Use `atdd-workflow project init <project>`.");
    },
    spawn: () => spawn(root, required(rest[0], "project"), required(rest[1], "role"), required(rest[2], "name"), rest.slice(3)),
    bind: () => bind(root, required(rest[0], "address"), rest.slice(1)),
    describe: () => describe(root, required(rest[0], "address"), rest.slice(1)),
    checkpoint: () => checkpoint(root, required(rest[0], "address"), rest.slice(1)),
    task: async () => {
      const [subcommand, projectName, taskId, ...tail] = rest;
      if (subcommand === "add") return tasks.add(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "start") return tasks.start(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "review") return tasks.review(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "done") return tasks.done(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "return") return tasks.returnToWork(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "prove") return tasks.prove(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "block") return tasks.block(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "list") return tasks.list(root, required(projectName, "project"), rest.slice(2));
      if (subcommand === "open") return tasks.open(root, required(projectName, "project"), required(taskId, "task id"));
      throw new Error("Use `atdd-workflow task add|start|prove|review|return|done|block|list|open`.");
    },
    thread: async () => {
      const [subcommand, ...tail] = rest;
      if (subcommand === "start") return startThread(root, tail);
      if (subcommand === "add") return addParticipant(root, required(tail[0], "thread id"), required(tail[1], "address"));
      throw new Error("Use `atdd-workflow thread start` or `atdd-workflow thread add`.");
    },
    post: () => post(root, required(rest[0], "thread id"), rest.slice(1)),
    receipt: () => receipt(root, required(rest[0], "thread id"), required(rest[1], "message id"), rest.slice(2)),
    result: () => result(root, required(rest[0], "thread id"), required(rest[1], "message id"), rest.slice(2)),
    status: () => status(root),
    open: () => openSeat(root, required(rest[0], "address")),
  };
  const action = commands[command];
  if (!action) throw new Error(`Unknown command: ${command}`);
  await action();
}

main().catch((error) => { console.error(`atdd-workflow: ${(error as Error).message}`); process.exit(1); });
