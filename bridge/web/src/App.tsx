import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConsoleBinding, ConsoleMachine, ConsoleProject } from '../../console-state.ts';
import type { AgentConfig } from '../../state.ts';
import { onUnauthorized, request } from './api.ts';
import { Metrics } from './components/Metrics.tsx';
import { PageHeading } from './components/PageHeading.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Toast } from './components/Toast.tsx';
import type { ToastMessage } from './components/Toast.tsx';
import { Topbar } from './components/Topbar.tsx';
import { AppDialog } from './dialogs/AppDialog.tsx';
import { AgentConfigDialog } from './dialogs/AgentConfigDialog.tsx';
import { BindingDialog } from './dialogs/BindingDialog.tsx';
import { ClientTokenDialog } from './dialogs/ClientTokenDialog.tsx';
import { MachineDialog } from './dialogs/MachineDialog.tsx';
import type { SavedMachine } from './dialogs/MachineDialog.tsx';
import { ProjectDialog } from './dialogs/ProjectDialog.tsx';
import { RegistrationDialog } from './dialogs/RegistrationDialog.tsx';
import { SkillDialog } from './dialogs/SkillDialog.tsx';
import { assign, reload } from './location.ts';
import type { ConsoleApp, SkillWithFiles } from './model.ts';
import { AgentConfigsPage } from './pages/AgentConfigsPage.tsx';
import { BindingsPage } from './pages/BindingsPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { LogsPage } from './pages/LogsPage.tsx';
import { MachinesPage } from './pages/MachinesPage.tsx';
import { pageInfo } from './pages/pageInfo.ts';
import type { Page, PageProps } from './pages/pageInfo.ts';
import { PlatformsPage } from './pages/PlatformsPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { SkillsPage } from './pages/SkillsPage.tsx';
import { useBridge } from './useBridge.ts';

// The dialogs, and the props they open with (see openDialog): the machine, app, skill, project, agent configuration or binding a dialog is
// about, or for registration the id of the registration before it. A project and an agent configuration are also created in their dialogs.
type DialogKind = 'machine' | 'client-token' | 'app' | 'skill' | 'project' | 'agent-config' | 'binding' | 'registration';
type DialogProps = {
  machine?: ConsoleMachine | SavedMachine, app?: ConsoleApp, skill?: SkillWithFiles, project?: ConsoleProject, agentConfig?: AgentConfig, binding?: ConsoleBinding, previousId?: string,
};

// Login vs. console, the current page, the one open dialog and the toast.
// dialog: null or { kind, key, ...props }; dialogs are mounted only while open, so each open starts fresh.
export function App() {
  const [page, setPage] = useState<Page>('platforms');
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<({ kind: DialogKind, key: number } & DialogProps) | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const sequence = useRef(0);
  const { state, online, authed, refresh } = useBridge({ fastPoll: dialog?.kind === 'registration' });

  const showToast = useCallback((text: string) => setToast({ text, id: (sequence.current += 1) }), []);
  const hideToast = useCallback(() => setToast(null), []);
  const openDialog = useCallback((kind: DialogKind, props: DialogProps = {}) => setDialog({ kind, key: (sequence.current += 1), ...props }), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const saved = () => {
    setDialog(null);
    refresh();
  };

  // A new machine cannot connect before its client has a token, so adding goes straight on to generating one.
  function machineSaved(machine: SavedMachine) {
    if (dialog!.machine) saved(); // !: only the open machine dialog calls this.
    else {
      openDialog('client-token', { machine });
      refresh();
    }
  }

  useEffect(() => onUnauthorized(() => setDialog(null)), []);

  function navigate(next: Page) {
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
  const pageActions: { [P in Page]?: () => void } = {
    platforms: openRegistration,
    machines: () => openDialog('machine'),
    projects: () => openDialog('project'),
    agentConfigs: () => openDialog('agent-config'),
    skills: () => openDialog('skill'),
  };
  const pageProps: PageProps = { state, refresh, toast: showToast };
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
                <MachinesPage
                  {...pageProps}
                  openMachine={(machine) => openDialog('machine', { machine })}
                  openToken={(machine) => openDialog('client-token', { machine })}
                />
              )}
              {page === 'bindings' && <BindingsPage {...pageProps} openBinding={(binding) => openDialog('binding', { binding })} />}
              {page === 'projects' && <ProjectsPage {...pageProps} openProject={(project) => openDialog('project', { project })} />}
              {page === 'agentConfigs' && <AgentConfigsPage {...pageProps} openConfig={(agentConfig) => openDialog('agent-config', { agentConfig })} />}
              {page === 'skills' && <SkillsPage {...pageProps} openSkill={(skill) => openDialog('skill', { skill })} />}
              {page === 'logs' && <LogsPage state={state} />}
            </div>
          </div>
        </main>
      </div>
      {/* !: client-token always opens with a machine. */}
      {dialog?.kind === 'machine' && <MachineDialog key={dialog.key} machine={dialog.machine} onClose={closeDialog} onSaved={machineSaved} />}
      {dialog?.kind === 'client-token' && <ClientTokenDialog key={dialog.key} machine={dialog.machine!} onClose={closeDialog} onIssued={refresh} />}
      {dialog?.kind === 'app' && <AppDialog key={dialog.key} app={dialog.app} onClose={closeDialog} onSaved={saved} />}
      {dialog?.kind === 'skill' && <SkillDialog key={dialog.key} skill={dialog.skill} onClose={closeDialog} onSaved={saved} />}
      {dialog?.kind === 'project' && <ProjectDialog key={dialog.key} project={dialog.project} skills={state.skills} onClose={closeDialog} onSaved={saved} />}
      {dialog?.kind === 'agent-config' && <AgentConfigDialog key={dialog.key} config={dialog.agentConfig} machines={state.machines} onClose={closeDialog} onSaved={saved} />}
      {/* !: binding always opens with a binding. */}
      {dialog?.kind === 'binding' && (
        <BindingDialog key={dialog.key} binding={dialog.binding!} projects={state.projects} agentConfigs={state.agentConfigs} onClose={closeDialog} onSaved={saved} />
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
