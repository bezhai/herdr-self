import { useCallback, useEffect, useRef, useState } from 'react';
import { onUnauthorized, request } from './api.js';
import { Metrics } from './components/Metrics.jsx';
import { PageHeading } from './components/PageHeading.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { Toast } from './components/Toast.jsx';
import { Topbar } from './components/Topbar.jsx';
import { AppDialog } from './dialogs/AppDialog.jsx';
import { BindingDialog } from './dialogs/BindingDialog.jsx';
import { InspectDialog } from './dialogs/InspectDialog.jsx';
import { MachineDialog } from './dialogs/MachineDialog.jsx';
import { RegistrationDialog } from './dialogs/RegistrationDialog.jsx';
import { assign, reload } from './location.js';
import { BindingsPage } from './pages/BindingsPage.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { LogsPage } from './pages/LogsPage.jsx';
import { MachinesPage } from './pages/MachinesPage.jsx';
import { pageInfo } from './pages/pageInfo.js';
import { PlatformsPage } from './pages/PlatformsPage.jsx';
import { useBridge } from './useBridge.js';

// Login vs. console, the current page, the one open dialog and the toast.
// dialog: null or { kind, key, ...props }; dialogs are mounted only while open, so each open starts fresh.
export function App() {
  const [page, setPage] = useState('platforms');
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [toast, setToast] = useState(null);
  const sequence = useRef(0);
  const { state, online, authed, refresh } = useBridge({ fastPoll: dialog?.kind === 'registration' });

  useEffect(() => onUnauthorized(() => setDialog(null)), []);

  const showToast = useCallback((text) => setToast({ text, id: (sequence.current += 1) }), []);
  const hideToast = useCallback(() => setToast(null), []);
  const openDialog = (kind, props = {}) => setDialog({ kind, key: (sequence.current += 1), ...props });
  const closeDialog = useCallback(() => setDialog(null), []);
  const saved = () => {
    setDialog(null);
    refresh();
  };

  function navigate(next) {
    setPage(next);
    setMenuOpen(false);
  }

  // Runs inside the click handler: browsers block window.open after an await or from an effect.
  function openRegistration() {
    if (!window.open('/connect', '_blank')) assign('/connect');
    openDialog('registration', { previousId: state.registration?.id });
  }

  function configureRegistered() {
    const app = state.apps.find((a) => a.id === state.registration?.appId);
    if (app && !app.enabled) openDialog('app', { app });
    else {
      setDialog(null);
      navigate('platforms');
    }
  }

  function logout() {
    request('/logout', {}).then(reload, (e) => showToast(e.message));
  }

  if (authed === null) return null;
  if (!authed) return <LoginPage onLogin={refresh} />;

  const info = pageInfo[page];
  const pageActions = { platforms: openRegistration, machines: () => openDialog('machine'), bindings: () => openDialog('binding') };
  const pageProps = { state, refresh, toast: showToast };
  return (
    <>
      <div className="shell">
        <Sidebar state={state} page={page} online={online} open={menuOpen} onNavigate={navigate} onLogout={logout} />
        <main>
          <Topbar title={info.title} onMenu={() => setMenuOpen((open) => !open)} />
          <div className="page-scroll">
            <div className="content">
              <PageHeading info={info} onAction={pageActions[page]} />
              <Metrics state={state} />
              {page === 'platforms' && <PlatformsPage {...pageProps} openApp={(app) => openDialog('app', { app })} />}
              {page === 'machines' && (
                <MachinesPage {...pageProps} openMachine={(machine) => openDialog('machine', { machine })} openInspect={(target) => openDialog('inspect', { target })} />
              )}
              {page === 'bindings' && <BindingsPage {...pageProps} />}
              {page === 'logs' && <LogsPage state={state} />}
            </div>
          </div>
        </main>
      </div>
      {dialog?.kind === 'machine' && <MachineDialog key={dialog.key} machine={dialog.machine} onClose={closeDialog} onSaved={saved} />}
      {dialog?.kind === 'app' && <AppDialog key={dialog.key} app={dialog.app} onClose={closeDialog} onSaved={saved} />}
      {dialog?.kind === 'binding' && <BindingDialog key={dialog.key} state={state} onClose={closeDialog} onSaved={saved} />}
      {dialog?.kind === 'inspect' && <InspectDialog key={dialog.key} target={dialog.target} state={state} toast={showToast} onClose={closeDialog} />}
      {dialog?.kind === 'registration' && (
        <RegistrationDialog
          key={dialog.key}
          registration={state.registration}
          apps={state.apps}
          previousId={dialog.previousId}
          onRetry={openRegistration}
          onDone={() => {
            setDialog(null);
            navigate('platforms');
          }}
          onConfigure={configureRegistered}
          onManual={() => openDialog('app')}
          onClose={closeDialog}
        />
      )}
      <Toast toast={toast} onExpire={hideToast} />
    </>
  );
}
