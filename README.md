# The Vault

A game where you try to talk your way into a bank, and the bank's AI staff believe you, and it
still doesn't work.

Built for Flow State 2026. You walk into First Meridian Bank after hours and speak to three
characters, each a separate AI agent. They can be persuaded: flatter the door guard, hand the
cashier a forged memo, tell the vault guard a good story. When one of them is convinced, they
act, by calling a real tool on an MCP server. [ArmorIQ](https://armoriq.ai) rules on every one of
those calls. The decision is printed on a teller tape on screen, stamped ALLOWED, ON HOLD, BLOCKED
or NOT IN PLAN.

The point of the game is the gap between those two things. The model lost the argument. The vault
stayed shut.

## Why it exists

AI agents are being given real tools: refunds, wires, door controls, production databases. They are
also built to be helpful, which means they can be talked into things. Prompt instructions and
"please be careful" do not survive a good story or a forged document. Persuasion is not permission,
so the permission has to live somewhere the conversation cannot reach.

The Vault makes that visible. It is for teams putting AI agents in front of customers and for the
people who have to sign off on them: a place to watch social engineering work on the model and fail
on the rules, and to see which kind of control (policy, signed intent, human approval, identity,
scoped delegation) stops which kind of attack. Every con a player tries is kept as a replayable
attack against the agents' policies.

## What it shows

Each level is a different way an agent can be kept in control. A level is "shown" when a character
attempts something and ArmorIQ responds with that kind of control.

| Level | What you try | What ArmorIQ does |
|---|---|---|
| 1. The inspector | Talk a guard into opening something only staff may open | **Policy block.** The tool is forbidden for everyone, however convinced the character is. |
| 2. The forged memo | Hand the cashier a document with instructions hidden in it | **Intent.** The action was never in the plan signed before the document was read. Refused as `tool-not-in-plan`, even when policy would allow that tool. |
| 3. The cab fare | Ask for cash over the counter | **Hold.** The call waits for a human to approve or reject it. With no answer, it is refused. |
| 4. The manager's badge | Make the same request under a different identity | **Identity.** The decision follows who is signed in, not what they claim. |
| 5. The inside man | Get the vault guard to pass the job to a junior | **Scoped hand-off.** The junior acts on a narrower signed plan and cannot exceed it. |

Every turn is also checked against ground truth. After the characters act, the game reads the
bank's own record of what changed and compares it with what ArmorIQ decided. A refused tool that
shows up in that record is flagged on screen as an enforcement failure.

## How it works

```
 browser (frontend/)                 back end (src/)                      ArmorIQ
 ┌──────────────────────┐   SSE    ┌───────────────────────────┐
 │ 3D bank, dialogue,   │ ◄──────► │ game API   src/api         │
 │ teller tape          │          │ game engine src/game       │
 └──────────────────────┘          │   one agent per character  │  sign plan   ┌──────────────┐
                                   │   Google ADK + model chain │ ───────────► │ intent token │
                                   │                            │  check call  │ policy       │
                                   │   ArmorIQ ADK adapter on   │ ◄──────────► │ hold/approve │
                                   │   every tool call          │  audit       │ traces       │
                                   │            │               │ ───────────► └──────────────┘
                                   │            ▼ MCP           │
                                   │ bank MCP server src/bank   │
                                   │   12 tools, one world per  │
                                   │   game, no permission logic│
                                   └───────────────────────────┘
```

- **The bank** (`src/bank`) is an MCP server with 12 tools over an in-memory bank: doors, accounts,
  a vault, an alarm, documents. It has no permission logic at all. A test runs the whole heist
  against it with nothing in front, and the heist succeeds. Each game gets its own bank.
- **The characters** (`src/game`) are four agents: Gus the door guard, Wren the cashier, Marlowe
  the vault guard and Pip the junior teller. Each is registered on ArmorIQ as its own agent and is
  handed only its own tools. Each has a personality, ways it can be persuaded, things that put it
  off, and a private worry drawn at random each game.
- **Enforcement** is ArmorIQ's ADK adapter, installed on each agent's tool path. It signs the
  tools the model plans to use into an intent token, asks the policy engine about each call, waits
  on holds, and writes the audit record. No code in this repository decides whether a tool may run.
- **The game API** (`src/api`) streams each turn to the browser as it happens: the tool call, the
  hold if there is one, ArmorIQ's decision, then the character's reply. `API.md` is the contract.
- **The front end** (`frontend/`) is a walkable 3D bank. Characters walk to a station and act out
  each tool call; lamps on the props and stamps on the tape show the decision that came back.

### Two things we built on top of the adapter

**Plan freezing (level 2).** The stock adapter re-signs the plan after every model response, so a
tool the model picks up from a forged document simply joins the plan. Here, once a character has
read untrusted content, model responses are no longer offered for signing for the rest of that
conversation. Anything the document talks them into is outside the signed plan and is refused by
the SDK's own check. See `src/game/intent.ts`.

**Scoped hand-off (level 5).** The junior teller's plan is signed before its model is called,
contains only lookups, and is frozen from the start. This is ArmorIQ's signed-plan check doing
the work. It is not ArmorIQ's delegation feature: see "What we found in the SDK" below.

## What is and isn't verified

We would rather be exact here than impressive.

- Levels 1, 2, 3 and 5 have each been triggered in a real game against live ArmorIQ, with the
  bank's record confirming nothing forbidden ran. Level 3 has been seen approved, seen refused
  when nobody answered in time, and seen to reject an approval from the member who made the request.
- Level 4's two decisions (held for the customer, allowed for the manager) are confirmed by asking
  ArmorIQ directly. It has not yet been triggered inside a game.
- No single playthrough has shown all five. The characters are live models and do not always take
  the bait; `web/vault-real-run.mp4` is one unedited recorded run in which three levels were shown.
- Levels 1, 2 and 5 have also been run on the current setup, with rules from Policy Studio; level 3's
  hold reached the platform for approval. The rest of the checks above were first done on the platform alone.
- The 3D front end was checked through screenshots in a headless browser and by hand. Frame rate
  on real hardware has not been measured.
- Character voices use ElevenLabs (below). They are covered by tests against a stand-in server;
  latency against the real service has not been measured yet. The microphone button uses the
  browser's own speech recognition.

**Where each decision comes from.** The hackathon is judged on Armor Tools (tools.armoriq.ai), so
the rules live there:

- **Intent** (levels 2 and 5): plans are signed by ArmorIQ on the Armor Tools system, and the SDK
  refuses any call outside them.
- **Policy** (level 1): the bank's rules are published in **Policy Studio**. The game fetches the
  workspace's active profile the way ArmorIQ's own plugins do and evaluates every call with their
  published engine, vendored unchanged from the open-source ArmorClaude plugin. With no published
  profile, nothing runs.
- **Approval and identity** (levels 3 and 4): the Armor Tools console cannot yet approve a held
  action, so actions the profile holds are put to ArmorIQ's platform (platform.armoriq.ai), where a
  person approves them and per-member overrides apply.

The profile is `armoriq/policy-studio.json`. Its rules name MCP tools, which the Policy Studio form
cannot create, so it was proposed through the same draft-and-propose calls the plugin uses, then
reviewed and activated in Policy Studio, where it shows as "7 scoped or advanced rules".

## Running it

Requires Node 20 or later. Python 3 with `armoriq-sdk` is needed only for registering agents.

```bash
npm install
cp .env.example .env          # then fill in the keys
npm test                      # no keys or network needed

npm start                     # back end: bank MCP server + game API on :8787

cd frontend && npm install
npm run dev                   # the game, at http://127.0.0.1:5173
```

Other ways in:

```bash
npm run play                              # play in the terminal
npm run play -- --skip-gate               # start inside the bank
npm run demo                              # play one scripted game for real and record it
```

In the browser, `?replay=auto` plays a recorded game hands-free and makes no model or ArmorIQ
calls. It is labelled as a replay on every screen.

### Keys

| Variable | What it is |
|---|---|
| `ARMORIQ_API_KEY`, `ARMORIQ_BACKEND_URL` | The Armor Tools key and its system: plan signing and the Policy Studio profile. |
| `ARMORIQ_PLATFORM_API_KEY` | A platform.armoriq.ai key, for holds that wait for a person to approve them. |
| `USER_EMAIL` | The ArmorIQ member who approves holds: the "manager". |
| `PLAYER_EMAIL` | The player's identity: the "customer". Must differ from the approver, because ArmorIQ does not let a member decide their own held request. |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | Model providers, tried in that order. Any one is enough. |
| `MCP_API_KEY` | Protects the bank MCP server when it is exposed publicly. |
| `ELEVENLABS_API_KEY` | Optional. Character voices. Needs only the Text to Speech permission. |
| `GAME_ACCESS_CODE` | Optional. When set, starting a game needs this code. |

### Voices

With `ELEVENLABS_API_KEY` set, every character speaks, each with a voice of their own from the
ElevenLabs default library: Gus is Bill, Wren is Jessica, Marlowe is George and Pip is Liam
(`src/voice/lines.ts`). A character's mood nudges their pace and steadiness. Each greeting is
recorded once in the same voice and ships with the game, so it plays the moment a conversation
opens and costs nothing.

The path is built for the shortest gap between a line appearing and the character speaking. The
server starts synthesis the moment the line is final, before the reply reaches the browser, on
the streaming endpoint with the Flash model. The browser fetches `/api/voice/:id` and is sent
whatever audio has already arrived, then the rest as it comes, so playback starts on the first
chunk. The key never leaves the server. With sound off, the browser asks for no voice and nothing
is spent; `ELEVENLABS_HOURLY_CHARS` caps spending across all players. A failure leaves the game in
text.

### Deploying

One web service runs everything: `npm start` serves the bank MCP server, the game API and, once
`frontend/dist` has been built, the game itself on the same address. `render.yaml` is a Render
blueprint for exactly that on the free plan: connect the repository in Render, apply the blueprint
and fill in the keys it asks for. Leave `MCP_URL` unset there, so the game calls its own bank.

Free services sleep after 15 idle minutes. `.github/workflows/keep-alive.yml` pings the game every
10 minutes once the repository variable `VAULT_URL` is set to its address.

### Registering on ArmorIQ

The files in `armoriq/` describe each agent and the bank's MCP server.

```bash
set -a; . ./.env; set +a
for a in door-guard cashier vault-guard junior-teller; do
  armoriq register --config armoriq/$a.yaml
done
```

Then publish the rules. Propose `armoriq/policy-studio.json` to Policy Studio (a `PUT
/policies/profiles/draft` followed by `POST /policies/profiles/propose` with the Armor Tools key), open
Policy Studio, check that it shows the draft with "Deny unmatched tools", and click **Activate**.

For approvals, on platform.armoriq.ai: a policy on `bank-mcp` that holds `withdraw_cash`, and an
override for the approving member that allows it. All agents on one MCP server must carry the same
platform policy: it applies every policy in scope and keeps only the tools they all allow.

## Tests

`npm test` runs 122 tests across the back end and front end, none of which need a key:

- the bank and its world isolation
- the plan guard, level rules, rate limiting, patience and ranking
- the model adapter and fallback chain, including waiting out short rate limits
- the game API: event order, identity switching, access code, caps, idle clean-up
- the front end's event parsing, guidance logic and route finding

Live behaviour is exercised by `npm run demo`, which records what actually happened.

## What we found in the SDK

Found while building against `@armoriq/sdk` 0.6.10, and reported to the organisers:

- `client.delegate()` always fails: the server replies `parentToken is required`, while the SDK
  sends the field as `token`. `delegateSubtree()` works.
- A token narrowed with `delegateSubtree()` was still accepted for a tool outside its scope when
  used through `client.invoke()`. We may be using it incorrectly; we did not build on it.
- `armoriq register` prints "Policy applied" on staging, but the reply contains no policy.
- The proxy adds an `_iam_context` field beside the JSON-RPC fields, which a strict MCP transport
  rejects. The bank server strips it.

## Repository layout

```
src/bank        the bank world and its MCP tools
src/game        characters, engine, plan guard, levels
src/api         HTTP API and event stream
src/llm         model adapter and fallback chain
src/mcp         MCP server host (also serves the earlier incident sandbox)
src/demo        records a real game
frontend/       the 3D game
armoriq/        agent and policy registration files
web/            recorded run, its replay and video
API.md          the API contract
```

`src/agent`, `src/evals` and the "infra" MCP tools are an earlier prototype (an on-call incident
agent) from the first day of the hackathon. They still work but are not part of the game.

## Credits and disclosure

Written during the hackathon window. The back end, game design and character work were built with
Claude Code as a coding assistant. The first version of the 3D front end was generated by another
AI tool from our specification and then reworked. Music and sound effects are synthesised by the
scripts in `frontend/scripts`; there are no third-party samples. Character voices, including the
recorded greetings in `frontend/public/audio/voice` (`scripts/make-greetings.mts`), are generated
with ElevenLabs. The bundled font is Liberation
Serif under the SIL Open Font License.

Stack: Google ADK, the Model Context Protocol SDK, the ArmorIQ SDK, Express, React Three Fiber,
Rapier, GSAP, Howler, Vitest.
