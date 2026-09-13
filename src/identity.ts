import { sha256Hex } from "./crypto";

export async function cardIdFor(agentId: string, externalTaskId: string): Promise<string> {
  return `task:${(await sha256Hex(`${agentId}\0${externalTaskId}`)).slice(0, 48)}`;
}

export async function providerMessageIdFor(agentId: string, eventId: string): Promise<string> {
  return `evt:${(await sha256Hex(`${agentId}\0${eventId}`)).slice(0, 48)}`;
}

export async function revisionMessageIdFor(taskId: string, revision: number): Promise<string> {
  return `rev:${(await sha256Hex(`${taskId}\0${revision}`)).slice(0, 48)}`;
}
