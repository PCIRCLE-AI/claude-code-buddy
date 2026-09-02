export async function runHostEntry(binary, run, stderr = process.stderr) {
    try {
        await run();
        return 0;
    }
    catch (error) {
        stderr.write(`${binary}: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
}
//# sourceMappingURL=entry.js.map