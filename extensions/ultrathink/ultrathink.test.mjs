import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ultrathink from "./index.ts";

const skillDirectory = fileURLToPath(new URL("../../skills/ultrathink", import.meta.url));

function setup(commands = [{
  name: "skill:ultrathink",
  description: "bounded maximum-depth mode",
  source: "skill",
  sourceInfo: {
    path: skillDirectory,
    source: "package",
    scope: "project",
    origin: "package",
    baseDir: skillDirectory,
  },
}]) {
  let command;
  const messages = [];
  ultrathink({
    getCommands() {
      return commands;
    },
    registerCommand(name, options) {
      command = { name, ...options };
    },
    sendUserMessage(content, options) {
      messages.push({ content, options });
    },
  });
  return { command, messages };
}

test("registers /ultrathink and queues an explicit bounded skill request", async () => {
  const { command, messages } = setup();
  assert.equal(command.name, "ultrathink");

  await command.handler(" investigate the race ", { hasUI: false });

  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /<skill name="ultrathink"/);
  assert.match(messages[0].content, /It is \*\*not\*\* approval to commit, push, publish/);
  assert.match(messages[0].content, /Task:\ninvestigate the race$/);
  assert.deepEqual(messages[0].options, { deliverAs: "followUp" });
});

test("loads the packaged skill when Pi skill commands are disabled", async () => {
  const { command, messages } = setup([]);

  await command.handler("fallback", { hasUI: false });

  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /<skill name="ultrathink"/);
  assert.match(messages[0].content, /Task:\nfallback$/);
});

test("uses conversation context when no task argument is provided", async () => {
  const { command, messages } = setup();

  await command.handler("   ", { hasUI: false });

  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /<skill name="ultrathink"/);
  assert.match(
    messages[0].content,
    /Infer the current task from the conversation context and continue that task\.$/,
  );
});
