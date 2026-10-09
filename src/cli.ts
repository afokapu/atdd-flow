#!/usr/bin/env bun

import { basename, resolve } from "node:path";
import { init, initProject, spawn, bind, useApplication, attach, describe, checkpoint, migrate, openSeat, piExtensionPath } from "./seats";
import { addParticipant, openThread, post, readMessage, receipt, result, startThread } from "./threads";
import * as tasks from "./tasks";
import { required, values, words } from "./core";
import { addressBook } from "./address-book";
import * as judgment from "./judgment";
import * as reviews from "./reviews";
import { status } from "./overview";
import { multiplexer } from "./multiplexer";

const usage = `atdd-flow — filesystem-first agent seats and tasks

Run commands from a Desk containing desk.yaml.
Legacy coordination.yaml registries are read safely and can be migrated.

Usage:
  atdd-flow init <desk-directory> [--git]
  atdd-flow desk migrate
  atdd-flow project init <project>
  atdd-flow spawn <project> <role> <name> [--worktree <path>] [--branch <branch>] [--agent <legacy-executable>]
  atdd-flow bind <address> [--application <application>] --address <native-address> [--session <name>] [--agent <executable>] [--worktree <path>] [--wake host|native]
  atdd-flow attach <address> [--application <application>] [--wake host|native]
  atdd-flow pi extension-path
  atdd-flow application use <address> <application>
  atdd-flow multiplexer status|apply herdr [--session <name>]
  atdd-flow describe <address> --purpose <one-line responsibility>
  atdd-flow checkpoint <address> --summary <text> --next <text> [--status active|standby|blocked|complete|unverified]
  atdd-flow task add <project> <task-id> --title <text> --coordinator <address> [--assignee <address>] [--body <text>] [--source <reference>] [--depends-on <task-id,...>] --done-when <text> [--done-when <text> ...]
  atdd-flow task assign <project> <task-id> --assignee <address> --by <coordinator-address>
  atdd-flow task amend <project> <task-id> [--title <text>] [--body <text>] [--source <reference>] [--depends-on <task-id,...>]
  atdd-flow task import <project> <task-id> --proof <reference> [--proof <reference> ...] [--done-when <text> ...] [--source <reference>]
  atdd-flow task start|review|return <project> <task-id> --by <address>
  atdd-flow task done <project> <task-id> --by <address> [--retire-assignee]
  atdd-flow task prove <project> <task-id> --by <address> --item <number> --proof <reference>
  atdd-flow task block <project> <task-id> --by <address> --reason <text>
  atdd-flow task unblock <project> <task-id> --by <coordinator-address>
  atdd-flow task list <project> [--coordinator <address>] [--assignee <address>]
  atdd-flow task open <project> <task-id>
  atdd-flow thread start --with <address,...> --subject <text> [--task <project/task-id>]
  atdd-flow thread add <thread-id> <address>
  atdd-flow thread open <thread-id>
  atdd-flow message read <message-id>
  atdd-flow post <thread-id> --from <address> --to <all|address,...> --body <text> [--expects-result]
  atdd-flow receipt <thread-id> <message-id> --from <address> [--body <text>]
  atdd-flow result <thread-id> <message-id> --from <address> --body <text>
  atdd-flow status [project <project>|task <project> <task-id>|seat <address>|thread <thread-id>] [--all]
  atdd-flow scout --goal <text> --path <file> [--path <file> ...] [--question <text>]
  atdd-flow focus-check <project> <task-id> --action <proposed action>
  atdd-flow behavioral-review launch <project> <task-id> --by <coordinator> --application <application> --placement <native-container-address> [--gate <reference> ...]
  atdd-flow behavioral-review record <project> <task-id> --by <reviewer-address> --file <result-yaml>
  atdd-flow behavioral-review open <project> <task-id>
  atdd-flow open <address>
  atdd-flow address-book

Global:
  atdd-flow --root <desk-directory> <command>
  ATDD_WORKFLOW_ROOT=<desk-directory> atdd-flow <command>`;

