import { Icon } from './Icon.jsx';

export function EmptyState({ icon, title, children }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon name={icon} /></span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
