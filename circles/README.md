# Dionysty: Circles, Stars and Starlight

Finished and tested. Start with `AGENT_INSTRUCTIONS.md` (deploy and test steps), then `SPEC.md` (the rules).

- Backend: `worker/circles/circles.js` and `migrations/`
- Lab staging Worker: `worker/staging/`
- Client: `app/circles.js`
- Tests: `npm test` (24 backend tests) and `tests/e2e.py` (two browsers, end to end)
- Screens from the test run: `tests/shots/`

Tested: all 24 backend tests pass; the end-to-end browser test passes against the in-process backend and against the staging Worker in Cloudflare's own runtime (workerd) with a real local D1; and `tests/live_worker_test.py` passes against the real live Worker code with the patch applied.
