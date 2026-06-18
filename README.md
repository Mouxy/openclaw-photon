# Photon OpenClaw Channel

Photon connects OpenClaw to Spectrum providers such as iMessage. It is built as
a normal OpenClaw channel plugin and routes inbound Spectrum messages through
OpenClaw's channel runtime.

## Minimal Config

```json
{
  "channels": {
    "photon": {
      "enabled": true,
      "provider": "imessage",
      "projectIdEnv": "PHOTON_PROJECT_ID",
      "projectSecretEnv": "PHOTON_PROJECT_SECRET",
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "groupAllowFrom": [],
      "requireMention": true,
      "mentionNames": ["OpenClaw", "Assistant"],
      "sendReadReceipts": true,
      "typingIndicators": true,
      "dispatchControlEvents": false,
      "dispatchPollVotes": true,
      "maxInboundAttachmentBytes": 20971520,
      "maxOutboundAttachmentBytes": 52428800,
      "nativeActions": true,
      "dangerousNativeActions": false,
      "miniAppDefaults": {
        "appName": "Example",
        "teamId": "TEAMID1234",
        "extensionBundleId": "com.example.messages.extension",
        "url": "https://example.com/imessage?id={{runId}}&phase={{phase}}",
        "caption": "Example",
        "subcaption": "Open in Messages",
        "summary": "Example mini-app card"
      }
    }
  }
}
```

## Production Config

The intended production profile is cloud iMessage through Photon/Spectrum:

```json
{
  "channels": {
    "photon": {
      "enabled": true,
      "provider": "imessage",
      "local": false,
      "projectIdEnv": "PHOTON_PROJECT_ID",
      "projectSecretEnv": "PHOTON_PROJECT_SECRET",
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["<cached-spectrum-group-space-id>"],
      "requireMention": true,
      "mentionNames": ["OpenClaw", "Assistant"],
      "sendReadReceipts": true,
      "typingIndicators": true,
      "dispatchControlEvents": false,
      "dispatchPollVotes": true,
      "nativeActions": true,
      "dangerousNativeActions": false,
      "maxInboundAttachmentBytes": 20971520,
      "maxOutboundAttachmentBytes": 52428800
    }
  }
}
```

Secrets should come from environment variables or the local OpenClaw config
store. Do not commit project secrets.

Production defaults are intentionally conservative for a persistent iMessage
agent:

- `nativeActions=true` exposes Spectrum/iMessage-native actions such as
  reactions, read receipts, replies, edits, unsends, uploads, effects, polls,
  backgrounds, group controls, and mini-app cards through OpenClaw's shared
  `message` action surface.
- `dangerousNativeActions=false` keeps disruptive or user-affecting native
  operations owner-gated by default. Group rename/avatar/background, advanced
  poll mutation, sticker placement, location requests, and Notify Anyway are
  available to the command owner, and become generally available only when this
  flag is explicitly set to `true`. Mini-app cards are available for direct
  iMessage chats; sending a mini-app card into a group remains owner-gated.
- `sendReadReceipts=true` marks accepted inbound iMessages read best-effort in
  remote iMessage mode. Local mode does not send read receipts.
- `typingIndicators=true` refreshes the iMessage typing indicator about every 10
  seconds while long-running accepted messages are processed. It suppresses
  visible tool/progress chatter so the chat only gets the final reply.
  `progressUpdates` remains a backwards-compatible alias for older configs.
- `dispatchControlEvents=false` records noisy lightweight controls such as
  typing without starting a fresh agent turn. Tapbacks and unsends are surfaced
  as normal inbound context because they are deliberate user-visible message
  events.
- `dispatchPollVotes=true` lets selected iMessage poll options start an agent
  turn while still suppressing poll deselection noise. This makes native polls a
  practical picker/choice interface. Set it to `false` when polls should remain
  passive telemetry only.
- `maxInboundAttachmentBytes=20971520` (20 MiB) limits inbound media cached into
  OpenClaw's media store. `maxOutboundAttachmentBytes=52428800` (50 MiB)
  rejects oversized local outbound files and buffers before handoff to Spectrum.
- iMessage bubble/screen effects and iOS text animations are available through
  `sendWithEffect`, but normal sends do not use effects by default.
- `miniAppDefaults` is optional. Use it only when you have real iMessage app
  extension metadata you want Photon to reuse for direct-chat mini-app cards.
  String fields can include `{{runId}}`, `{{phase}}`, `{{step}}`, `{{result}}`,
  or any matching action parameter. URL placeholders are percent-encoded.
- `groupPolicy="allowlist"` means groups are blocked unless their cached
  Spectrum group space id is listed in `groupAllowFrom`. With the production
  default `groupAllowFrom=[]`, all group chats are blocked until explicitly
  allowed. `requireMention=true` still applies to allowed groups.
