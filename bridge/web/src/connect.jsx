import { createRoot } from 'react-dom/client';
import { ConnectPage } from './pages/ConnectPage.jsx';
import './styles.css';

// Renders into <main id="root">; the stylesheet targets `.connect-redirect main`.
createRoot(document.getElementById('root')).render(<ConnectPage />);
