import { useCallback, useEffect, useRef, useState } from 'react';
import { onUnauthorized, request } from './api.js';
import { Metrics } from './components/Metrics.jsx';
import { PageHeading } from './components/PageHeading.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { Toast } from './components/Toast.jsx';
import { Topbar } from './components/Topbar.jsx';
import { AppDialog } from './dialogs/AppDialog.jsx';
import { BindingDialog } from './dialogs/BindingDialog.jsx';
import { MachineDialog } from './dialogs/MachineDialog.jsx';
import { PendingChatsDialog } from './dialogs/PendingChatsDialog.jsx';
import { PermissionModeDialog } from './dialogs/PermissionModeDialog.jsx';
import { RegistrationDialog } from './dialogs/RegistrationDialog.jsx';
import { assign, clearQuery, query, reload } from './location.js';
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

  const showToast = useCallback((text) => setToast({ text, id: (sequence.current += 1) }), []);
  const hideToast = useCallback(() => setToast(null), []);
  const openDialog = useCallback((kind, props = {}) => setDialog({ kind, key: (sequence.current += 1), ...props }), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const saved = () => {
    setDialog(null);
    refresh();
  };

  useEffect(() => onUnauthorized(() => setDialog(null)), []);

  // A binding link from Feishu (/?bind=<token>) is handled once the state is loaded, after the login page if there is one,
  // so the query stays in the address until then.
  useEffect(() => {
    const token = authed && new URLSearchParams(query()).get('bind');
    if (!token) return;
    clearQuery();
    const chat = state.pendingChats.find((c) => c.token === token);
    if (chat) {
      setPage('bindings');
      openDialog('binding', { chat });
    } else showToast('绑定链接已失效，请在飞书里重新发消息');
  }, [authed, state, openDialog, showToast]);

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
  const pageActions = { platforms: openRegistration, machines: () => openDialog('machine'), bindings: () => openDialog('pending') };
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
              {page === 'machines' && <MachinesPage {...pageProps} openMachine={(machine) => openDialog('machine', { machine })} />}
              {page === 'bindings' && <BindingsPage {...pageProps} openPermissionMode={(binding) => openDialog('permission-mode', { binding })} />}
              {page === 'logs' && <LogsPage state={state} />}
            </div>
          </div>
        </main>
      </div>
      {dialog?.kind === 'machine' && <MachineDialog key={dialog.key} machine={dialog.machine} onClose={closeDialog} onSaved={saved} />}
      {dialog?.kind === 'app' && <AppDialog key={dialog.key} app={dialog.app} onClose={closeDialog} onSaved={saved} />}
      {dialog?.kind === 'pending' && (
        <PendingChatsDialog key={dialog.key} state={state} onPick={(chat) => openDialog('binding', { chat })} onClose={closeDialog} />
      )}
      {dialog?.kind === 'binding' && <BindingDialog key={dialog.key} state={state} chat={dialog.chat} onClose={closeDialog} onSaved={saved} />}
      {dialog?.kind === 'permission-mode' && (
        <PermissionModeDialog key={dialog.key} binding={dialog.binding} onClose={closeDialog} onSaved={saved} />
      )}
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
