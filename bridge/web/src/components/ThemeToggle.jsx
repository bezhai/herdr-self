import { useState } from 'react';
import { Icon } from './Icon.jsx';

// In the order the button cycles through them.
const themes = [
  { id: 'system', label: '跟随系统', icon: 'auto' },
  { id: 'light', label: '浅色', icon: 'sun' },
  { id: 'dark', label: '深色', icon: 'moon' },
];

// Cycles the console theme. Applying and storing the choice is window.bridgeTheme from public/theme.js,
// which has already applied the stored choice before first paint.
export function ThemeToggle() {
  const [current, setCurrent] = useState(() => window.bridgeTheme.current());
  const index = themes.findIndex((t) => t.id === current);
  const name = `主题：${themes[index].label}`;

  function next() {
    const { id } = themes[(index + 1) % themes.length];
    window.bridgeTheme.choose(id);
    setCurrent(id);
  }

  return (
    <button type="button" className="icon theme-toggle" aria-label={name} title={name} onClick={next}>
      <Icon name={themes[index].icon} />
    </button>
  );
}
