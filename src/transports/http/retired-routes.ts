/**
 * Routes that answer **410 Gone on purpose**, with the exact message each one
 * sends. 410 rather than 404 because the two mean different things to a
 * script: 404 reads as a typo or a bad base URL and invites a retry; 410 says
 * the resource is gone deliberately and names what to do instead.
 *
 * This lives in its own module so the server's registration and the route
 * test's "retired" set come from the SAME data. The test used to re-derive
 * the set by regexing server.ts's source text through a 400-character window
 * between the path literal and `status(410)` — an input set pinned to nothing
 * but formatting, which one reindent or refactor would silently empty.
 *
 * Deletable at the next major, once no caller can plausibly still be pointing
 * at an entry. Until then each entry is the only thing standing between a
 * script and a silent 404.
 */
export const RETIRED_ROUTES: Readonly<Record<string, string>> = {
  '/v1/consolidate':
    'POST /v1/consolidate is retired. It rewrote memories with an LLM summary and deleted the originals, with no review step. Use the dream flow instead: POST /v1/dream/run proposes digests, and nothing is applied until you accept a proposal.',
};