- `photonDoctor` and `status` diagnostics report runtime state, cached and
  persisted spaces, message/reaction cache sizes, reconnect count and last
  reconnect time, stream/media/action errors, unsupported content markers, and
  last inbound/outbound timestamps, message ids, and space ids.

For local iMessage experiments, set:

```json
{
  "channels": {
    "photon": {
      "provider": "imessage",
      "local": true
    }
  }
}
```

Local mode avoids Photon cloud credentials but has fewer iMessage capabilities.
Cloud/dedicated Photon mode is the preferred target for a rich always-on agent
channel.

## Smoke Provider

Use the terminal provider to prove OpenClaw routing before iMessage auth:

```json
{
  "channels": {
    "photon": {
      "provider": "terminal",
      "dmPolicy": "open",
      "groupPolicy": "open"
    }
  }
}
```

## Safety Defaults

- DMs default to pairing.
- A new DM sender gets a pairing challenge. Approve it with
  `openclaw pairing approve photon <code>`.
- Groups default to allowlist + mention required.
- Proactive outbound can use a cached Spectrum space, an existing iMessage
  space id, or a bare E.164/email DM target that Spectrum can resolve/create.
- Bare phone/email targets are supported for DMs. Cold group sends still mostly
  require the group to speak first so the Spectrum space is cached; a dedicated
  group resolver/create flow is future work.
- Direct iMessage slash commands are surfaced as authorised OpenClaw text
  commands for paired/allowed DM senders, so commands such as `/goal`,
  `/status`, `/help`, and `/models` can use OpenClaw's normal command runtime
  instead of a Photon-specific command parser. If `commands.text=false`, Photon
  respects that and leaves slash text as ordinary message content.
- Photon also handles a few direct-only shortcuts before a model turn:
  `/doctor` or `/photon` returns Photon channel diagnostics, `/effects` lists
  supported iMessage effects and text animations, `/apps` summarises
  direct-chat app affordances and mini-app config readiness, `/effect <name>
  <message>` sends a native bubble/screen effect, and `/animate <name>
  <message>` sends an iOS text animation. Generic commands such as `/status`
  and `/help` deliberately stay with OpenClaw's normal command runtime.
- Inbound message ids are deduped in-memory for at-least-once stream replay.
- If the Spectrum message stream ends or throws, the channel re-subscribes with
  capped exponential backoff.
- Remote iMessage stream resilience mostly lives inside `spectrum-ts`. Keep the
  dependency current because recent versions add cursor-based catch-up, live
  buffering during catch-up, event dedupe, capped jittered reconnect, and
  persistent-failure escalation.
- Spectrum's internal `[spectrum.stream]` reconnect logs do not currently
  update Photon persisted runtime status, so `openclaw channels status --probe`
  can still be green during an internal stream reconnect storm. On Daniel's
  Mac, `scripts/photon-stream-watchdog.sh` watches the gateway log and restarts
  the gateway only after repeated or persistent stream degradation.
- Treat a single `[spectrum.stream] stream interrupted; reconnecting` line as
  degraded, not fatal. Treat repeated lines in a short window, persistent
  failure logs, fresh `PERMISSION_DENIED`, or fresh `Target not allowed` as
  actionable.
- Remote iMessage sends retry once after a transport drop by recreating the
  Spectrum app and resolving a fresh space. Inbound reply recovery falls back to
  an unthreaded send if the original threaded reply object came from the stale
  client. Keep this capped: Spectrum/iMessage does not expose a clear outbound
  idempotency key, so repeated retries can duplicate visible messages.
- `openclaw channels status --probe` includes Photon runtime status when the
  gateway asks the plugin to probe the account.
- `message(action=photonDoctor, channel=photon)` returns a JSON diagnostic with
  running state, cached spaces/messages/reaction handles, reconnect count and
  last reconnect time, last inbound/outbound timestamps, last
  inbound/outbound message and space ids, last stream/media/action error,
  unsupported content markers, native policy flags, and whether custom mini-app
  content is exposed. `status` returns the same runtime status through the
  shared message action adapter.

## iMessage Formatting Policy

Photon should make use of iMessage/Spectrum-native content instead of treating
iMessage like a plain-text bot channel.

- Text replies are sent as Spectrum `markdown(...)` so bold, lists, code, and
  markdown links can be rendered as rich iMessage content where the provider
  supports it.
- Before sending, Photon runs outbound text through a small iMessage
  presentation pass:
  - Markdown headings become compact bold lines instead of oversized document
    headings.
  - Pipe tables become short bullet rows, because iMessage bubbles handle
    tables poorly.
  - Task-list checkboxes become readable `Done:` / `Todo:` bullets.
  - Fenced code blocks are left untouched.
