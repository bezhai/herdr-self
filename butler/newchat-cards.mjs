// The cards of a new group, in my direct chat with the bot: the proposal (why, which project and agent config, the first
// prompt, 交给 Agent and 不用) and what it turns into after a click; and the root message of the topic Bridge opens in the
// group. The copy is decided in the spec (.local/prd/requirement-group-start.md) and used as written. Text from the model
// and from the group is always plain text (see cards.mjs); the only link is butler's, to the group, in a button's link
// property.
import { plain } from './cards.mjs';

const GREY = { text_size: 'notation', text_color: 'grey' };
// Where the group opens in Feishu, by its open chat id.
export const groupLink = (openChatId) =>
  `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(openChatId)}`;

const card = (title, template, elements, summary) => ({
  schema: '2.0',
  config: { update_multi: true, summary: { content: summary ?? title } },
  header: { title: { tag: 'plain_text', content: title }, template },
  body: { vertical_spacing: '12px', elements },
});
// A button that sends its value back to butler: do is start or skip, chat the group's feed id, t when the card was made
// (the SDK drops a click it has seen on a message for 12 hours, by its value, so a card made again has buttons of its own).
const button = (label, type, value) => ({
  tag: 'button',
  type,
  size: 'medium',
  text: { tag: 'plain_text', content: label },
  behaviors: [{ type: 'callback', value }],
});
const buttons = (list) => ({
  tag: 'column_set',
  horizontal_spacing: '8px',
  columns: list.map((b) => ({ tag: 'column', width: 'auto', elements: [b] })),
});
// The first prompt as a quotation: its own grey block.
const quote = (text) => ({
  tag: 'column_set',
  background_style: 'grey',
  horizontal_spacing: '8px',
  columns: [{ tag: 'column', width: 'weighted', weight: 1, elements: [plain(text)] }],
});
const open = (openChatId) =>
  openChatId
    ? [
        {
          tag: 'button',
          type: 'default',
          size: 'small',
          text: { tag: 'plain_text', content: '打开群' },
          behaviors: [{ type: 'open_url', default_url: groupLink(openChatId) }],
        },
      ]
    : [];

// The proposal. chat: {name, feedId, openChatId}; verdict: what the judgment kept ({reason, title, prompt}); project, agent:
// the names to show, or none when no project and agent config fit; at: when the card is made.
export function proposalCard({ chat, verdict, project, agent, at }) {
  const value = (act) => ({ act: 'newchat', do: act, chat: chat.feedId, t: at });
  const fit = project && agent;
  return card(
    `新需求群：${chat.name}`,
    'blue',
    [
      plain(verdict.reason),
      ...(fit
        ? [
            plain(`项目：${project} · Agent：${agent}`),
            quote(verdict.prompt),
            buttons([button('交给 Agent', 'primary', value('start')), button('不用', 'default', value('skip'))]),
          ]
        : [plain('没有合适的项目，需要先在 Bridge 里建'), buttons([button('不用', 'default', value('skip'))])]),
    ],
    `新需求群：${chat.name}`,
  );
}
// The card while the bot is added and the topic opened: no buttons, so that a second click cannot start it twice.
export const startingCard = ({ chat }) =>
  card(`正在交给 Agent：${chat.name}`, 'blue', [plain('正在把 Bridge 的机器人加进群、开话题……')]);
// Once it is handed to the agent: the group, and a way to open it.
export const startedCard = ({ chat, project, agent }) =>
  card(`已交给 Agent：${chat.name}`, 'green', [
    plain(`项目：${project} · Agent：${agent}`),
    ...open(chat.openChatId).map((b) => ({
      tag: 'column_set',
      columns: [{ tag: 'column', width: 'auto', elements: [b] }],
    })),
  ]);
// When it did not work: why, with 再试 (which starts again) and 不用.
export function failedCard({ chat, verdict, project, agent, reason, at }) {
  const value = (act) => ({ act: 'newchat', do: act, chat: chat.feedId, t: at });
  return card(
    `没交给 Agent：${reason}`,
    'red',
    [
      plain(`${chat.name}`, GREY),
      plain(`项目：${project} · Agent：${agent}`),
      quote(verdict.prompt),
      buttons([button('再试', 'primary', value('start')), button('不用', 'default', value('skip'))]),
    ],
    `没交给 Agent：${reason}`,
  );
}
export const ignoredCard = ({ chat }) => card('已忽略', 'grey', [plain(chat.name)]);
// The text of the topic's root message, which Bridge posts as it is in the group, where my colleagues see it: the topic
// is my agent's, about title (the model's). The topic itself, its tab and its task keep the bare title. me: my name (see
// matters.mjs me).
export const rootText = (me, title) => `${me}的 Agent：${title}`;
