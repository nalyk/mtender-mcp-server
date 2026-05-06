import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

interface SpawnedServer {
  pid: number | undefined;
  exitCode: Promise<number | null>;
  signal: Promise<NodeJS.Signals | null>;
  kill: (sig: NodeJS.Signals) => boolean;
}

async function spawnHttpServer(): Promise<SpawnedServer> {
  const child = spawn(process.execPath, ["--import", "tsx", ENTRY], {
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      PORT: "0",
      HOST: "127.0.0.1",
      LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise<void>((resolve, reject) => {
    const ready = setTimeout(() => reject(new Error("server did not become ready within 8s")), 8000);
    const matcher = /transport ready/;
    const onData = (buf: Buffer) => {
      if (matcher.test(buf.toString())) {
        clearTimeout(ready);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code, sig) =>
      reject(new Error(`server exited before ready (code=${code} sig=${sig})`)),
    );
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  return {
    pid: child.pid,
    exitCode: exit.then((r) => r.code),
    signal: exit.then((r) => r.signal),
    kill: (sig) => child.kill(sig),
  };
}

async function expectExitWithin(server: SpawnedServer, ms: number): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  const code = await Promise.race([
    server.exitCode.then((c) => ({ code: c, signal: null as NodeJS.Signals | null })),
    server.signal.then((s) => ({ code: null as number | null, signal: s })),
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`process did not exit within ${ms}ms`)), ms),
    ),
  ]);
  return code;
}

test("HTTP server exits cleanly (code 0) on SIGTERM", async () => {
  const server = await spawnHttpServer();
  server.kill("SIGTERM");
  const result = await expectExitWithin(server, 5000);
  assert.equal(
    result.code,
    0,
    `expected clean exit code 0; got code=${result.code} signal=${result.signal}`,
  );
});

test("HTTP server exits cleanly (code 0) on SIGINT", async () => {
  const server = await spawnHttpServer();
  server.kill("SIGINT");
  const result = await expectExitWithin(server, 5000);
  assert.equal(
    result.code,
    0,
    `expected clean exit code 0; got code=${result.code} signal=${result.signal}`,
  );
});
