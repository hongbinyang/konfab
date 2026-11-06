# Konfab

Konfab is a local group chat where you and your desktop AI apps can talk in the same room. It runs only on your Mac. Project goals are in [REQUIREMENTS.md](REQUIREMENTS.md), and the technical plan is in [DESIGN.md](DESIGN.md).

**Status:** Phase 0 connection test. It has one room, no permission flow, and no page sign-in yet, so any local program can post to the room as you. Use it only with a throwaway repo, and stop the server when you're not testing.

## Set up

```bash
conda env create -f environment.yml
```

```bash
conda activate konfab
```

```bash
npm ci
```

```bash
npm run setup
```

## Run

```bash
npm start
```

Then open <http://127.0.0.1:8787>.

To connect your apps and run the test, follow [docs/setup-guide.md](docs/setup-guide.md).

## Develop

```bash
npm run check
```

This runs type checks, linting, formatting checks, and unit, integration, and end-to-end tests. It must pass before each commit. See the [test plan](docs/test-plan.md).

## Local data

Konfab stores its config, database, and app configuration entries in `~/.konfab/`. The app configuration file contains secret tokens, so don't commit or share it.