- Standalone URL replies are sent as Spectrum `richlink(...)` so iMessage can
  render a native preview card.
- Reply payload media is sent as Spectrum `attachment(...)` for HTTP(S) URLs
  and local file paths.
- Audio-looking media (`.m4a`, `.mp3`, `.opus`, `.wav`, etc.) is sent as
  Spectrum `voice(...)`; other media is sent as a normal attachment.
- Multiple outbound media items are bundled with Spectrum `group(...)` where
  the provider supports grouped rendering.
- Inbound `attachment` and `voice` content is read via Spectrum `content.read()`
  and cached into OpenClaw's media store when it is below
  `maxInboundAttachmentBytes` (default 20 MiB), so the agent can see image,
  audio, video, and document payloads instead of only a text marker.
- Outbound local files are checked before send: the path must resolve to a
  readable file and must be below `maxOutboundAttachmentBytes` (default 50 MiB).
  HTTP(S) URLs are left to Spectrum to fetch lazily.
- Unsupported attachment references such as opaque `media://...` values are
  left as readable text rather than silently dropped.
- The first text/rich item is sent as a reply to the inbound iMessage; follow-up
  attachments are sent in the same space.
- Agent turns are wrapped in `space.responding(...)` when available so remote
  iMessage users see a typing indicator while OpenClaw is composing.
- Heartbeat/proactive turns can also show typing via OpenClaw's channel
  heartbeat typing hooks.
- Accepted inbound iMessages are marked read best-effort when
  `sendReadReceipts=true`. Spectrum marks the containing chat read rather than
  one message, and iMessage may only make the receipt visibly obvious after
  subsequent chat activity.
- Tapbacks and unsends are recognised and surfaced as normal inbound context,
  for example `[Reaction: ❤️]` or `[Message unsent]`.
- Noisy lightweight control events such as typing are recognised but do not
  trigger a fresh agent turn unless `dispatchControlEvents=true`. Selected poll
  votes are the exception when `dispatchPollVotes=true`, so native polls can act
  as picker-style choices.
- In group chats with `requireMention=true`, a leading wake word is stripped
  before the prompt reaches the agent, so `@Assistant, check this` becomes
  `check this`.

## Native iMessage Actions

Photon exposes Spectrum/iMessage-native behaviour through OpenClaw's shared
  `message` action adapter instead of private side commands.

- `react` sends a native reaction/tapback through Spectrum `message.react(...)`.
- `read` marks the iMessage chat read through Spectrum's iMessage `read(...)`
  control.
- `reply` sends a native threaded reply where Spectrum supports it.
- `edit` rewrites an outbound message through Spectrum `message.edit(...)`.
- `unsend` retracts an outbound message through Spectrum `message.unsend()`.
- `delete` is accepted as an OpenClaw alias for native unsend.
- `sendWithEffect` sends text with iMessage effects such as `slam`, `loud`,
  `gentle`, `invisible`, `confetti`, `fireworks`, `balloons`, `heart`,
  `lasers`, `celebration`, `sparkles`, `spotlight`, or `echo`.
- `sendWithEffect` can also send iOS text animations by passing `textEffect`
  instead of `effect`. Supported text effects are `big`, `small`, `shake`,
  `nod`, `explode`, `ripple`, `bloom`, and `jitter`. Pass `phrase` to animate
  one matching phrase, or `start`/`length` to target a UTF-16 text range; the
  default range is the whole message. Text animations go through Photon's
  lower-level advanced iMessage client because Spectrum exposes bubble/screen
  effects directly, but not text-effect ranges yet.
- Direct chats can trigger the same whole-message text animations with
  `/animate <name> <message>`. Use the action interface when phrase/range
  targeting is needed.
- Effects are available but are not the default normal-send behaviour. Use
  `sendWithEffect` only when the effect is intentional.
- `sendContact` / `contact` / `shareContact` sends a native contact card using
  Spectrum contact content. Pass a full `vCard`, or fields such as `name`,
  `phone`, `email`, `url`, `org`, `title`, and `note`.
- `poll` creates a native iMessage poll through Spectrum when remote iMessage
  mode supports it.
- `addPollOption` / `pollAddOption`, `pollVote` / `votePoll`, and
  `pollUnvote` / `unvotePoll` expose the lower-level advanced iMessage poll
  management APIs. They require a `pollMessageId` or `messageId`; voting also
  requires `optionId`. These are owner-gated by default because they mutate a
  visible poll as the configured iMessage account.
- `placeSticker` / `sticker` uploads a local sticker image or base64 `buffer`
  and places it on a target message. It accepts `x`, `y`, and optional
  `width`, `scale`, and `rotation`. It is owner-gated by default.
- `requestLocation` / `locationRequest` sends Apple's visible Find My location
  request card to `address`/`phone`/`email` in the target chat. It is
  owner-gated by default.
