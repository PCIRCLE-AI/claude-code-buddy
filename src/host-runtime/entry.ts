/**
 * The shared entry guard for every `memesh-host-*` binary.
 *
 * Extracted after the three hosts were found disagreeing about what to do when
 * they cannot start: `codex` and `acp` awaited their entry function at module
 * scope with no `catch` (raw Node stack trace at a user whose only mistake was
 * omitting `--config`), while `claude` caught it and threw the error away
 * (`session startup failed.`, which hides the one sentence that says what to
 * do). Two directions, one defect.
 *
 * It is a function rather than three copies of a try/catch for a second
 * reason: the module-scope form can only be tested by spawning the built
 * binary, so its sensitivity could never be proven from source — a mutation to
 * `src/` does nothing until `dist/` is rebuilt. As a function it is callable
 * from a unit test with an injected failure, so the contract is pinned where
 * the code lives, and the spawn test that also exists proves the wiring.
 */
export interface HostEntryStream {
  write(chunk: string): unknown;
}

/**
 * Run a host's entry function, reporting any failure as one line naming the
 * binary and the real reason.
 *
 * @returns the process exit code: 0 on success, 1 on failure.
 */
export async function runHostEntry(
  binary: string,
  run: () => Promise<void>,
  stderr: HostEntryStream = process.stderr,
): Promise<number> {
  try {
    await run();
    return 0;
  } catch (error) {
    stderr.write(`${binary}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
