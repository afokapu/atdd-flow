import { readdir } from "node:fs/promises";
import { paths, readYaml, type Seat } from "./core";

function identity(address: string) {
  return address === "operator@desk" ? "human" : "agent";
}

function authority(record: Seat) {
  if (record.address === "operator@desk") return "Human authority; no autonomous agent may post as this address.";
  if (record.role === "main") return "Repository-main integration gateway; may escalate to operator@desk.";
  if (record.role === "coordinator") return "Coordinates assigned work; may escalate a decision or incident to operator@desk.";
  if (record.role === "driver") return "Delivers assigned work; routes normal communication through its coordinator.";
  return "See the seat purpose and current assignment.";
}

export async function addressBook(root: string) {
  const projects = (await readdir(paths(root).work)).sort();
  const records: Seat[] = [];
  for (const project of projects) {
    const folder = paths(root).seats(project);
    let locals: string[];
    try { locals = await readdir(folder); }
    catch { continue; }
    for (const local of locals.sort()) {
      try { records.push(await readYaml<Seat>(`${folder}/${local}/seat.yaml`)); }
      catch { /* A partially removed legacy seat is not an address-book entry. */ }
    }
  }
  console.log("# Desk address book\n");
  console.log("`operator@desk` is the human authority. Drivers route normal work through coordinators; main seats are the normal technical gateway to the operator.\n");
  console.log("| Address | Identity | Purpose / authority |\n| --- | --- | --- |");
  for (const record of records.sort((left, right) => left.address.localeCompare(right.address))) {
    const purpose = (record.purpose ?? authority(record)).replaceAll("|", "\\|");
    console.log(`| ${record.address} | ${identity(record.address)} | ${purpose} |`);
  }
}
