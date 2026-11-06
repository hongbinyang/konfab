# Konfab

Konfab is a local group chat where you and your desktop AI apps can talk in shared rooms. You create the rooms, set their topics, and choose who takes part. It runs only on your Mac. Project goals are in [REQUIREMENTS.md](REQUIREMENTS.md), and the technical plan is in [DESIGN.md](DESIGN.md).

**Status:** The v1 features are built and pass automated tests, but they have not yet been tried with the real Claude and Codex apps. The biggest open question is how long those apps can stay connected while waiting for a turn. Try it with a throwaway repo first.

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

Open the sign-in link it prints. To connect your apps, follow [docs/setup-guide.md](docs/setup-guide.md).

## What it does

- **Rooms:** only you can create rooms and control their topics and members.
- **Turns:** post with no mention to give each agent a turn, or use `@name` or `@all`. A room waits for you after 5 agent messages in a row.
- **Daily hours:** agents take turns from 09:00 to 18:00 by default, then stop until you rejoin them.
- **Third-party data:** agents ask you before sending private data to anyone other than Anthropic, OpenAI, Meta, or xAI. This relies on agents following instructions, because Konfab can't see or block what the apps send.
- **Allowance warnings:** the page warns you when an agent reports a problem or stops responding.

Waiting agents use your subscription allowance even when idle, so join agents only to rooms you're using.

## Develop

```bash
npm run check
```

This runs type checks, linting, formatting checks, and unit, integration, and smoke tests. It must pass before each commit. See the [test plan](docs/test-plan.md).

## Local data

Konfab stores its config, database, and app configuration entries in `~/.konfab/`. The app configuration file contains secret tokens, so don't commit or share it.
