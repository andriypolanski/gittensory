# Gittensory miner deployment

Two form factors for running `@jsonbored/gittensory-miner`: **laptop mode** (single machine, zero Docker) and **fleet mode** (containerized workers with a shared data volume). Both are 100% client-side for core operation — the miner never uploads source and never requires a hosted Gittensory callback to boot. Credentials (GitHub tokens, etc.) stay on the operator's machine or in their own secret store; nothing is baked into images.

| | Laptop mode | Fleet mode |
|---|---|---|
| **Best for** | One contributor machine, local experimentation | Many parallel miner attempts on a host or small cluster |
| **Dependencies** | Node.js `>=22.13.0` only | Docker (or compatible runtime) + Node image or custom image |
| **State** | SQLite files under `~/.config/gittensory-miner/` (override with `GITTENSORY_MINER_CONFIG_DIR`) | Same SQLite layout on a mounted `/data` (or `GITTENSORY_MINER_CONFIG_DIR`) volume |
| **Setup** | `npm install -g @jsonbored/gittensory-miner` or workspace build | `docker run` with env + volume (see below) |
| **Footprint** | One Node process, local disk for ledgers/queues | One container per worker; scale horizontally by adding containers |

## Laptop mode walkthrough

1. Install Node.js 22.13+ and the package:

   ```sh
   npm install -g @jsonbored/gittensory-miner@latest
   # or from a checkout:
   npm install && npm --workspace @jsonbored/gittensory-miner run build
   ```

2. Inspect what is installed and where local state will live (no network calls):

   ```sh
   gittensory-miner status
   gittensory-miner doctor
   ```

3. Expected layout after first use (default paths):

   ```text
   ~/.config/gittensory-miner/
     claim-ledger.sqlite3      # soft issue claims (#2314)
     plan-store.sqlite3        # persisted MCP plan DAGs (#2318)
     portfolio-queue.sqlite3   # local portfolio queue
     event-ledger.sqlite3      # manage-loop audit trail
     governor-ledger.sqlite3   # governor decisions
   ```

   Override the directory with `GITTENSORY_MINER_CONFIG_DIR` or `XDG_CONFIG_HOME` (same resolution chain as `@jsonbored/gittensory-mcp`).

4. Optional per-repo miner goals: copy [`.gittensory-miner.yml.example`](../../.gittensory-miner.yml.example) to a target repo as `.gittensory-miner.yml`. See [`docs/miner-goal-spec.md`](docs/miner-goal-spec.md).

## Fleet mode walkthrough

There is no separate published miner fleet image yet. Run the same CLI inside a standard Node container, mount persistent state, and inject secrets at runtime (never bake them into the image):

```sh
docker run --rm -it \
  -e GITTENSORY_MINER_CONFIG_DIR=/data/miner \
  -e GITHUB_TOKEN \
  -v miner-data:/data/miner \
  node:24-slim \
  bash -lc 'npm install -g @jsonbored/gittensory-miner@latest && gittensory-miner doctor && gittensory-miner status'
```

- **`/data` volume** — holds all SQLite state so containers are disposable.
- **`GITHUB_TOKEN`** — supplied by the operator at run time; the image contains no credentials.
- **Scale** — launch additional containers with the same volume (or partitioned config dirs) for parallel attempts.

The repo-root [`docker-compose.yml`](../../docker-compose.yml) documents the **self-hosted review stack** (the `gittensory` API/orb), not the miner CLI. Miners are clients of that stack (or of github.com directly) and do not require it to run locally.

## Invariants

- Core miner bookkeeping (claims, plans, queues, ledgers) works offline after install.
- `gittensory-miner status` and `gittensory-miner doctor` make **no network calls**.
- Discovery/ranking primitives that touch GitHub only run when explicitly invoked and only perform documented GETs unless a future command says otherwise.
- Operators own secret injection; images and packages ship without embedded tokens.
