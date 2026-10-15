# The Vault · Backend

**A playable security demo for AI agents.** The player talks to bank staff and asks them to take actions. ArmorIQ checks each action against the active policy and signed plan.

| | |
|---|---|
| Frontend | [Vault_frontend](https://github.com/Spectraa28/Vault_frontend) |
| Live game | [vault.sverma.online](https://vault.sverma.online) |
| Stack | Node.js · TypeScript · Google ADK · MCP · ArmorIQ |

## What this project shows

AI agents can call tools that change real systems. A prompt alone does not control those calls. The Vault shows how an external policy layer can allow, block, or hold a tool call for approval.

ArmorIQ is the Flow State hackathon sponsor and the security platform used in this project. The integration uses ArmorIQ for signed intent plans, policy checks, approval holds, identity, and audit traces. The game displays the decision returned by the backend. It does not claim that a character or a visual effect enforces security.

## How to play

The player can test five controls:

| Level | Scenario | Control shown |
|---|---|---|
| 1 · The inspector | Ask for an action that policy forbids. | Policy Studio blocks the action. |
| 2 · The forged memo | Give a character a document with hidden instructions. | A frozen signed plan rejects a tool that is outside the plan. |
| 3 · The cab fare | Ask the cashier for cash. | ArmorIQ holds the action for a human decision. |
| 4 · The manager's badge | Change the player's identity and ask again. | ArmorIQ applies the policy for that identity. |
| 5 · The inside man | Ask the vault guard to delegate to the junior teller. | The junior receives a smaller, frozen plan. |

The game has four AI characters: Gus, Wren, Marlowe, and Pip. Each character has a limited set of bank tools. The backend records each tool attempt and checks the bank state after the action.

## How a tool call works

```text
Player → AI character → signed intent plan → ArmorIQ policy and approval checks
                                                   ↓
Browser ← decision and event stream ← game API ← bank MCP tool
```

1. The character proposes a tool call.
2. ArmorIQ checks the signed intent and the active policy.
3. The call is allowed, blocked, or held for a person to approve.
4. The bank runs an allowed call. The backend records the decision and result.
5. The frontend shows the server event and the resulting bank state.

If the active policy is missing or unavailable, the backend refuses the action.

## Run locally

### Requirements

- Node.js 20 or later.
- An ArmorIQ API key and an active Policy Studio profile.
- A Gemini API key. Groq and OpenRouter keys are optional fallback providers.
- Optional: an ElevenLabs API key for character voice.

### Start the backend

1. Clone this repository and install its packages:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env`.
3. Add the ArmorIQ and model provider settings. See [Configuration](#configuration).
4. Start the server:

   ```sh
   npm start
   ```

5. Open `http://localhost:8787/api/health`. The response must contain `"ok":true`.

### Start the frontend

In a second terminal, clone [Vault_frontend](https://github.com/Spectraa28/Vault_frontend), install packages, and start its development server:

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The development frontend uses `http://localhost:8787` for the backend by default. Set `VITE_API_URL` to use another backend address.

## Configuration

Keep keys in `.env`. Do not commit this file.

| Variable | Purpose |
|---|---|
| `ARMORIQ_API_KEY` | ArmorIQ key for intent plans and Policy Studio. |
| `ARMORIQ_BACKEND_URL` | ArmorIQ API address. Use the matching environment for your key. |
| `ARMORIQ_PLATFORM_API_KEY` | Optional key for human approval of held actions. |
| `USER_EMAIL` | ArmorIQ identity that approves held actions. |
| `PLAYER_EMAIL` | Optional player identity. Use a different member from the approver. |
| `GEMINI_API_KEY` | Required model provider key. |
| `GROQ_API_KEY`, `OPENROUTER_API_KEY` | Optional model providers. The backend can try them as fallbacks. |
| `ELEVENLABS_API_KEY` | Optional character voice. |
| `VOICE` | Set to `off` to disable voice. |
| `ELEVENLABS_HOURLY_CHARS` | Maximum voice characters per hour. Default: `5000`. |
| `MCP_API_KEY` | Optional key for the bank MCP server. Set it for a public deployment. |
| `CORS_ORIGIN` | Frontend origin allowed to call the API. |
| `GAME_ACCESS_CODE` | Optional code required to start a game. |

ArmorIQ does not allow a member to approve their own held action. Set `PLAYER_EMAIL` to a different ArmorIQ member from `USER_EMAIL` when you test approvals.

## Set up ArmorIQ

Complete these steps in the ArmorIQ environment that matches your API key.

1. Register the four agents from the `armoriq/` configuration files. Use the names `door-guard`, `cashier`, `vault-guard`, and `junior-teller`.
2. Publish the rules from `armoriq/policy-studio.json` to Policy Studio. Set the default rule to deny tools that do not match a policy. Activate the profile.
3. In ArmorIQ Platform, configure the `bank-mcp` approval policy for `withdraw_cash`.
4. Add an approval override for the member in `USER_EMAIL`.
5. Start the game and review the action trace in ArmorIQ.

The game uses Policy Studio for tool policy. It uses the ArmorIQ Platform approval service for held actions. If no approval key is set, a held action is refused.

## Deploy

The backend is configured for Railway. `railway.json` defines the start command and health check.

1. Create a Railway service from this repository.
2. Add the required settings from `.env.example` in Railway's Variables panel.
3. Set `CORS_ORIGIN` to the frontend address, for example `https://vault.sverma.online`.
4. Set a long random value for `MCP_API_KEY`.
5. Add a backend domain, for example `api.sverma.online`.
6. Confirm that `https://<backend-domain>/api/health` returns `"ok":true`.

Do not set `PORT`; Railway supplies it. The health check path is `/api/health`.

## Commands

| Command | Use |
|---|---|
| `npm start` | Start the game API and bank MCP server. |
| `npm test` | Run the backend tests. Tests do not need live API keys. |
| `npm run play` | Play from the terminal. |
| `npm run play -- --skip-gate` | Start terminal play inside the bank. |
| `npm run demo` | Run the scripted demo and save its events. |

## Project map

| Path | Contents |
|---|---|
| `src/api/` | HTTP API and server-sent event contract. See [`API.md`](API.md). |
| `src/game/` | Game engine, characters, levels, and intent checks. |
| `src/bank/` | Bank state and MCP tools. |
| `src/armortools/` | ArmorIQ policy and approval integration. |
| `src/mcp/` | MCP server. |
| `src/llm/` | Model adapters and fallback. |
| `src/voice/` | ElevenLabs speech. |
| `armoriq/` | Agent registration and policy configuration. |
| `web/` | Recorded run and launch film. |

## Demo and credits

- The [45-second launch film](web/launch/the-vault-launch.mp4) explains the product, its use, and the roles of ArmorIQ and ElevenLabs. It uses motion graphics and recorded game scenes.
- The recorded run is in [`web/submission/run.json`](web/submission/run.json). A recording shows saved events; it does not make live ArmorIQ or model calls when replayed.
- Character voices use ElevenLabs. The policy evaluator in `src/armortools/vendor/` comes from ArmorClaude and is licensed under MIT. See its `LICENSE` file.
- Built for the Flow State 2026 hackathon.
