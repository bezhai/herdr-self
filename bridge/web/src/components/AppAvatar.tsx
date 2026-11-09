import { avatarUrl } from '../model.ts';
import type { ConsoleApp } from '../model.ts';
import { Icon } from './Icon.tsx';

// The Feishu bot avatar of an app, or the Feishu icon while there is none. Decorative: the app name is always shown next to it.
export function AppAvatar({ app }: { app: ConsoleApp | undefined }) {
  const src = avatarUrl(app);
  return src ? <img className="avatar" src={src} alt="" /> : <Icon name="feishu" />;
}