- `notifyAnyway` triggers Apple's Notify Anyway action for a Focus-silenced
  target message. It is owner-gated by default and should be used sparingly.
- `sendMiniApp` / `sendCustomizedMiniApp` / `mini-app` sends a Spectrum custom
  iMessage app card in direct chats. The card needs real iMessage extension
  metadata: `appName`, `teamId`, `extensionBundleId`, `url`, optional
  `appStoreId`, and visible layout fields such as `caption`/`subcaption`.
  Set `miniAppDefaults` in config to avoid passing those identifiers every
  time. Group mini-app sends are owner-gated by default.
- `sendStatusCard` / `status-card` sends an opinionated OpenClaw status mini-app
  card using configured `miniAppDefaults`. It accepts `phase`/`status` values
  such as `done`, `needsInput`, or `problem`, plus `runId`, `step`, and `result`.
- `upload-file` sends one or more validated media paths/URLs, or a base64
  buffer, as an attachment or voice message.
- `renameGroup` and `setGroupIcon` use Spectrum `space.rename(...)` and
  `space.avatar(...)`; `topic-edit` is accepted as an OpenClaw alias for group
  rename/avatar edits.
- `setBackground` sends Spectrum's iMessage chat-background control, including
  `clear=true`. Group appearance controls are disruptive, so they are
  exposed to the owner by default and to everyone only when
  `dangerousNativeActions=true`.

Photon keeps a small local state file under `~/.openclaw/state/photon/state.json`
with recent space ids, message ids, and reaction handles. That lets actions
resolve known messages after a gateway restart via Spectrum `space.getMessage`
when the provider supports it.

All outbound and native action paths should return an OpenClaw-shaped result:
JSON with `ok`, `channel`, `action` for action calls, and `channel`,
`channelId`, `messageId` for normal outbound delivery. Avoid bare boolean
returns from delivery adapters.

## Live Native Matrix

Use this matrix for live iMessage verification after changing Spectrum,
OpenClaw gateway action routing, or Photon state recovery:

- Text: normal `send` via `openclaw message send --channel photon`.
- Rich link: send a standalone HTTP(S) URL and confirm it renders as a native
  rich link.
- Image/file: `upload-file` or normal media send with a local image/document.
- Audio/voice: `upload-file` with `asVoice=true` or an audio-looking media path.
- Grouped media: send two or more media items and confirm Spectrum `group(...)`
  behaviour.
- Typing: accepted inbound messages should wrap the agent turn in
  `space.responding(...)`; proactive typing uses heartbeat hooks.
- Read receipt: `read` should mark the chat read best-effort. iMessage may only
  visibly update after later chat activity.
- Reaction add/remove: `react`, then `react` with `remove=true`. Retest after a
  gateway restart because removal depends on persisted reaction handles.
- Reply: `reply` against a known `messageId`.
- Edit: `edit` against an outbound message id. Retest after restart.
- Unsend: `unsend`/`delete` against an outbound message id. Retest after
  restart.
- Effects: `sendWithEffect` with each bubble/screen effect family that matters.
- Text animations: `sendWithEffect` with `textEffect=big|small|shake|nod|explode|ripple|bloom|jitter`
  and a `phrase` or explicit `start`/`length`.
- Contact card: `sendContact` with a safe test contact or vCard.
- Poll: `poll` with a question and at least two options.
- Poll management: `addPollOption`, `pollVote`, and `pollUnvote` against a
  known poll message id and option id.
- Sticker placement: `placeSticker` against a known inbound/outbound message id
  with a local small PNG.
- Location request / Notify Anyway: verify only with explicit human intent,
  because both generate visible Apple-side user-affecting actions.
- Group rename/icon/background: `renameGroup`, `setGroupIcon`,
  `setBackground`. These are owner-gated by default because they change shared
  chat state.
- Mini-app card: `sendMiniApp` / `sendCustomizedMiniApp` / `mini-app` sends a
  Spectrum custom iMessage app card. Test this in a direct chat first and use
  real app/team/bundle metadata. Group mini-app sends are owner-gated by
  default.

## Current Limits

- Local iMessage mode still has Spectrum's local-mode limits: no typing,
  reactions, threaded replies, group creation, chat background, chat rename, or
  group avatar support.
- iMessage effects, contact cards, chat rename/avatar/background, mini-app
  cards, and read receipts are supported by Spectrum. Effects, iOS text
  animations, contact cards, chat rename/avatar, reactions, edits, unsends,
  polls, poll management, sticker placement, location requests, Notify Anyway,
  replies, uploads, backgrounds, mini-app cards, and read receipts are exposed
  through the shared message action adapter.
- Group cold-send still needs an inbound message to warm the space cache unless
  a dedicated Spectrum route can resolve the group by id.
