// The routing round: every 10 minutes butler gives one window of my new Feishu messages to a fresh agent on the model
// machine, which decides with its tools (see route-tools.mjs) what each live Bridge topic needs to know, and hands it a
// note. How to judge is in the butler-routing skill on Bridge's skill platform, which the agent reads first; butler only
// keeps the clock and the windows (see route-windows.mjs). BUTLER_ROUTING (see config.mjs) is the mode of the windows the
// timer creates: dry-run keeps the notes, on hands them to Bridge. A preview is a window run by hand that only keeps them.
import { handOver } from './route-tools.mjs';
import { spanText, MODE_WORDS } from './route-print.mjs';

// everyMs: how often a round runs. settleMs: how long a message must have been stored before a window takes it, so that
// one being written is not passed over. firstMs: how far back the very first window starts, when there was no router
// before. maxAttempts: how many failed runs of its agent a window gets before it is skipped.
export const DEFAULTS = { everyMs: 600_000, settleMs: 60_000, firstMs: 600_000, maxAttempts: 3 };

// The commands the agent may run, as claude's Bash rules (see commandsOnly in herdr-model.mjs). butler is the wrapper on
// the agent's machine that runs butler's command line where butler lives; ol reads Feishu as me and cannot write.
export const ROUTING_COMMANDS = [
  'butler route messages *',
  'butler route topics',
  'butler route topics *',
  'butler route topic *',
  'butler route note *',
  'ol *',
  'bridge-skill read *',
];
// One line: it goes as a command-line argument. It only keeps the agent to its tools; the rest is the skill's.
export const ROUTING_SYSTEM =
  '你只能用 Bash 运行这几种命令：butler route messages、butler route topics、butler route topic、butler route note、ol 和 bridge-skill read；别的命令和工具都会被拒绝，不要尝试。';
const routingPrompt = (window) =>
  `先用 \`bridge-skill read butler-routing\` 读分派飞书消息的做法，然后分派第 ${window.id} 段时间（${spanText(window, '–')}）里的新消息。`;
// The agent's last words, kept with the window for review; the notes are what it did.
const REPLY_CHARS = 2000;

const message = (e) => e?.message ?? String(e);

export class RouteRounds {
  #timer;
  #round;
  // agent: {ask({system, prompt})}, a claude allowed only ROUTING_COMMANDS. mode: dry-run or on.
  constructor({ store, windows, bridge, agent, mode, now = Date.now, options = {}, log = () => {} }) {
    this.store = store;
    this.windows = windows;
    this.bridge = bridge;
    this.agent = agent;
    this.mode = mode;
    this.now = now;
    this.options = { ...DEFAULTS, ...options };
    this.log = log;
  }

  // A round now, then every everyMs.
  start() {
    this.#timer = setInterval(() => this.tick(), this.options.everyMs);
    this.tick();
  }

  // No round starts after this; resolves once the one under way is done.
  async stop() {
    clearInterval(this.#timer);
    await this.#round;
  }

  // One round; a tick while one runs joins it, as an agent session can outlast the interval. Resolves with the window it
  // routed, or undefined when none needed an agent or the round failed (recorded).
  tick() {
    this.#round ??= this.#routeOnce().finally(() => {
      this.#round = undefined;
    });
    return this.#round;
  }

  async #routeOnce() {
    try {
      if (this.mode === 'on') await this.#handPending();
      const window = this.windows.openWindow() ?? (await this.#nextWindow());
      if (!window) return undefined;
      const after = await this.#run(window, this.options.maxAttempts);
      this.#report(after);
      return after;
    } catch (e) {
      this.store.addError('转交', `分派新消息没有完成，下一轮再试：${message(e)}`);
      return undefined;
    }
  }

  // Notes of on windows that Bridge could not take when the agent wrote them.
  async #handPending() {
    for (const note of this.windows.pendingNotes()) await handOver(this.windows, this.bridge, note);
  }

  // The window after the last one, up to settleMs ago; a stretch with no new message or no live topic needs no agent and
  // is passed over.
  async #nextWindow() {
    const until = this.now() - this.options.settleMs;
    const from = this.windows.cursor() ?? { at: this.now() - this.options.firstMs, id: null };
    if (until <= from.at) return undefined;
    const span = { from, until };
    if (!this.windows.messages(span).length) {
      this.windows.passOver(until);
      return undefined;
    }
    const topics = await this.bridge.topicContext();
    if (!topics.length) {
      this.windows.passOver(until);
      return undefined;
    }
    return this.windows.create({ ...span, mode: this.mode });
  }

  // Runs the window's agent; a failure is counted, and the window skipped after maxAttempts. Returns the window after.
  async #run(window, maxAttempts) {
    try {
      const reply = await this.agent.ask({ system: ROUTING_SYSTEM, prompt: routingPrompt(window) });
      return this.windows.finish(window.id, String(reply ?? '').slice(0, REPLY_CHARS));
    } catch (e) {
      return this.windows.fail(window.id, message(e), maxAttempts);
    }
  }

  // What a timer's window came to, in the journal or, when its agent failed, in the errors.
  #report(window) {
    if (window.state === 'done') {
      const messages = this.windows.messages(window).length;
      const notes = this.windows.notesOf(window.id).length;
      this.log(`分派第 ${window.id} 段（${MODE_WORDS[window.mode]}）：${messages} 条新消息，写了 ${notes} 份摘要`);
      return;
    }
    const what = window.state === 'skipped' ? `试了 ${window.attempts} 次都没有分派完，跳过` : '没有分派完，下一轮再试';
    this.store.addError('转交', `第 ${window.id} 段${what}：${window.error}`);
  }

  // One round by hand over the messages stored after since up to until, whatever the mode: its notes are kept as a
  // preview and never handed over, and the timer's windows are not touched. Resolves with {window, messages, topics,
  // notes, error?}, or {skipped} when no agent is needed.
  async preview({ since, until }) {
    const span = { from: { at: since, id: null }, until };
    const messages = this.windows.messages(span).length;
    if (!messages) return { skipped: '这段时间没有新消息' };
    const topics = (await this.bridge.topicContext()).length;
    if (!topics) return { skipped: '没有进行中的话题' };
    const window = await this.#run(this.windows.create({ ...span, mode: 'preview' }), 1);
    const notes = this.windows.notesOf(window.id);
    return { window, messages, topics, notes, ...(window.state === 'skipped' && { error: window.error }) };
  }
}
