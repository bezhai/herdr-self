import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

// index.html has the <div id="root">.
createRoot(document.getElementById('root')!).render(<App />);
