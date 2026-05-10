import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as cp from "child_process";
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import os from "os";

// Tests for the Stop hook dream auto-trigger added so the Insights tab
// receives data without users running `memesh dream run` manually.
// Each scenario asserts what the throttle / activity / LLM gate
// decides — the spawned dream child is detached and its real LLM
// behaviour is covered by the dreamer's own test suite.

const require = createRequire(import.meta.url);

describe("Feature: Stop-hook dream auto-trigger", () => {
  let testDir: string;
  let memeshDir: string;
  let dbPath: string;
  let configPath: string;
  let transcriptPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "memesh-dream-trigger-test-"));
    memeshDir = path.join(testDir, ".memesh");
    fs.mkdirSync(memeshDir, { recursive: true });
    dbPath = path.join(memeshDir, "knowledge-graph.db");
    configPath = path.join(memeshDir, "config.json");
    transcriptPath = path.join(testDir, "transcript.jsonl");
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function writeConfig(cfg: object): void {
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    fs.chmodSync(configPath, 0o600);
  }

  function writeMinimalTranscript(): void {
    fs.writeFileSync(transcriptPath, [
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/tmp/proj/src/auth.ts" } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/tmp/proj/src/config.ts" } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } },
    ].map(e => JSON.stringify(e)).join("\n"));
  }

  function seedEpisodicEntities(projectName: string, count: number): void {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        access_count INTEGER DEFAULT 0,
        confidence REAL DEFAULT 1.0
      );
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        UNIQUE(entity_id, tag)
      );
    `);
    const insertEnt = db.prepare(`INSERT INTO entities (name, type) VALUES (?, 'session_keypoint')`);
    const insertTag = db.prepare(`INSERT INTO tags (entity_id, tag) VALUES (?, ?)`);
    for (let i = 0; i < count; i++) {
      const r = insertEnt.run(`${projectName}-keypoint-${i}-${Date.now()}-${Math.random()}`);
      insertTag.run(r.lastInsertRowid as number, `project:${projectName}`);
    }
    db.close();
  }

  function runHook(env: Record<string, string> = {}): string {
    const hookPath = path.resolve("scripts/hooks/session-summary.js");
    const input = JSON.stringify({
      session_id: "test-dream-trigger",
      transcript_path: transcriptPath,
      cwd: "/tmp/myproject",
      stop_reason: "end_turn",
      was_in_agentic_loop: true,
    });
    try {
      return cp.execFileSync("node", [hookPath], {
        input,
        env: {
          ...process.env,
          MEMESH_DB_PATH: dbPath,
          MEMESH_DIR: memeshDir,
          MEMESH_AUTO_CAPTURE: "true",
          ...env,
        },
        encoding: "utf8",
        timeout: 15000,
      });
    } catch (err: any) {
      return err.stdout || "";
    }
  }

  it("skips dream when no LLM is configured", () => {
    writeConfig({});
    writeMinimalTranscript();
    seedEpisodicEntities("myproject", 30);
    runHook();

    const historyPath = path.join(memeshDir, "dream-history.json");
    expect(fs.existsSync(historyPath)).toBe(false);
  });

  it("skips dream when below the activity threshold", () => {
    writeConfig({ llm: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "sk-ant-test-junk" } });
    writeMinimalTranscript();
    seedEpisodicEntities("myproject", 5);

    runHook();

    const historyPath = path.join(memeshDir, "dream-history.json");
    if (fs.existsSync(historyPath)) {
      const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      expect(history.myproject).toBeUndefined();
    }
  });

  it("skips dream when last run was within 24h (throttle)", () => {
    writeConfig({ llm: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "sk-ant-test-junk" } });
    writeMinimalTranscript();
    seedEpisodicEntities("myproject", 30);

    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const historyPath = path.join(memeshDir, "dream-history.json");
    fs.writeFileSync(historyPath, JSON.stringify({
      myproject: { last_run_iso: oneHourAgo, last_episodic_count: 30, last_window_days: 14 },
    }));

    runHook();

    const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    expect(history.myproject.last_run_iso).toBe(oneHourAgo);

    const logDir = path.join(memeshDir, "dream-runs");
    const logs = fs.existsSync(logDir) ? fs.readdirSync(logDir) : [];
    expect(logs.length).toBe(0);
  });

  it("triggers dream when all gates pass (LLM + activity ≥ 10 + last run > 24h)", () => {
    writeConfig({ llm: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "sk-ant-test-junk" } });
    writeMinimalTranscript();
    seedEpisodicEntities("myproject", 15);

    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(memeshDir, "dream-history.json"), JSON.stringify({
      myproject: { last_run_iso: twoDaysAgo },
    }));

    runHook();

    const history = JSON.parse(fs.readFileSync(path.join(memeshDir, "dream-history.json"), "utf8"));
    expect(history.myproject).toBeDefined();
    const updatedAge = Date.now() - new Date(history.myproject.last_run_iso).getTime();
    expect(updatedAge).toBeLessThan(60 * 1000);
    expect(history.myproject.last_episodic_count).toBeGreaterThanOrEqual(10);

    const logDir = path.join(memeshDir, "dream-runs");
    expect(fs.existsSync(logDir)).toBe(true);
    const logs = fs.readdirSync(logDir);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const headerLine = fs.readFileSync(path.join(logDir, logs[0]), "utf8").split("\n")[0];
    expect(headerLine).toContain("project=myproject");
    // The hook itself creates a session-insight entity before reaching
    // the dream trigger, so the episodic count picks up 1+ extra
    // entities of compactable type. Test for >= seed count rather than
    // an exact match.
    const m = headerLine.match(/episodic_count=(\d+)/);
    expect(m).not.toBeNull();
    expect(parseInt(m![1], 10)).toBeGreaterThanOrEqual(15);
  });
});
