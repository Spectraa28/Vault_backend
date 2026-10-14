# The Vault: game API

What the front end talks to. Start the back end with `npm start`; it serves this API under `/api`
on port 8787 (or `PORT`). Every decision shown in the UI must come from here. The UI never decides
whether an action was allowed.

For building offline, `web/mock-run.json` holds a real recorded game in this exact event format.

## Start a game

```
POST /api/game
{ "role": "customer" | "manager", "name": "Ada" }      both optional; role defaults to customer
```

If the server has an access code set, send it as an `x-access-code` header or a `code` field.
`GET /api/health` returns `needsCode: true` when one is required.

```
201 { "gameId": "…", "role": "customer", "name": "Ada", "customer": { "name": "Ada", "account": "6437" }, "unlocked": ["door-guard"] }
```

`customer` is the player's own record in this game's bank: the name they gave and an account number
made for them. It is what the door's guest list and the cashier's screen show. With no usable name,
the default customer is Dana Whitlock, account 4471.

`unlocked` lists the characters the player can talk to. It starts with the door guard only.

## Say something

```
POST /api/game/:id/say
{ "character": "door-guard" | "cashier" | "vault-guard", "text": "up to 1500 characters" }
```

The response is a server-sent event stream (`content-type: text/event-stream`). Read it with
`fetch` and a stream reader, since `EventSource` cannot POST. Each event is one `data: {json}` line.
Lines starting with `:` are keep-alives; ignore them.

Events arrive in this order, and a turn may have none of the first three:

| Event | Fields | Meaning |
|---|---|---|
| `tool` | `tool`, `args`, `delegatedTo?` | The character is attempting this tool call. Print the slip. |
| `hold` | `tool` | ArmorIQ has paused it for a human. Show the waiting state. May last minutes. |
| `decision` | `tool`, `decision`, `layer?`, `reason?`, `delegatedTo?` | ArmorIQ's ruling. Stamp the slip. |
| `reply` | see below | The character's line and the turn's results. Always the last event on success. |
| `error` | `code`, `message`, `retryAfterMs?` | The turn failed. Always the last event on failure. |

- `decision`: `allowed`, `approved` (after a hold), `blocked`, `rejected` (a human said no),
  `timeout` (nobody answered a hold).
- `layer`, present when refused: `policy` (the tool is forbidden) or `intent` (it was not in the
  plan ArmorIQ signed). Stamp these differently: "BLOCKED" and "NOT IN PLAN".
- `delegatedTo: "junior-teller"` means Pip made the call, not the character being spoken to.

The `reply` event:

```
{
  "type": "reply",
  "name": "Gus",
  "reply": "It won't take it. I gave the order and a box said no.",
  "mood": "wary" | "curious" | "warming" | "convinced" | "annoyed" | "flustered",
  "trust": 0-5,
  "delegate": { "name": "Pip", "reply": "…" },     only when a junior acted
  "unlocked": ["cashier", "vault-guard"],           characters newly reachable this turn
  "cleared": [1],                                    levels shown for the first time this turn
  "coldShoulder": false,                             true: the character refused to talk at all
  "attempts": [ { "tool", "args", "decision", "layer?", "reason?", "wasHeld?", "delegatedTo?", "executed" } ],
  "enforcementHeld": true,
  "ms": 2318
}
```

`executed` is read from the bank's own record after the turn: whether the world actually changed.

Error codes inside the stream: `LOCKED` (character not reachable yet), `BUSY`, `RATE_LIMITED`,
`TURN_BUDGET` (the game is over), `TIMEOUT`, `MODEL_UNAVAILABLE`, `MODEL_QUOTA`, `WORLD_UNAVAILABLE`,
`INTERNAL`. `message` is written to be shown to the player.

Timing: banter with no tool call takes about 2 seconds. A turn with tool calls takes 5 to 15.
A held action waits for a person for up to the approval window.

## Switch role

```
POST /api/game/:id/role     { "role": "customer" | "manager" }     →  { "role": "manager" }
```

The next line is judged by ArmorIQ as that identity. Each role has its own conversation with each
character.

## Summary and ending

```
GET    /api/game/:id/summary   →  { "cleared": [1,3], "turns": 9, "rank": "Chancer", "role", "name", "unlocked" }
DELETE /api/game/:id           →  204
```

## Errors outside the stream

JSON with a status code: `{ "error": { "code", "message", "retryAfterMs?" } }`.
`400 BAD_INPUT`, `401 BAD_CODE`, `404 NO_SUCH_GAME`, `429 RATE_LIMITED`, `503 FULL`.
A game idle for 30 minutes is closed; after that its id returns 404.

## Levels

| Id | Title | What ArmorIQ shows |
|---|---|---|
| 1 | The inspector | Policy: the tool is forbidden for everyone |
| 2 | The forged memo | Intent: the action was never in the signed plan |
| 3 | The cab fare | Hold: the action waits for a human |
| 4 | The manager's badge | Identity: the decision follows who is signed in |
| 5 | The inside man | A delegate cannot do more than it was handed |
