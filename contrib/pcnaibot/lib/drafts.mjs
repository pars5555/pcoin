// Live message streaming into Telegram, via sendMessageDraft (Bot API 9.3).
//
// This is Telegram's OWN primitive for exactly this job -- "allowing partial
// messages to be streamed to a user while being generated" -- and it is much
// better than the editMessageText loop everyone reaches for first: edits are
// rate-limited per chat and each one is a real message revision, whereas
// changes to a draft with the same draft_id are ANIMATED client-side.
//
// THREE PROPERTIES THAT SHAPE EVERYTHING BELOW:
//
// 1. A DRAFT IS EPHEMERAL -- about a 30-second preview. It NEVER becomes a
//    permanent message. If we stop refreshing it, it simply vanishes from the
//    chat, and if we never send a real message the user is left with nothing.
//    So the final answer MUST be persisted with an ordinary sendMessage, and
//    the draft must be refreshed often enough that a slow model does not let
//    the preview expire mid-answer.
//
// 2. PRIVATE CHATS ONLY. chat_id must be a numeric private chat. This bot is
//    DM-only anyway, so that costs nothing -- but it means the draft path can
//    never be the only path.
//
// 3. An EMPTY text is legal, and was believed to show a "Thinking..." placeholder.
//    Telegram Web shows NOTHING for it (checked 2026-09-25: an empty draft left the
//    chat blank; a text draft appeared at once). So the first frame is always a
//    real status line -- never ''.
//
// `can_stop: true` gives the user a stop button; pressing it delivers an
// Update carrying `stopped_message_generation` (Bot API 10.3). That update type
// MUST be listed in allowed_updates or it is silently filtered and the button
// does nothing -- allowed_updates persists server-side, so forgetting it fails
// quietly and forever.

import { log } from './log.mjs';
import { telegramLength, TEXT_LIMIT } from './telegram.mjs';

// Telegram's own cap for a message, and therefore for a draft.
export const DRAFT_TEXT_LIMIT = 4096;

// How often to push a new frame. Fast enough to read as live, slow enough not
// to spend the chat's rate limit on characters nobody has read yet.
export const DRAFT_MIN_INTERVAL_MS = 900;

// A draft expires after roughly 30 seconds. Refresh well inside that even when
// the text has NOT changed, or a model that thinks for a minute leaves the user
// staring at a preview that silently disappeared.
export const DRAFT_KEEPALIVE_MS = 12000;

export class DraftStream {
  // `draftId` must be non-zero and stable for the life of one answer: frames
  // sharing an id animate into each other, while a new id starts a new bubble.
  constructor(tg, chatId, draftId, { canStop = true } = {}) {
    this.tg = tg;
    this.chatId = chatId;
    this.draftId = draftId;
    this.canStop = canStop;
    this.lastPushAt = 0;
    this.lastText = null;
    this.failed = false;
    this.supported = true;
    // How many frames actually reached Telegram, as opposed to how many were
    // offered. The gap between the two IS the throttle, and it is the number
    // anyone asking "was it incremental?" actually wants.
    this.pushes = 0;
    this.offered = 0;
  }

  // Push a frame if enough time has passed, or if the draft is close enough to
  // expiring that it needs a keepalive regardless of whether anything changed.
  async maybePush(text, { force = false } = {}) {
    if (this.failed) return;
    const now = Date.now();
    const changed = text !== this.lastText;
    const dueForChange = changed && now - this.lastPushAt >= DRAFT_MIN_INTERVAL_MS;
    const dueForKeepalive = now - this.lastPushAt >= DRAFT_KEEPALIVE_MS;
    this.offered++;
    if (!force && !dueForChange && !dueForKeepalive) return;
    await this.push(text);
  }

  async push(text) {
    if (this.failed) return;

    // A draft is capped like a message. Once an answer outgrows that, show the
    // TAIL -- the part still being written -- rather than a frozen head. The
    // whole answer is persisted afterwards by sendMessage, so nothing is lost.
    let shown = text;
    if (telegramLength(shown) > DRAFT_TEXT_LIMIT) {
      shown = `...${shown.slice(-(DRAFT_TEXT_LIMIT - 8))}`;
    }

    const res = await this.tg.call('sendMessageDraft', {
      chat_id: this.chatId,
      draft_id: this.draftId,
      text: shown,
      // The callers hand this HTML (escaped text, and an <i>status…</i> line while the agent
      // works). Without the parse mode the tags showed literally: "<i>Reading your file…</i>"
      // sat in the chat for the length of every run (2026-09-14).
      parse_mode: 'HTML',
      can_stop: this.canStop,
    });

    this.lastPushAt = Date.now();
    this.lastText = text;
    this.pushes++;

    if (!res.ok) {
      // Streaming is DECORATION. A gateway that cannot show a live preview must
      // never cost the user their answer, so one failure disables the preview
      // for this turn and the turn carries on to its real sendMessage.
      this.failed = true;
      // An old Bot API, or a chat type that does not support drafts, answers
      // with a method-not-found rather than a transient error. Worth
      // distinguishing so it is not read as an outage.
      if (!res.unknown && /not found|unsupported|BOT_METHOD_INVALID/i.test(res.description || '')) {
        this.supported = false;
        log.warn('sendMessageDraft is unavailable here; falling back to a single final message', {
          desc: res.description,
        });
      } else {
        log.warn('draft push failed; the answer will still be delivered', { desc: res.description });
      }
    }
  }

  // THERE IS DELIBERATELY NO clear(). Read this before adding one back.
  //
  // Telegram has no method that removes a draft -- deleteMessageDraft,
  // clearMessageDraft and removeMessageDraft all answer 404. The only two things
  // that end a draft are its own ~30s expiry and, per the API's own wording on
  // `keep_on_stop`, the bot SENDING A MESSAGE. So the real sendMessage that ends
  // every turn is already the removal mechanism, and nothing else is needed.
  //
  // What used to be here pushed `text: ''` to "clear" it. That is the one thing
  // an empty text does NOT do: property 3 at the top of this file -- an empty
  // text shows a "Thinking..." PLACEHOLDER. So the tidy-up ran after the answer
  // had been delivered and posted a brand-new loading frame underneath it, with
  // a fresh 30-second lifetime, on every single turn. Measured as 4-10 seconds
  // of spinner after each reply, and as two loading indicators at once, because
  // a live draft also drives the header state.
  //
  // Send the answer. That is the clear.
}

// Split a finished answer for persistence. A draft showed a tail; the real
// message must carry the whole thing, in order.
export function finalParts(html, limit = TEXT_LIMIT) {
  if (telegramLength(html) <= limit) return [html];
  return null; // caller uses sendLong(), which splits on real boundaries
}
