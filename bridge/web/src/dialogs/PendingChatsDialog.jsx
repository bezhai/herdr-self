import { AppAvatar } from '../components/AppAvatar.jsx';
import { CloseButton, Dialog } from '../components/Dialog.jsx';
import { chatTypeLabel, minutesLeft } from '../model.js';

// Chats that wrote to a bot before they had a binding, each waiting until its link expires. onPick(chat) opens the binding form.
export function PendingChatsDialog({ state, onPick, onClose }) {
  const now = Date.now();
  return (
    <Dialog open onClose={onClose}>
      <div className="dialog-body">
        <div className="dialog-head"><span className="eyebrow">ROUTE</span><CloseButton onClick={onClose} /></div>
        <h2>选择要绑定的飞书聊天</h2>
        {state.pendingChats.length ? (
          <ul className="pending-chats">
            {state.pendingChats.map((chat) => {
              const app = state.apps.find((a) => a.id === chat.appId);
              return (
                <li key={chat.token}>
                  <button type="button" className="pending-chat" onClick={() => onPick(chat)}>
                    <span className="chat-avatar"><AppAvatar app={app} /></span>
                    <span className="chat-main">
                      <strong>{app?.name}</strong>
                      <code>{chat.chatId}</code>
                    </span>
                    <span className="chat-meta">
                      <small>{chatTypeLabel(chat.chatType)}</small>
                      <small>{`剩余 ${minutesLeft(chat.expiresAt, now)} 分钟`}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="dialog-note">在飞书里给机器人发一条消息（群聊需 @机器人），机器人会回复绑定链接。</p>
        )}
      </div>
    </Dialog>
  );
}
