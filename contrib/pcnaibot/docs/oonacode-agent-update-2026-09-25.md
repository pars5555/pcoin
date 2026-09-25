# OonaCode agent API update for pcnaibot — 2026-09-25

The owner reported two problems with @PcoinAiBot: it could not generate an image properly, and
switching the model wiped the conversation. This note explains both causes, the fixes on OonaCode's
side and in `contrib/pcnaibot` (pcoin commit `9473110`), and what to build on and test next.

## What went wrong

Read from the agent transcript of the owner's chat (on `glm-5.3-flash`):

- **The sandbox had no way to make a picture.** Asked for "realistic picture cat on dron flying over
  dogs", the agent scraped Wikimedia Commons (and was rate-limited by it), fought pip
  (`externally-managed-environment`, then a numpy upgrade that broke SciPy), cut a stock drone out
  with OpenCV and pasted a stock cat on it — about 20 minutes, and a collage. An earlier DeepSeek
  session drew an SVG by hand for the same reason.
- **The bot's instructions went into every user message.** The agent API had no system-prompt
  field, so the bot appended "(Note: you are the assistant behind the PCoin AI Telegram bot…)" to
  each message.
- **Switching the model deleted the session.** The bot retired the session on every switch,
  believing a session keeps the model it was created with. The history and workspace files went
  with it. In fact a run that names a model switches the existing session.

## OonaCode agent API — what you can use now

1. **`system`** on `POST /v1/agent/sessions` and on runs: appended to the agent's own system
   prompt and kept on the session, so later runs need not repeat it. A new value replaces the old
   one; an empty string clears it. The engine restarts only when the text changes.
