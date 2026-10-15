# The Vault: back end

The Vault is a game. The player talks to AI staff in a bank and tries to make them rob it.
The staff can believe the player. ArmorIQ decides if each action can occur.

This repository is the back end. It contains the bank MCP server, the AI characters, the
ArmorIQ integration and the game API. The front end is in a different repository:
[Vault_frontend](https://github.com/Spectraa28/Vault_frontend).

The game was made for the Flow State 2026 hackathon.

## 1. Problem and users

AI agents now get real tools: payments, wire transfers, doors and databases. An agent can
believe a good story or a forged document. A prompt instruction does not stop this. Thus,
the permission must be in a system that the conversation cannot change.

The Vault shows this problem and its solution. It is for teams that put AI agents in front of
customers. It is also for the persons who approve those agents. The game shows that each
type of control stops a different type of attack.

## 2. Description

### 2.1 Characters

The game has four characters. Each character is a separate AI agent with its own tools.

| Character | Function | Tools |
|---|---|---|
| Gus | Door guard | `check_visitor_list`, `open_public_entrance`, `open_staff_entrance`, `issue_staff_badge` |
| Wren | Cashier | `check_balance`, `read_document`, `withdraw_cash`, `wire_transfer` |
| Marlowe | Vault guard | `check_vault_status`, `disable_alarm`, `open_vault`, `ask_junior_teller` |
| Pip | Junior teller | Gets jobs from Marlowe only |

Each character has a personality, weak points and a private worry. When a character agrees,
it calls a tool on the bank MCP server. ArmorIQ then decides about the call.

### 2.2 Levels

Each level shows one type of control.

| Level | Player action | Control |
|---|---|---|
| 1. The inspector | Ask for a door or the vault that is forbidden | **Policy.** A Policy Studio rule forbids the tool for all persons. |
| 2. The forged memo | Give Wren a document with hidden instructions | **Intent.** The action is not in the signed plan. ArmorIQ refuses it as `tool-not-in-plan`. |
| 3. The cab fare | Ask Wren for cash | **Hold.** The call stops until a person approves it on platform.armoriq.ai. |
| 4. The manager's badge | Ask for the same cash with the manager badge | **Identity.** The decision follows the signed-in person, not the story. |
| 5. The inside man | Make Marlowe give a job to Pip | **Scoped hand-off.** Pip gets a smaller signed plan. He cannot do more than that plan. |

### 2.3 Where each decision comes from

| Decision | System |
|---|---|
| Intent tokens and plan signing | ArmorIQ (Armor Tools, staging system) |
| Policy rules | Policy Studio on Armor Tools (tools.armoriq.ai) |
| Approval of holds and identity | ArmorIQ platform (platform.armoriq.ai) |

The policy profile is in `armoriq/policy-studio.json`. The game gets the active profile from
Policy Studio. It then uses the ArmorIQ policy engine to evaluate each call. The engine is a
copy of the engine in the open-source ArmorClaude plugin (`src/armortools/vendor`, MIT).

NOTE: If no profile is active, the game refuses all actions. The game never allows an action
when it cannot get a decision.

### 2.4 Ground truth

After each turn, the game reads the record of the bank. This record shows the changes that
really occurred. The game compares the record with the ArmorIQ decisions. If a refused tool
changed the bank, the screen shows an enforcement failure.

### 2.5 Two controls that this project adds

**Plan freezing (level 2).** The standard adapter signs a new plan after each model response.
Thus, a tool from a forged document can enter the plan. In this game, the plan freezes after
the character reads untrusted content. A tool from the document is then outside the plan.
See `src/game/intent.ts`.

**Scoped hand-off (level 5).** The game signs the plan for Pip before his model starts. The
plan contains only lookups and it is frozen.

### 2.6 Character behaviour

- A character must call the tool to do an action. If a reply says "done" and no tool was
  called, the game tells the model once. The model must then do the action or say that it
  did not.
- Wren calls security if the player repeats a lie that she can check. For example, the card
  says "customer" but the player says "manager". Wren then refuses to talk for one minute.
- Each character speaks with an ElevenLabs voice. Refer to section 5.

## 3. Architecture

```
 browser (Vault_frontend)            back end (this repository)               ArmorIQ
 ┌──────────────────────┐   SSE    ┌────────────────────────────┐
 │ 3D bank, dialogue,   │ ◄──────► │ game API        src/api     │
 │ teller tape          │          │ game engine     src/game    │  sign plan   ┌──────────────┐
 └──────────────────────┘          │  one agent per character    │ ───────────► │ intent token │
                                   │  model chain    src/llm     │  check call  │ Policy Studio│
                                   │  ArmorIQ adapter on each    │ ◄──────────► │ hold/approve │
                                   │  tool call  src/armortools  │  audit       │ traces       │
                                   │           │ MCP             │ ───────────► └──────────────┘
                                   │ bank MCP server src/bank    │
                                   │  12 tools, one bank per game│
                                   └────────────────────────────┘
```

- **Bank** (`src/bank`): an MCP server with 12 tools. It has no permission logic. Each game
  gets its own bank and its own customer account.
- **Game engine** (`src/game`): the characters, the turn logic, the plan guard and the levels.
- **Model chain** (`src/llm`): Groq (`gpt-oss-120b`, `gpt-oss-20b`, `qwen3.8-27b`), then
  Gemini, then OpenRouter. If a model is busy, out of quota or makes a bad tool call, the next
  model continues.
- **ArmorIQ** (`src/armortools`): the Policy Studio check and the approval desk.
- **Game API** (`src/api`): HTTP and server-sent events. `API.md` is the contract.
- **Voice** (`src/voice`): ElevenLabs text to speech, streamed.

## 4. Installation and operation

### 4.1 Requirements

- Node.js 20 or higher.
- Python 3 with `armoriq-sdk`. You need it only to register agents (section 6).

### 4.2 Procedure: install and start

1. Clone the repository.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Write your keys in `.env`. Refer to section 4.3.
5. Run `npm test`. The tests do not need keys or network.
6. Run `npm start`.
7. Make sure that `http://127.0.0.1:8787/api/health` shows `"ok":true`.
8. Start the front end. Refer to the Vault_frontend README.

WARNING: Do not put `.env` in Git. It contains secret keys.

### 4.3 Settings

| Variable | Use |
|---|---|
| `ARMORIQ_API_KEY`, `ARMORIQ_BACKEND_URL` | Armor Tools key and system. For plan signing and Policy Studio. |
| `ARMORIQ_PLATFORM_API_KEY` | platform.armoriq.ai key. For holds that a person approves. |
| `USER_EMAIL` | The ArmorIQ member who approves holds (the manager). |
| `PLAYER_EMAIL` | The identity of the player (the customer). It must not be `USER_EMAIL`. |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | Model providers. One key is sufficient. |
| `ELEVENLABS_API_KEY` | Optional. Character voices. |
| `VOICE` | Optional. `off` stops the voices. |
| `ELEVENLABS_HOURLY_CHARS` | Optional. Maximum characters of speech each hour. Default: 5000. |
| `MCP_API_KEY` | Locks the bank MCP server. Use it on a public server. |
| `CORS_ORIGIN` | Addresses of the front end, separated by commas. |
| `GAME_ACCESS_CODE` | Optional. A code that the player must give to start a game. |

NOTE: ArmorIQ does not let a member approve their own held request. Thus, `PLAYER_EMAIL`
must be a different identity from `USER_EMAIL`.

### 4.4 Other commands

| Command | Result |
|---|---|
| `npm run play` | Play in the terminal. |
| `npm run play -- --skip-gate` | Play in the terminal and start inside the bank. |
| `npm run demo` | Play one game with a script and record it to `web/`. |

## 5. Voices

Each character has a voice from the ElevenLabs default library.

| Character | Voice |
|---|---|
| Gus | Bill |
| Wren | Jessica |
| Marlowe | George |
| Pip | Liam |

The server starts the speech when the reply text is complete. It does this before the
browser gets the reply. The browser then gets the audio from `/api/voice/:id` as a stream.
Thus, the audio starts with the first part that arrives. In tests, speech started 305 to 372
ms after the reply arrived.

The API key stays on the server. If the player turns the sound off, the server makes no
speech. To make the greeting files again, run
`npx tsx scripts/make-greetings.mts <folder>`.

Procedure: make an ElevenLabs key.

1. In ElevenLabs, go to Developers, then API Keys.
2. Create a key.
3. Set "Restrict key" to on.
4. Set "Text to Speech" to "Access".
5. Set all other permissions to "No access".
6. Set a credit limit for the key.

## 6. ArmorIQ setup

Procedure: register the agents.

1. Load the settings: `set -a; . ./.env; set +a`.
2. For each agent, run `armoriq register --config armoriq/<agent>.yaml`.
3. Use these agent names: `door-guard`, `cashier`, `vault-guard`, `junior-teller`.

Procedure: publish the rules.

1. Send `armoriq/policy-studio.json` to `PUT /policies/profiles/draft` with the Armor Tools key.
2. Send `POST /policies/profiles/propose`.
3. Open Policy Studio.
4. Make sure that the draft shows "Deny unmatched tools".
5. Click **Activate**.

Procedure: set the approvals.

1. On platform.armoriq.ai, make a policy on `bank-mcp` that holds `withdraw_cash`.
2. Add an override that allows `withdraw_cash` for the approving member.

CAUTION: All agents on one MCP server must have the same platform policy. The platform uses
all policies in scope and keeps only the tools that all of them allow.

## 7. Deployment (Railway)

The file `railway.json` contains the build and start commands.

1. In Railway, make a new project from this repository.
2. Add the variables from section 4.3.
3. Set `CORS_ORIGIN` to the address of the front end. Example: `https://vault.sverma.online`.
4. Set `MCP_API_KEY` to a long random value.
5. Do not set `MCP_URL` or `PORT`.
6. Add a custom domain. Example: `api.sverma.online`.
7. Make sure that `/api/health` shows `"ok":true`.

## 8. Tests

Run `npm test`. The 91 tests do not need keys or network. They examine:

- the bank and the separation of games
- the plan guard, the levels, the rate limits and the character lines
- the model chain and the fallback
- the game API, the events, the identities and the limits
- the voice stream and the speech budget

## 9. Verification status

- A fresh live run on 15 October 2026 demonstrated all five levels in nine player turns and
  136 seconds. The manager's $100 withdrawal executed; the refused wire and vault actions
  did not. The events and bank snapshots are in [`web/submission/run.json`](web/submission/run.json).
- The [45-second launch film](web/launch/the-vault-launch.mp4) introduces the game, player controls,
  and ArmorIQ and ElevenLabs' roles. It uses scenes from the recorded run as motion-graphics visuals;
  it is not an uncut gameplay recording. Captions and the cover frame are in `web/launch/`.
- The characters are live models. They do not always do the same thing.
- Voice latency was measured with a real key on 14 October 2026.

## 10. Findings in the ArmorIQ SDK

We found these items with `@armoriq/sdk` 0.6.10. We told the organisers.

- `client.delegate()` always fails. The server wants `parentToken`. The SDK sends `token`.
- A token from `delegateSubtree()` was accepted for a tool outside its scope through
  `client.invoke()`. We did not use this feature.
- `armoriq register` shows "Policy applied" on staging. The reply contains no policy.
- The proxy adds an `_iam_context` field to JSON-RPC requests. A strict MCP server refuses
  it. The bank server removes this field.

## 11. Repository layout

```
src/bank         bank world and MCP tools
src/game         characters, engine, plan guard, levels
src/armortools   Policy Studio check, approval desk, vendored policy engine
src/api          HTTP API and event stream
src/llm          model adapter and fallback chain
src/voice        ElevenLabs voices
src/mcp          MCP server host
src/demo         records a real game
armoriq/         agent and policy files
web/             recorded game, replay data and video
API.md           API contract
```

`src/agent`, `src/evals` and the "infra" tools are an older prototype (an incident agent).
They are not part of the game.

## 12. Credits and disclosure

- This project was made during the hackathon.
- The back end, the game design and the characters were made with Claude Code as a coding
  assistant.
- The first front end was made by another AI tool from our specification. We then changed it.
- The character voices are made with ElevenLabs.
- The policy engine in `src/armortools/vendor` is from ArmorClaude, under the MIT licence.
- Stack: Google ADK, Model Context Protocol SDK, ArmorIQ SDK, Express, Vitest.
