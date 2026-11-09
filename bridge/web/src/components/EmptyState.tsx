import { Icon } from './Icon.tsx';

// An empty list: an icon and a short status such as 暂无机器.
export function EmptyState({ icon, title }: { icon: string, title: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon name={icon} /></span>
      <p>{title}</p>
    </div>
  );
}