2. **`model` on any run switches the same session.** Send the user's current model on every run.
   The engine cold-starts on the new model and resumes the stored history (trimmed to the new
   model's context window if needed). Workspace files stay. Only deleting the session starts over.
3. **Real images and video inside a run.** The agent has three new tools, used automatically when
   a user asks for a picture or a video. Files are saved into the workspace, where the bot already
   picks them up.

   | Tool | What it does | Models |
   | --- | --- | --- |
   | `generate_image` | Text-to-image, or edits/combines workspace images (`input_images`). PNG. | `qwen-image-3.0-pro` (default, photorealistic, best text), `wan2.7-image-pro` (up to 4K), `wan2.7-image` |
   | `generate_video` | Text-, image- (first frame) or reference-to-video, with audio. Waits up to 8 min, then saves the MP4. Defaults: 720P, 5 s. | `happyhorse-1.1-t2v` / `-i2v` / `-r2v` |
   | `check_video` | Finishes a video that took longer than the wait. | — |

   Every image's and video's cost is included in the run's `credits`. A failed one is not charged.
4. **`effort`** on a run: `low`, `medium`, `high`, `xhigh`, `max`, `ultracode` — checked against the
   model's own levels (a `400` names the ones it takes).
5. **The agent never waits for a person.** Every tool permission is allowed at once; a question the
   model tries to ask is declined immediately ("decide for yourself and say what you chose").
6. **Faster, sturdier runs.**
   - The engine stays warm between runs of a session: a second run took 1.3–5 s on dev (before,
     every run restarted the engine and replayed the history).
   - A server deploy during a run is ridden out (retries for up to 150 s) instead of failing it.
   - A session left "running" by a gateway restart is freed at startup — no more endless
     `agent_session_busy`.
   - A run stopped by its deadline or a dropped stream keeps its transcript and text.
   - A reused sandbox gets the current model list on every run.
7. **Cheaper long conversations on every model.**
   - **The prompt is about 3,200 tokens smaller on every request, on every model.** Claude Code's
     own "auto memory" was on: 12,841 characters of instructions in every system prompt, plus tool
     calls in which the model saved "memories". Each run's engine configuration is thrown away
     afterwards, so those memories were never read. It is now off (OonaCode 0.3.145). To keep facts
     across runs, use `system` (item 1), or have the agent write a file in the workspace.
   - **Claude models keep their prompt cache for an hour** instead of five minutes (subscription
     lane). A Telegram user who answers after ten minutes no longer makes the whole conversation
     be written to the cache again at the full cache-write price. Other vendors cache on their own:
     measured on production over 7 days, 94–96 % of prompt tokens were cache hits on Opus, Grok,
     MiMo, GLM, Qwen and DeepSeek alike.
   - Claude's claude.ai Artifact tools are off in every run.
8. **Users and sessions share nothing.** Every agent session has its own sandbox container,
   volume and network. Each engine start gets a fresh configuration directory, deleted when it
   closes. The engine never holds OonaCode's provider credentials, and the only Anthropic calls
   it can reach are messages, token counting and the model list. So no files, skills, settings or
   memory are kept on the shared Claude account, and one user's session cannot see another's.
   Workspace files belong to their session alone.
9. **A fuller sandbox toolbox.** Preinstalled: OpenCV 4.6, SciPy, pandas, requests, BeautifulSoup,
   lxml, openpyxl, python-docx, reportlab, `rsvg-convert`, a colour emoji font — besides Pillow,
   numpy, matplotlib, ImageMagick and ffmpeg. `pip install` works without flags (user site) and so
   does `npm install -g`.
10. **Direct media endpoints for API keys** (kind `api`): `POST /v1/images/generations` (OpenAI Images
   shape), `POST /v1/videos`, `GET /v1/videos/{id}`. Result URLs are valid for 24 hours. Schema:
   https://api.oonacode.oonak.ai/api/docs

## Changes in the bot (pcoin `9473110`)

- **A model switch keeps the conversation.** `bot.mjs` no longer retires the session on a switch: it
  records the new model with `setSessionModel` (new in `lib/agentstore.mjs`) and sends `model` on
  every run. `/clear` still starts over. The model menu now says "The conversation continues on the
  new model — its history and files are kept."
- **The note is now `system`.** `lib/agent.mjs` `streamRun` takes `system`; `bot.mjs` sends the old
  note there instead of appending it to the user's message, with one new line: use
  `generate_image` / `generate_video` for any picture or video, never stock photos or code drawings.
  The step-budget sentence moved with it.

## Verified on dev

- The owner's exact request through the agent API on `glm-5.3-flash`: a real photorealistic image
  (a goggled cat riding a drone over three dogs) in 100 s, 56.6 credits including the image.
- Then, in the same session, switched to `deepseek-v4-flash` and asked about the previous message:
  "You asked for a realistic picture of a cat on a drone flying over dogs, and I made
  cat-drone-over-dogs.png."
- Earlier the same day: a tool-using task completed on 8 models (Claude Sonnet 5, Claude Opus 5.5,
  Grok 4.6, GLM-5.3 Flash, MiMo v2.6 Flash, DeepSeek V4 Flash, GPT-5 mini, Qwen3.8 Flash).

## What to test next

1. **Pictures across models:** a realistic photo, a logo with text, a poster — the agent should call
   `generate_image` once and answer with the file.
2. **Editing a user's photo:** send a photo, ask for a change; it should be passed as `input_images`.
3. **Video:** a 5-second clip (1–5 minutes); the draft should keep updating and the MP4 arrive. Also
   animate an uploaded photo.
4. **Switching models mid-conversation:** history and files kept; `/clear` starts over.
5. **Costs:** compare `run.credits` with what the bot charges. Video is the expensive case — a 1080P
   15-second clip is about $3.24 at retail; `AGENT_MAX_CREDITS_PER_RUN` may need to allow for it, or
   the bot can ask for 720P.
6. **Cost of a long chat:** a conversation with 10-minute pauses on a Claude model should now bill
   far less per answer than before 2026-09-25, and every model's first answer should be a few
   thousand tokens cheaper. `run.usage.cache_read_input_tokens` and `cache_creation_input_tokens`
   show the cache reads and writes.
7. **Timeouts:** the stream's 180-second idle timeout is reset by the gateway's 15-second heartbeats,
   so a long video call should not cut it; keep the hard stop above 8 minutes for video requests.

## Worth knowing

- Images and video are served by Alibaba's Token Plan today, because OonaCode production holds no
  pay-as-you-go Model Studio key. The plan's terms say it is for interactive use, not application
  backends; the owner accepted that risk for pooled chat and it now covers media too. A
  pay-as-you-go key can be added in the OonaCode admin and becomes the fallback.
- API keys are never served free, not even a model the app offers free on a single lane.
- The bot stores no message text. To debug a conversation, read
  `GET /v1/agent/sessions/{id}/transcript` with the bot's agent key; a deleted session cannot be read.
- Media URLs from the direct endpoints expire after 24 hours; files made inside an agent run stay in
  the workspace as long as the session does.
- OonaCode references: `docs/agentic-api.md` §22–22.2, `docs/media-api.md`.