async function main() {
  const original = process.argv.slice(2);
  if (!original.length || original.includes("--help") || original.includes("-h")) return console.log(usage);
  const rootIndex = original.indexOf("--root");
  const rootOverride = rootIndex < 0 ? process.env.ATDD_WORKFLOW_ROOT : required(original[rootIndex + 1], "--root");
  const args = rootIndex < 0 ? original : original.filter((_, index) => index !== rootIndex && index !== rootIndex + 1);
  const [command, ...rest] = args;
  const root = resolve(rootOverride ?? process.cwd());
  const commands: Record<string, () => Promise<void>> = {
    init: () => init(resolve(required(rest[0], "desk directory")), basename(required(rest[0], "desk directory")), rest.slice(1)),
    desk: async () => {
      if (rest[0] === "migrate") return migrate(root);
      throw new Error("Use `atdd-flow desk migrate`.");
    },
    project: async () => {
      if (rest[0] === "init") return initProject(root, required(rest[1], "project"));
      throw new Error("Use `atdd-flow project init <project>`.");
    },
    spawn: () => spawn(root, required(rest[0], "project"), required(rest[1], "role"), required(rest[2], "name"), rest.slice(3)),
    bind: () => bind(root, required(rest[0], "address"), rest.slice(1)),
    attach: () => attach(root, required(rest[0], "address"), rest.slice(1)),
    pi: async () => {
      if (rest[0] === "extension-path") return console.log(piExtensionPath());
      throw new Error("Use `atdd-flow pi extension-path`.");
    },
    application: async () => {
      if (rest[0] === "use") return useApplication(root, required(rest[1], "address"), required(rest[2], "application"));
      throw new Error("Use `atdd-flow application use <address> <application>`.");
    },
    multiplexer: () => multiplexer(root, rest),
    describe: () => describe(root, required(rest[0], "address"), rest.slice(1)),
    checkpoint: () => checkpoint(root, required(rest[0], "address"), rest.slice(1)),
    task: async () => {
      const [subcommand, projectName, taskId, ...tail] = rest;
      if (subcommand === "add") return tasks.add(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "assign") return tasks.assign(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "amend") return tasks.amend(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "import") return tasks.importCompleted(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "start") return tasks.start(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "review") return tasks.review(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "done") return tasks.done(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "return") return tasks.returnToWork(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "prove") return tasks.prove(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "block") return tasks.block(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "unblock") return tasks.unblock(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "list") return tasks.list(root, required(projectName, "project"), rest.slice(2));
      if (subcommand === "open") return tasks.open(root, required(projectName, "project"), required(taskId, "task id"));
      throw new Error("Use `atdd-flow task add|assign|amend|import|start|prove|review|return|done|block|unblock|list|open`.");
    },
    thread: async () => {
      const [subcommand, ...tail] = rest;
      if (subcommand === "start") return startThread(root, tail);
      if (subcommand === "add") return addParticipant(root, required(tail[0], "thread id"), required(tail[1], "address"));
      if (subcommand === "open") return openThread(root, required(tail[0], "thread id"));
      throw new Error("Use `atdd-flow thread start|add|open`.");
    },
    message: async () => {
      if (rest[0] === "read") return readMessage(root, required(rest[1], "message id"));
      throw new Error("Use `atdd-flow message read <message-id>`.");
    },
    post: () => post(root, required(rest[0], "thread id"), rest.slice(1)),
    receipt: () => receipt(root, required(rest[0], "thread id"), required(rest[1], "message id"), rest.slice(2)),
    result: () => result(root, required(rest[0], "thread id"), required(rest[1], "message id"), rest.slice(2)),
    status: () => status(root, rest),
    scout: async () => console.log(JSON.stringify(await judgment.scout({
      goal: required(words(rest, "--goal"), "--goal"),
      candidates: values(rest, "--path"),
      ...(words(rest, "--question") ? { question: words(rest, "--question") } : {}),
    }), null, 2)),
    "focus-check": async () => console.log(JSON.stringify(await judgment.focusTask(
      root,
      required(rest[0], "project"),
      required(rest[1], "task id"),
      required(words(rest.slice(2), "--action"), "--action"),
    ), null, 2)),
    "behavioral-review": async () => {
      const [subcommand, projectName, taskId, ...tail] = rest;
      if (subcommand === "launch") return reviews.launchBehavioralReview(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "record") return reviews.recordBehavioralReview(root, required(projectName, "project"), required(taskId, "task id"), tail);
      if (subcommand === "open") return reviews.openBehavioralReview(root, required(projectName, "project"), required(taskId, "task id"));
      throw new Error("Use `atdd-flow behavioral-review launch|record|open <project> <task-id>`.");
    },
    open: () => openSeat(root, required(rest[0], "address")),
    "address-book": () => addressBook(root),
  };
  const action = commands[command];
  if (!action) throw new Error(`Unknown command: ${command}`);
  await action();
}

main().catch((error) => { console.error(`atdd-flow: ${(error as Error).message}`); process.exit(1); });
