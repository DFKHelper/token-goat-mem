/** Worker-thread body for the start-up-failure test in tests/unit/db-contention.test.ts: throws before it ever reaches the barrier, which is how a worker that cannot load or start looks to the main thread. */
throw new Error("start-up failure before the barrier");
