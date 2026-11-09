import type { ConsoleProject } from '../../../console-state.ts';
import { request } from '../api.ts';
import { ActionButton } from '../components/ActionButton.tsx';
import { Badge } from '../components/Badge.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { Icon } from '../components/Icon.tsx';
import { repoName, workModes } from '../model.ts';
import type { PageProps } from './pageInfo.ts';

type Props = PageProps & { openProject: (project: ConsoleProject) => void };

// A project: the repositories, skills and topic directory that its topics work with. The machines decide where its files are, so the card
// shows none. A project that a binding uses as its default, or that has topics running, cannot be deleted; the refusal comes back as a toast.
function ProjectCard({ project: p, refresh, toast, openProject }: Omit<Props, 'state'> & { project: ConsoleProject }) {
  async function remove() {
    await request('/projects/remove', { id: p.id });
    await refresh();
  }
  return (
    <article className="card">
      <div className="card-head">
        <span className="card-icon"><Icon name="folder" /></span>
        <div className="card-title">
          <strong>{p.name}</strong>
          {p.repos.length > 0 && <p>{p.repos.map((url) => <span key={url}>{repoName(url)}</span>)}</p>}
        </div>
        <Badge tone="neutral">{workModes.find((m) => m.id === p.workMode)?.name}</Badge>
        <div className="card-actions">
          <button type="button" className="secondary" onClick={() => openProject(p)}>编辑</button>
          <ActionButton className="text-button danger" run={remove} onError={toast}>删除</ActionButton>
        </div>
      </div>
      <div className="card-detail">
        <span>{p.description}</span>
        <span className="facts">
          <span><b>{p.repos.length}</b>个仓库</span>
          <span><b>{p.skills.length}</b>个 skill</span>
        </span>
      </div>
    </article>
  );
}

export function ProjectsPage({ state, refresh, toast, openProject }: Props) {
  return (
    <section className="page">
      <div className="section-heading"><h2>项目列表</h2></div>
      <div className="stack">
        {state.projects.length
          ? state.projects.map((p) => <ProjectCard key={p.id} project={p} refresh={refresh} toast={toast} openProject={openProject} />)
          : <EmptyState icon="folder" title="暂无项目" />}
      </div>
    </section>
  );
}
