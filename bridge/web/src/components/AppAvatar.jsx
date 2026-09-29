import { avatarUrl } from '../model.js';
import { Icon } from './Icon.jsx';

// The Feishu bot avatar of an app, or the Feishu icon while there is none. Decorative: the app name is always shown next to it.
export function AppAvatar({ app }) {
  const src = avatarUrl(app);
  return src ? <img className="avatar" src={src} alt="" /> : <Icon name="feishu" />;
}
